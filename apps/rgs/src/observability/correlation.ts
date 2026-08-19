import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { CORRELATION_HEADER } from '@slot/protocol';

/**
 * The correlation id, end to end — R0's whole observability story, and the hook R6 hangs the rest
 * on (structured logs and OTel spans keyed on `roundId` join *this* id, minted here or adopted
 * from the client).
 *
 * The client mints one per request and we adopt it; a request that arrives without one gets a
 * uuid. Either way `request.id` is what the log lines, the echoed header and the error bodies all
 * carry — one id, three places, no scheme for the other side to guess.
 */

export const correlationOptions = {
  requestIdHeader: CORRELATION_HEADER,
  genReqId: (): string => randomUUID(),
};

export const echoCorrelation = (app: FastifyInstance): void => {
  app.addHook('onSend', (request, reply, _payload, done) => {
    reply.header(CORRELATION_HEADER, request.id);
    done();
  });
};
