import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Proves the dependency rules actually fire.
 *
 * `pnpm lint:boundaries` scans the real packages and (correctly) finds nothing — which tells you
 * nothing about whether the rules work. These fixtures are the other half: known-illegal imports
 * that must be rejected by a named rule, and one legal import that must not be.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'config/fixtures');
const DEPCRUISE = path.join(ROOT, 'node_modules/.bin/depcruise');
const CONFIG = path.join(ROOT, '.dependency-cruiser.cjs');

interface Violation {
  rule: { name: string; severity: string };
  from: string;
  to: string;
}

function violationsFor(fixture: string): Violation[] {
  let stdout: string;
  try {
    stdout = execFileSync(DEPCRUISE, [fixture, '--config', CONFIG, '--output-type', 'json'], {
      cwd: FIXTURES,
      encoding: 'utf8',
    });
  } catch (error) {
    // dependency-cruiser exits non-zero when it finds an error-severity violation — that is the
    // case under test, and the JSON report is still on stdout.
    stdout = (error as { stdout?: string }).stdout ?? '';
    if (!stdout) throw error;
  }
  return (JSON.parse(stdout) as { summary: { violations: Violation[] } }).summary.violations;
}

describe('dependency boundaries', () => {
  it.each([
    ['packages/engine/src/illegal-pixi.ts', 'engine-is-headless'],
    ['packages/engine/src/illegal-renderer.ts', 'engine-deps'],
    ['packages/engine/src/illegal-deep-import.ts', 'no-cross-package-deep-imports'],
    ['apps/mock-rgs/src/illegal-transport.ts', 'mock-rgs-deps'],
    ['apps/mock-rgs/src/illegal-deep-import.ts', 'apps-import-entry-points-only'],
    ['apps/rgs/src/illegal-sim.ts', 'rgs-deps'],
    ['packages/platform/src/illegal-engine.ts', 'platform-deps'],
    ['packages/compliance/src/illegal-engine.ts', 'compliance-deps'],
    ['packages/compliance/src/illegal-pixi.ts', 'pixi-stays-in-renderer-and-ui'],
    ['packages/dev-tools/src/illegal-pixi.ts', 'pixi-stays-in-renderer-and-ui'],
  ])('rejects %s — %s', (fixture, expectedRule) => {
    const names = violationsFor(fixture).map((violation) => violation.rule.name);
    expect(names).toContain(expectedRule);
  });

  it('accepts the engine importing protocol and money', () => {
    expect(violationsFor('packages/engine/src/legal.ts')).toEqual([]);
  });

  it('accepts the HTTP wrapper importing the contract and the simulator', () => {
    expect(violationsFor('apps/mock-rgs/src/legal.ts')).toEqual([]);
  });

  it('accepts the real RGS importing the contract, the money and the math', () => {
    expect(violationsFor('apps/rgs/src/legal.ts')).toEqual([]);
  });

  it('accepts dev-tools importing the engine and money through their entry points', () => {
    expect(violationsFor('packages/dev-tools/src/legal.ts')).toEqual([]);
  });
});
