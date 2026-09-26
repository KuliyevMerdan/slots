import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * Spin, win, feature, reload-and-resume — ROADMAP's four words, driven like a player.
 *
 * The tests press the DOM control panel's real buttons by keyboard (the same `PanelView` the
 * canvas renders, so an Enter on the focused button is indistinguishable from a finger by the
 * time it reaches the engine) and assert against two authorities: the engine's own state through
 * the demo build's `window.__slot` handle, and the server's account through `/dev/state`.
 * Nothing here reads pixels — the canvas is renderer-test territory; what E2E owes is the
 * composition: page → transport → wire → sim and back, with the money agreeing at every rest.
 *
 * Forced outcomes are the determinism. `force()` arms the client's one-shot `forceOutcome` for
 * the next spin — the named scenarios are found on the real strips server-side, so a re-tune
 * cannot rot these tests — and everything the force did not pin (the free spins inside a feature)
 * is asserted by invariants rather than by values: settled exactly once, balance = opening −
 * stake + the round's own payable win.
 */

/** What the demo build hangs on `window` (`game.ts`, behind `__DEV_TOOLS__`). */
interface SlotHandle {
  engine: { state: { phase: string } & Record<string, unknown> };
  force: (outcome: string) => void;
}

declare global {
  interface Window {
    __slot: SlotHandle;
  }
}

/** The server's own summary of the session — the shape `/dev/state` answers. */
interface DevState {
  balance: number;
  rounds: Array<{
    roundId: string;
    state: string;
    stake: number;
    cumulativeWin: number;
    steps: number;
  }>;
}

const START_BALANCE = 1_000_000;

/**
 * The page's own demo session — the token the client remembered in `sessionStorage` (the key is
 * `DEMO_SESSION_KEY` in the client's `transport.ts`). The server gives every visitor their own
 * simulator, so reading `/dev/state` without naming the session would read somebody else's.
 */
const sessionTokenOf = async (page: Page): Promise<string> => {
  const token = await page.evaluate(() => sessionStorage.getItem('slot.demo.session'));
  if (token === null) throw new Error('the page holds no demo session');
  return token;
};

const serverState = async (request: APIRequestContext, page: Page): Promise<DevState> =>
  (await (
    await request.get('/dev/state', {
      headers: { authorization: `Bearer ${await sessionTokenOf(page)}` },
    })
  ).json()) as DevState;

const phaseIs = (page: Page, wanted: string, timeout: number) =>
  page.waitForFunction((p) => window.__slot?.engine.state.phase === p, wanted, { timeout });

const phaseIsNot = (page: Page, unwanted: string, timeout: number) =>
  page.waitForFunction(
    (p) => window.__slot !== undefined && window.__slot.engine.state.phase !== p,
    unwanted,
    { timeout },
  );

const readNumber = (page: Page, field: string): Promise<number> =>
  page.evaluate((f) => {
    const state = window.__slot.engine.state;
    const value = state[f];
    if (typeof value !== 'number') throw new Error(`engine state has no numeric ${f}`);
    return value;
  }, field);

const force = (page: Page, scenario: string): Promise<void> =>
  page.evaluate((s) => {
    window.__slot.force(s);
  }, scenario);

/** Open the game fresh and wait for the table: authenticated, idle, ready to be pressed. */
const openIdle = async (page: Page): Promise<void> => {
  await page.goto('/');
  await phaseIs(page, 'IDLE', 30_000);
};

/**
 * Press SPIN the way the DOM panel is meant to be pressed: by keyboard. The panel keeps
 * `pointer-events` off on purpose — mouse players use the canvas and never discover an invisible
 * button — so a Playwright *click* is intercepted by design, and Enter on the focused button is
 * the modality this control surface exists for.
 */
const pressSpin = (page: Page): Promise<void> =>
  page.getByRole('button', { name: 'SPIN' }).press('Enter');

test('a spin debits the stake, lands, and settles with the server and client agreeing', async ({
  page,
  request,
}) => {
  await openIdle(page);
  const stake = await readNumber(page, 'stake');

  // DEAD_SPIN: no win, no feature — the round that settles atomically on the spin response.
  await force(page, 'DEAD_SPIN');
  await pressSpin(page);

  await phaseIsNot(page, 'IDLE', 10_000);
  await phaseIs(page, 'IDLE', 60_000);

  const balance = await readNumber(page, 'balance');
  expect(balance).toBe(START_BALANCE - stake);

  const server = await serverState(request, page);
  expect(server.balance).toBe(balance);
  expect(server.rounds).toHaveLength(1);
  expect(server.rounds[0]).toMatchObject({ state: 'SETTLED', stake, cumulativeWin: 0, steps: 0 });
});

