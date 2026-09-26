import { describe, expect, it } from 'vitest';
import { readEnv } from './config.js';

/**
 * The environment is the deploy surface: a hosting platform decides the port, a developer's `.env`
 * decides everything else, and neither may silently override the other.
 */
describe('readEnv', () => {
  it('defaults to 8787 when nothing names a port', () => {
    expect(readEnv({}).MOCK_RGS_PORT).toBe(8787);
  });

  it("obeys the platform's PORT when MOCK_RGS_PORT is unset — the Render / Cloud Run shape", () => {
    expect(readEnv({ PORT: '10000' }).MOCK_RGS_PORT).toBe(10_000);
  });

  it('lets an explicit MOCK_RGS_PORT win over an ambient PORT', () => {
    expect(readEnv({ PORT: '10000', MOCK_RGS_PORT: '9000' }).MOCK_RGS_PORT).toBe(9000);
  });

  it('refuses a platform port that is not a port, naming the variable it reads', () => {
    expect(() => readEnv({ PORT: 'eighty' })).toThrow(/MOCK_RGS_PORT/);
  });
});
