#!/usr/bin/env node
/**
 * Verify the production bundle contains no dev tooling.
 *
 * "Dev-only code is compile-stripped" is a rule (CLAUDE.md), and a rule nobody has watched fail is
 * a rule being trusted rather than enforced — the same argument as the boundary fixtures. This
 * script makes the strip a checked fact: it takes strings the dev surface cannot exist without,
 * proves each still exists at its source (so a rename cannot turn the check into a green no-op),
 * and then asserts none of them appear anywhere in the built output.
 *
 * Runs from `pnpm check`, immediately after the build that produces `dist/`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(here, '..');
const repoRoot = join(clientRoot, '..', '..');
const dist = join(clientRoot, 'dist');

/**
 * Each marker names a piece of the dev surface, and `provenance` is the source file that must
 * still contain it — the positive control. A marker that vanished from its source would otherwise
 * pass the absence check forever, silently checking nothing.
 */
const MARKERS = [
  { marker: 'devtools-section', provenance: 'packages/dev-tools/src/panel.ts' },
  { marker: 'FORCE OUTCOME', provenance: 'packages/dev-tools/src/panel.ts' },
  { marker: 'slot-event-log.json', provenance: 'packages/dev-tools/src/panel.ts' },
  { marker: '__slot', provenance: 'apps/game-client/src/game.ts' },
  { marker: 'DEV TOOLS', provenance: 'apps/game-client/src/game.ts' },
];

const fail = (message) => {
  console.error(`verify:strip — ${message}`);
  process.exit(1);
};

if (!existsSync(dist)) {
  fail(`no build at ${dist} — run the build first (pnpm build)`);
}

for (const { marker, provenance } of MARKERS) {
  const source = readFileSync(join(repoRoot, provenance), 'utf8');
  if (!source.includes(marker)) {
    fail(
      `positive control failed: "${marker}" is no longer in ${provenance} — ` +
        `the marker list is stale and the check would pass vacuously. Update MARKERS.`,
    );
  }
}

/** Every file the built page can load: the JS chunks and the HTML that loads them. */
const files = [];
const collect = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (/\.(js|mjs|html|css)$/.test(entry.name)) files.push(path);
  }
};
collect(dist);

if (files.length === 0) fail(`the build at ${dist} contains no js/html files to check`);

const leaks = [];
for (const file of files) {
  const content = readFileSync(file, 'utf8');
  for (const { marker } of MARKERS) {
    if (content.includes(marker)) leaks.push({ file, marker });
  }
}

if (leaks.length > 0) {
  for (const { file, marker } of leaks) {
    console.error(`verify:strip — "${marker}" shipped in ${file}`);
  }
  fail('the production bundle contains dev tooling — the __DEV_TOOLS__ strip is broken');
}

console.log(
  `verify:strip — ${String(MARKERS.length)} markers absent from ${String(files.length)} built files: the production bundle carries no dev tooling`,
);
