# Rule fixtures

These files are **deliberately illegal**. They exist so that [`tests/`](../../tests) can prove the
project's structural rules actually fire — a rule nobody has seen fail is a rule you are trusting,
not enforcing.

| Fixture | Proves | Enforced by |
| --- | --- | --- |
| `packages/engine/illegal-pixi.ts` | the engine cannot import Pixi | [`.dependency-cruiser.cjs`](../../.dependency-cruiser.cjs) |
| `packages/engine/illegal-renderer.ts` | the engine cannot reach into the renderer | `.dependency-cruiser.cjs` |
| `packages/engine/illegal-deep-import.ts` | no package may import into another's `src/` | `.dependency-cruiser.cjs` |
| `packages/engine/legal.ts` | the allowed imports are *not* flagged | `.dependency-cruiser.cjs` |
| `packages/engine/impure.ts` | pure packages cannot use ambient randomness, time or I/O | [`eslint.config.mjs`](../../eslint.config.mjs) |

They are excluded from TypeScript, ESLint and Prettier in normal runs, and `pnpm lint:boundaries`
only scans `packages/`. Nothing here is compiled or shipped.

The paths mirror the real workspace (`packages/<name>/…`) because both rule sets match on path.
