import { describe, expect, it } from 'vitest';
import { DEV_DEMO_TOKEN, DEV_OPERATOR_KEY, hardenEnv, readEnv } from './config.js';

/**
 * The boot contract (R7, ADR-0009): development runs on placeholders so the dev loop needs zero
 * configuration; production refuses every one of them — and names all the violations at once,
 * because a deploy should fail with a checklist, not with a scavenger hunt.
 */

const PRODUCTION_READY = {
  RGS_ENV: 'production',
  RGS_DATABASE_URL: 'postgres://rgs:secret@db:5432/rgs',
  RGS_WALLET_URL: 'http://wallet:8789',
  RGS_OPERATOR_KEY: 'a-real-operator-key-of-substance',
} as const;

describe('the environment contract', () => {
  it('development fills every gap: zero configuration boots the dev composition', () => {
    const env = hardenEnv(readEnv({}));

    expect(env.RGS_ENV).toBe('development');
    expect(env.demoToken).toBe(DEV_DEMO_TOKEN);
    expect(env.RGS_OPERATOR_KEY).toBe(DEV_OPERATOR_KEY);
  });

  it('development honours an explicit demo token over the placeholder', () => {
    const env = hardenEnv(readEnv({ RGS_DEMO_TOKEN: 'my-own-token' }));
    expect(env.demoToken).toBe('my-own-token');
  });

  it('production refuses the dev defaults — and names every violation at once', () => {
    expect(() => hardenEnv(readEnv({ RGS_ENV: 'production' }))).toThrow(
      /RGS_DATABASE_URL[\s\S]*RGS_WALLET_URL[\s\S]*RGS_OPERATOR_KEY/,
    );
  });

  it('production refuses the placeholder demo token by value, not just by absence', () => {
    expect(() =>
      hardenEnv(readEnv({ ...PRODUCTION_READY, RGS_DEMO_TOKEN: DEV_DEMO_TOKEN })),
    ).toThrow(/RGS_DEMO_TOKEN is the public dev placeholder/);
  });

  it('production refuses a short operator key even when it is not the placeholder', () => {
    expect(() =>
      hardenEnv(readEnv({ ...PRODUCTION_READY, RGS_OPERATOR_KEY: 'short-key' })),
    ).toThrow(/at least 24 characters/);
  });

  it('production with no demo token boots with no demo session — tokens come from the operator', () => {
    const env = hardenEnv(readEnv(PRODUCTION_READY));

    expect(env.RGS_ENV).toBe('production');
    expect(env.demoToken).toBeUndefined();
  });

  it('production accepts an explicit, non-placeholder demo token', () => {
    const env = hardenEnv(readEnv({ ...PRODUCTION_READY, RGS_DEMO_TOKEN: 'operator-issued' }));
    expect(env.demoToken).toBe('operator-issued');
  });

  it('reads an empty string as absence — what a compose file delivers for an unset variable', () => {
    const env = readEnv({
      RGS_DEMO_TOKEN: '',
      RGS_DATABASE_URL: '',
      RGS_WALLET_URL: '',
      RGS_METRICS_PORT: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
    });

    expect(env.RGS_DEMO_TOKEN).toBeUndefined();
    expect(env.RGS_DATABASE_URL).toBeUndefined();
    expect(env.RGS_WALLET_URL).toBeUndefined();
    expect(env.RGS_METRICS_PORT).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });
});
