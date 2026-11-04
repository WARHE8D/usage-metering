# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Usage Metering Pipeline

## Architecture
HTTP API (Fastify) -> validate (zod) -> BullMQ queue on Redis (+ dead-letter queue)
-> worker -> PostgreSQL (idempotent INSERT ... ON CONFLICT DO NOTHING)
-> publish "usage.recorded" (Redis pub/sub) -> subscriber.
GET /usage serves the React page. Local infra via docker-compose (Postgres + Redis).

## Layout
- shared/  zod schemas + types (used by api, worker, web)
- api/     Fastify server (POST /usage, GET /usage, GET /health)
- worker/  queue consumer + event subscriber
- web/     Vite + React + TypeScript
- db/      SQL migrations
- docker-compose.yml

## Rules
- TypeScript strict. No `any`.
- Business logic = pure functions with injected dependencies (db, queue, publisher),
  so it can be wrapped as a serverless function later.
- Idempotency lives in Postgres (primary key on record_id), never in memory.
- Worker: retries with exponential backoff, then move the job to the dead-letter queue.
- Parameterized SQL only. Validate every input with zod. Config from env vars.
- Every change ships with tests. Run `npm test` and `npm run build` before saying done.
- Small commits, Conventional Commits (feat:, fix:, test:, chore:, docs:).
- Never delete volumes or run destructive docker/git commands unless I ask.
- Before installing, upgrading or writing code against a package, look up its current,
  version-specific docs with the Context7 MCP server instead of relying on memory.

## Commands
npm workspaces monorepo (Node >= 22, ESM). Shared is imported as `@usage-metering/shared`;
its `development` export condition points at src, so dev/test need no prior build.
- npm install               install all workspaces
- npm run dev:api | dev:worker | dev:web   (tsx watch / vite)
- npm test                  unit tests (Vitest projects unit-node + unit-web; *.test.ts[x])
- npm run test:int          integration tests (*.int.test.ts; needs docker compose up)
- npm run build             tsc -b (project refs) then vite build for web
- npm run lint | format | format:check   ESLint (type-aware) / Prettier
- docker compose up -d      start Postgres + Redis (planned — docker-compose.yml not yet added)

Toolchain pins: TypeScript ~6.0 (typescript-eslint requires < 6.1). eslint-plugin-react is
not used because it does not support ESLint 10 yet; react-hooks rules apply to web/ only.
