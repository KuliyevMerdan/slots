import { startGame } from './game.js';
import { consoleTelemetry, guarded } from './telemetry.js';

/**
 * The entry point, and the only file that touches the DOM outside the canvas.
 *
 * Its whole job is the window before the game exists: hold a loading state while the session is
 * established and the atlas is built, then get out of the way — or, if the boot failed, say so in
 * words a player could read instead of leaving a black rectangle.
 */

const root = document.getElementById('game');
const boot = document.getElementById('boot');
const status = document.getElementById('boot-status');
const failure = document.getElementById('boot-error');

const say = (message: string): void => {
  if (status !== null) status.textContent = message;
};

async function main(): Promise<void> {
  if (root === null) throw new Error('the page has no #game element to render into');

  say('Connecting');
  await startGame(root);

  boot?.classList.add('done');
  // Removed only after the fade, so the canvas is not revealed through a half-transparent overlay.
  window.setTimeout(() => boot?.setAttribute('hidden', ''), 260);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  say('Could not start');
  if (failure !== null) failure.textContent = message;

  // The outermost net. `startGame` reports the failures it can name; this one catches everything
  // else — a missing `#game` element, a WebGL context the device refused, an atlas that would not
  // build — none of which the player can act on and all of which somebody needs to see.
  guarded(consoleTelemetry()).report({
    name: 'boot_crashed',
    level: 'ERROR',
    message,
    detail: { error: String(error) },
  });
});