test('a forced feature pays through the win presentation and is credited exactly once', async ({
  page,
  request,
}) => {
  await openIdle(page);
  const stake = await readNumber(page, 'stake');

  await force(page, 'FREE_SPINS_TRIGGER');
  await pressSpin(page);

  // The whole arc plays unattended — the trigger's scatter win, the intro, every free spin, the
  // outro, the settle — because timelines complete themselves; IDLE is the round come home.
  await phaseIsNot(page, 'IDLE', 10_000);
  await phaseIs(page, 'IDLE', 170_000);

  const balance = await readNumber(page, 'balance');
  const server = await serverState(request, page);
  expect(server.balance).toBe(balance);
  expect(server.rounds).toHaveLength(1);

  const round = server.rounds[0];
  if (round === undefined) throw new Error('the round is gone');
  expect(round.state).toBe('SETTLED');
  // The scenario is found on the real strips, so the exact figures move with a re-tune — the
  // invariants do not: the feature really ran, the trigger's scatters really paid, and the
  // credit arrived exactly once.
  expect(round.steps).toBeGreaterThan(0);
  expect(round.cumulativeWin).toBeGreaterThan(0);
  expect(server.balance).toBe(START_BALANCE - stake + round.cumulativeWin);
});

test('a reload mid-feature resumes the round and finishes it, credited exactly once', async ({
  page,
  request,
}) => {
  await openIdle(page);
  const stake = await readNumber(page, 'stake');

  await force(page, 'FREE_SPINS_TRIGGER');
  await pressSpin(page);

  // Deep enough to mean something: at least one free spin has been *played and answered*, so the
  // resume must land mid-feature rather than replaying the trigger.
  await page.waitForFunction(
    () => window.__slot !== undefined && window.__slot.engine.state.phase.startsWith('FEATURE'),
    undefined,
    { timeout: 60_000 },
  );
  await expect
    .poll(async () => (await serverState(request, page)).rounds[0]?.steps ?? 0, { timeout: 60_000 })
    .toBeGreaterThan(0);

  // The throwaway: no goodbye, no persistence handshake — the page is simply gone, and the next
  // load learns everything from `authenticate`'s `pendingRound` (§5).
  await page.reload();

  await phaseIs(page, 'IDLE', 170_000);

  const balance = await readNumber(page, 'balance');
  const server = await serverState(request, page);
  expect(server.balance).toBe(balance);
  expect(server.rounds).toHaveLength(1);

  const round = server.rounds[0];
  if (round === undefined) throw new Error('the round is gone');
  expect(round.state).toBe('SETTLED');
  expect(round.steps).toBeGreaterThan(0);
  // Credited exactly once: the opening balance minus one stake plus one payable win — a resume
  // that double-credited, or a reload that re-spun, cannot produce this number.
  expect(server.balance).toBe(START_BALANCE - stake + round.cumulativeWin);
});

test('two visitors at once are two players: one spinning leaves the other untouched', async ({
  browser,
  request,
}) => {
  // The deployed demo's whole claim about strangers: separate contexts are separate visitors,
  // each with their own wallet, round and debug surface on the one server.
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  await openIdle(alice);
  await openIdle(bob);
  expect(await sessionTokenOf(alice)).not.toBe(await sessionTokenOf(bob));

  const stake = await readNumber(alice, 'stake');
  await force(alice, 'DEAD_SPIN');
  await pressSpin(alice);
  await phaseIsNot(alice, 'IDLE', 10_000);
  await phaseIs(alice, 'IDLE', 60_000);

  expect((await serverState(request, alice)).balance).toBe(START_BALANCE - stake);
  const bobs = await serverState(request, bob);
  expect(bobs.balance).toBe(START_BALANCE);
  expect(bobs.rounds).toHaveLength(0);
  expect(await readNumber(bob, 'balance')).toBe(START_BALANCE);

  await alice.context().close();
  await bob.context().close();
});
