import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { RgsMetrics } from '../observability/metrics.js';

/**
 * The operational listener (R7): `GET /metrics` on its own port, away from the game routes.
 *
 * A scrape endpoint is infrastructure surface, not player surface — an operator's perimeter
 * treats the two differently, and a deploy that can only expose both together ends up publishing
 * its latency histograms to the internet. When `RGS_METRICS_PORT` is set, `main.ts` builds this
 * app, the game listener stops serving `/metrics`, and the scraper gets a port the load balancer
 * never routes players to. `/health` is here too, because the ops listener needs its own
 * liveness answer — a scraper that cannot reach this port should be able to say *which* listener
 * died.
 */
export interface OpsAppOptions {
  metrics: RgsMetrics;
  loggerInstance?: FastifyServerOptions['loggerInstance'];
}

export function buildOpsApp({ metrics, loggerInstance }: OpsAppOptions): FastifyInstance {
  const app = Fastify(loggerInstance === undefined ? { logger: false } : { loggerInstance });

  app.get('/health', () => ({ status: 'ok' }));

  app.get('/metrics', async (_request, reply) => {
    const text = await metrics.registry.render();
    return reply.type('text/plain; version=0.0.4').send(text);
  });

  return app;
}
