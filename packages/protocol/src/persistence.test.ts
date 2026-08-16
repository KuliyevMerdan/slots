import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PERSISTENCE_SCHEMA_VERSION, persist, readPersisted } from './persistence.js';

const StateSchema = z.object({ roundId: z.string(), step: z.int() });

const write = (value: unknown): string => JSON.stringify(value);

describe('persisted state', () => {
  it('round-trips a current envelope', () => {
    const raw = write(persist({ roundId: 'r-1', step: 3 }, 1_700_000_000_000));

    expect(readPersisted(raw, StateSchema)).toEqual({ roundId: 'r-1', step: 3 });
  });

  it('discards a payload written by an older schema', () => {
    const raw = write({
      v: PERSISTENCE_SCHEMA_VERSION - 1,
      savedAt: 1_700_000_000_000,
      data: { roundId: 'r-1', step: 3 },
    });

    expect(readPersisted(raw, StateSchema)).toBeNull();
  });

  it.each([
    ['corrupt JSON', '{not json'],
    ['an envelope with no version', write({ savedAt: 1, data: { roundId: 'r-1', step: 3 } })],
    ['drifted payload shape', write(persist({ roundId: 'r-1' }, 1))],
    ['nothing at all', null],
    ['an empty string', ''],
  ])('discards %s rather than repairing it', (_label, raw) => {
    expect(readPersisted(raw, StateSchema)).toBeNull();
  });
});
