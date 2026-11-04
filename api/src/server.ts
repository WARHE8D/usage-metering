import cors from '@fastify/cors';

import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { ApiKeyChecker } from './auth.js';
import type { ApiConfig } from './config.js';
import type { HealthCheck } from './health.js';
import type { IngestUsage } from './ingest.js';

export interface ServerDeps {
  ingest: IngestUsage;
  checkApiKey: ApiKeyChecker;
  health: HealthCheck;
  config: Pick<ApiConfig, 'bodyLimitBytes' | 'corsOrigins'>;
  logger?: FastifyServerOptions['logger'];
}

export const RETRY_AFTER_SECONDS = 5;

const ERROR_NAMES: Record<number, string> = {
  400: 'bad_request',
  404: 'not_found',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
};

/** 4xx status carried by Fastify's own errors (bad JSON, too large, bad media type); else undefined. */
function clientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const { statusCode } = error;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
    ? statusCode
    : undefined;
}

/** Builds the HTTP app. No env reads and no network I/O: everything is injected. */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ bodyLimit: deps.config.bodyLimitBytes, logger: deps.logger ?? false });

  // Only JSON is accepted; without this, text/plain bodies would be parsed as strings.
  app.removeContentTypeParser('text/plain');

  // Registered on the root instance (@fastify/cors is wrapped in fastify-plugin), so its
  // onRequest hook runs before the API-key hook in the /usage scope. Hence (a) preflight
  // OPTIONS is answered by cors itself and never reaches the key check, and (b) allowed
  // origins get CORS headers on 401/400/503 too. Exact allowlist: no wildcard, no reflection.
  void app.register(cors, {
    origin: deps.config.corsOrigins,
    methods: ['GET', 'POST'],
    allowedHeaders: ['content-type', 'x-api-key'],
    credentials: false,
  });

  app.setErrorHandler((error, request, reply) => {
    const status = clientErrorStatus(error);
    if (status === undefined) {
      request.log.error({ err: error }, 'unhandled error');
      return reply.code(500).send({ error: 'internal_error', message: 'Internal Server Error' });
    }
    const message = error instanceof Error ? error.message : 'Bad Request';
    return reply.code(status).send({ error: ERROR_NAMES[status] ?? 'request_error', message });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: 'not_found',
      message: `Route ${request.method} ${request.url} not found`,
    }),
  );

  // Public: readiness probe.
  app.get('/health', async (_request, reply) => {
    const health = await deps.health();
    return reply
      .code(health.ok ? 200 : 503)
      .send({ status: health.ok ? 'ok' : 'degraded', redis: health.redis });
  });

  // Everything registered in this scope requires x-api-key. The check runs in
  // onRequest, before the body is parsed, so unauthenticated callers learn nothing.
  void app.register((scope, _opts, done) => {
    scope.addHook('onRequest', async (request, reply) => {
      if (!deps.checkApiKey(request.headers['x-api-key'])) {
        return reply
          .code(401)
          .header('www-authenticate', 'ApiKey')
          .send({ error: 'unauthorized', message: 'Missing or invalid API key' });
      }
      return undefined;
    });

    scope.post('/usage', async (request, reply) => {
      const result = await deps.ingest(request.body);
      switch (result.status) {
        case 'accepted':
          return reply.code(202).send({ status: 'accepted', recordId: result.recordId });
        case 'invalid':
          return reply.code(400).send({ error: 'validation_failed', errors: result.errors });
        case 'unavailable':
          request.log.error({ err: result.cause }, 'enqueue failed');
          return reply
            .code(503)
            .header('retry-after', String(RETRY_AFTER_SECONDS))
            .send({ error: 'queue_unavailable', message: 'Queue unavailable, retry later' });
      }
    });

    done();
  });

  return app;
}
