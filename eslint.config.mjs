// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * The determinism and purity rules from CLAUDE.md, as lint rules.
 *
 * `engine`, `rgs-sim`, `game-math` and `money` replay identically from a seed — which is what makes
 * the simulator, the math tool and the E2E suite trustworthy. Ambient randomness or wall-clock time
 * anywhere in them silently destroys that, and it is the kind of thing code review misses.
 *
 * `compliance` is on the list from before it has code (2026-08-19): a reality-check timer or a
 * session limit is a pure function of an injected clock, or it is untestable.
 */
const PURE_PACKAGES = ['engine', 'rgs-sim', 'game-math', 'money', 'compliance'];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      'config/fixtures/**', // deliberately illegal — see config/fixtures/README.md
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // Maintenance scripts run in Node, outside the browser and outside the type-checked source.
    files: ['**/scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  {
    // Tooling config that has to stay CommonJS (dependency-cruiser loads it with `require`).
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // `**/` so the rule set also applies to config/fixtures/packages/… — the fixtures that prove
    // these rules fire (tests/purity.test.ts).
    files: [`**/packages/{${PURE_PACKAGES.join(',')}}/**/*.ts`],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            'Seeded PRNG only. Math.random() cannot be replayed, and replay is what makes the sim, the math tool and the E2E suite trustworthy.',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            'Take a clock as a parameter. Ambient time makes tests flaky and replay impossible.',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'Take a clock as a parameter. Ambient time makes tests flaky and replay impossible.',
        },
        {
          selector: "CallExpression[callee.name='fetch']",
          message: 'No I/O in a pure package — it belongs behind a port (RgsTransport, platform).',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'This package must run headless — no DOM.' },
        { name: 'document', message: 'This package must run headless — no DOM.' },
        { name: 'localStorage', message: 'Storage belongs behind the persistence port.' },
      ],
    },
  },
);
