import { z } from 'zod';

/**
 * The environment, validated like anything else that crosses a boundary — the same discipline as
 * `apps/mock-rgs`, with less to validate: no seed (R4 owns randomness), no balance (the wallet
 * does), no dev mode (this server never honours `forceOutcome`, and there is no flag to mis-set).
 * Postgres and Redis URLs join this schema in R1, as placeholders resolved from the environment —
 * never as committed defaults (see "Environment & build flags" in CLAUDE.md).
 */

const EnvSchema = z.object({
  RGS_PORT: z.coerce.number().int().min(0).max(65_535).default(8788),
  RGS_HOST: z.string().min(1).default('127.0.0.1'),
  RGS_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type RgsEnv = z.infer<typeof EnvSchema>;

export const readEnv = (env: NodeJS.ProcessEnv = process.env): RgsEnv => {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid environment for @slot/rgs — ${detail}`);
  }
  return parsed.data;
};
