/**
 * The dependency table in CLAUDE.md, enforced.
 *
 * Two spellings have to match for every workspace package, because a package that has not been
 * built yet cannot be resolved to a file: `packages/<name>/…` (resolved) and `@slot/<name>`
 * (unresolved). `only()` covers both.
 */

/** Everything in the workspace — the set a package is *not* allowed to reach into by default. */
const WORKSPACE = '^(packages/[^/]+/|@slot/[^/]+$)';

/** Matches only the named workspace packages, in either spelling. */
const only = (...names) => `^(packages/(${names.join('|')})/|@slot/(${names.join('|')})$)`;

/** Pixi, the DOM-side libraries, and Node I/O — banned from the pure packages. */
const BROWSER_OR_IO = '^(pixi\\.js|@pixi/|howler|fs|node:fs|node:fs/|fs/promises)';

/**
 * `from` a package, `to` anywhere in the workspace that is not on its allow-list.
 *
 * A package is always allowed to reach its own modules — the rule is about what it may reach
 * *across* a boundary, and `no-cross-package-deep-imports` is what keeps that reach at the entry
 * point.
 */
const mayOnlyDependOn = (name, ...allowed) => ({
  name: `${name}-deps`,
  comment: `@slot/${name} may only depend on: ${allowed.map((a) => `@slot/${a}`).join(', ') || '(nothing)'} — see the dependency table in CLAUDE.md.`,
  severity: 'error',
  from: { path: `^packages/${name}/src/` },
  to: { path: WORKSPACE, pathNot: only(name, ...allowed) },
});

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'A cycle between packages means the boundary is not real.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'engine-is-headless',
      comment:
        'packages/engine must stay unit-testable without a canvas: no Pixi, no DOM libraries, no renderer/ui. This rule failing IS the architecture (CLAUDE.md).',
      severity: 'error',
      from: { path: '^packages/engine/src/' },
      to: { path: BROWSER_OR_IO },
    },
    {
      name: 'rgs-sim-is-headless',
      comment:
        'packages/rgs-sim runs in a browser, in Node and in the 50M-spin math tool — it can afford none of these.',
      severity: 'error',
      from: { path: '^packages/rgs-sim/src/' },
      to: { path: BROWSER_OR_IO },
    },
    {
      name: 'pure-packages-do-no-io',
      comment:
        'engine, rgs-sim, game-math and money are pure: no fs, no Pixi, no browser globals. I/O lives behind ports (RgsTransport, platform).',
      severity: 'error',
      from: { path: '^packages/(engine|rgs-sim|game-math|money)/src/' },
      to: { path: BROWSER_OR_IO },
    },
    {
      name: 'no-cross-package-deep-imports',
      comment:
        'Import another package through its entry point, never into its src/. A package with a real public surface is a package with a real boundary. (Reaching your own modules is fine — `$1` scopes this to imports that actually cross a boundary.)',
      severity: 'error',
      from: { path: '^packages/([^/]+)/' },
      to: { path: '^packages/[^/]+/src/', pathNot: '^packages/$1/' },
    },
    mayOnlyDependOn('protocol'),
    mayOnlyDependOn('money', 'protocol'),
    mayOnlyDependOn('game-math', 'protocol', 'money'),
    mayOnlyDependOn('engine', 'protocol', 'money', 'game-math'),
    mayOnlyDependOn('rgs-sim', 'protocol', 'money', 'game-math'),
    mayOnlyDependOn('transport', 'protocol'),
    mayOnlyDependOn('renderer', 'protocol', 'engine', 'money'),
    mayOnlyDependOn('ui', 'protocol', 'money'),
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|node_modules|\\.turbo)(/|$)' },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
