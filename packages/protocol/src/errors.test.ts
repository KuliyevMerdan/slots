import { describe, expect, it } from 'vitest';
import {
  CLASS_OF_CODE,
  ERROR_CLASSES,
  ERROR_CODES,
  ProtocolErrorSchema,
  SlotError,
  classOf,
  isSlotError,
} from './errors.js';

describe('the error taxonomy', () => {
  it('classifies every code', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_CLASSES).toContain(classOf(code));
    }
  });

  it('has a producer for all three classes — an unused class is an untested client path', () => {
    const classes = new Set(Object.values(CLASS_OF_CODE));
    expect([...classes].sort()).toEqual([...ERROR_CLASSES].sort());
  });

  it('only marks RECOVERABLE errors retryable', () => {
    for (const code of ERROR_CODES) {
      const error = new SlotError(code, 'boom');
      expect(error.isRetryable).toBe(classOf(code) === 'RECOVERABLE');
    }
  });
});

describe('SlotError', () => {
  it('round-trips a wire payload', () => {
    const payload = ProtocolErrorSchema.parse({
      class: 'PLAYER',
      code: 'INSUFFICIENT_FUNDS',
      message: 'not enough funds',
      correlationId: 'cid-1',
    });

    const error = SlotError.fromPayload(payload);

    expect(isSlotError(error)).toBe(true);
    expect(error.code).toBe('INSUFFICIENT_FUNDS');
    expect(error.errorClass).toBe('PLAYER');
    expect(error.correlationId).toBe('cid-1');
    expect(error.isRetryable).toBe(false);
  });

  it('derives the class from the code rather than trusting the payload', () => {
    // A server that sends a mismatched class does not get to change what the client does.
    const error = SlotError.fromPayload({
      class: 'RECOVERABLE',
      code: 'INSUFFICIENT_FUNDS',
      message: 'lying about the class',
      correlationId: 'cid-2',
    });

    expect(error.errorClass).toBe('PLAYER');
    expect(error.isRetryable).toBe(false);
  });

  it('rejects an unknown code at the boundary', () => {
    const result = ProtocolErrorSchema.safeParse({
      class: 'FATAL',
      code: 'SOMETHING_NEW',
      message: 'from a newer server',
      correlationId: 'cid-3',
    });

    expect(result.success).toBe(false);
  });
});
