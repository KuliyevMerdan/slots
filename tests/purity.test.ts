import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Proves the determinism rules fire.
 *
 * `engine`, `rgs-sim`, `game-math` and `money` replay identically from a seed. Ambient randomness or
 * wall-clock time anywhere in them destroys that quietly — the tests still pass, they just stop
 * meaning anything. So the rule that forbids it is itself tested.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ESLINT = path.join(ROOT, 'node_modules/.bin/eslint');

/**
 * One impure fixture per package that joined PURE_PACKAGES by decision rather than by the original
 * list — `compliance` is constrained before it has code, and this is what proves the constraint is
 * wired rather than intended.
 */
const FIXTURES = [
  'config/fixtures/packages/engine/src/impure.ts',
  'config/fixtures/packages/compliance/src/impure.ts',
];

interface LintMessage {
  ruleId: string | null;
  message: string;
  line: number;
}

function lint(file: string): LintMessage[] {
  let stdout: string;
  try {
    stdout = execFileSync(ESLINT, ['--no-ignore', '--format', 'json', file], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch (error) {
    // ESLint exits non-zero when it reports an error — which is the case under test.
    stdout = (error as { stdout?: string }).stdout ?? '';
    if (!stdout) throw error;
  }
  return (JSON.parse(stdout) as Array<{ messages: LintMessage[] }>).flatMap((r) => r.messages);
}

describe.each(FIXTURES)('purity rules, proven against %s', (fixture) => {
  const messages = lint(fixture);

  it.each([
    ['Math.random()', /Seeded PRNG only/],
    ['Date.now()', /Take a clock as a parameter/],
    ['new Date()', /Take a clock as a parameter/],
  ])('rejects %s', (_label, expected) => {
    expect(
      messages.filter((m) => m.ruleId === 'no-restricted-syntax').map((m) => m.message),
    ).toEqual(expect.arrayContaining([expect.stringMatching(expected)]));
  });

  it('reports one violation per offending line', () => {
    expect(messages.filter((m) => m.ruleId === 'no-restricted-syntax')).toHaveLength(3);
  });
});
