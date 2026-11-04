import type { EventPublisher } from './ports.js';

/** The publish capability the publisher needs; an ioredis client satisfies it. */
export interface PublishClient {
  publish(channel: string, message: string): Promise<number>;
}

/** Publishes events as JSON on a Redis pub/sub channel (fire-and-forget delivery). */
export function createRedisEventPublisher(client: PublishClient, channel: string): EventPublisher {
  return {
    async publish(event) {
      await client.publish(channel, JSON.stringify(event));
    },
  };
}
