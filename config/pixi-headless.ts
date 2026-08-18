/**
 * The smallest browser a Pixi scene graph needs to exist in.
 *
 * `@slot/renderer` and `@slot/ui` are Pixi packages, so their tests cannot pretend the browser does
 * not exist — but almost none of what they test needs one. Containers, sprites, graphics and the
 * spin curve are ordinary objects until something asks them to *draw*, and nothing here draws: the
 * atlas is faked and no renderer is ever created.
 *
 * So instead of a full DOM implementation as a dependency, this stubs the two globals Pixi reads at
 * import time. If a test ever needs more than this, that test wants a real browser — and it belongs
 * in the Playwright suite (C8), not in Vitest.
 */

const globals = globalThis as unknown as Record<string, unknown>;

globals['navigator'] ??= { userAgent: 'node', platform: 'node', maxTouchPoints: 0 };
globals['self'] ??= globalThis;
