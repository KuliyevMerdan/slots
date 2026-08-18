import { describe, expect, it, vi } from 'vitest';
import type { CallName, CallResponse } from '@slot/protocol';
import { SlotError } from '@slot/protocol';
import { MockTransport } from './mock.js';
import type { BackendDelivery, InProcessBackend } from './transport.js';

/**
 * The transport is driven by a hand-written backend, not by the simulator.
 *
 * That is the point of the seam: `transport` may only depend on `@slot/protocol`, so the in-process
 * backend is a structural interface anything can satisfy — the real `SimServer` at the wiring site,
 * and twenty lines of fake here. If this file needed `@slot/rgs-sim` to say anything, the boundary
 * would not be real.
 */

class FakeBackend implements InProcessBackend {
  readonly calls: Array<{ call: CallName; request: unknown }> = [];
  #next: BackendDelivery<never> | null = null;

  /** Queue what the next call returns. Defaults to an immediate, empty delivery. */
  respondWith(delivery: BackendDelivery<never>): void {
    this.#next = delivery;
  }

  deliver<N extends CallName>(call: N, request: unknown): BackendDelivery<CallResponse<N>> {
    this.calls.push({ call, request });
    return (this.#next ?? {
      kind: 'DELIVER',
      delayMs: 0,
      response: { echoed: call } as unknown as never,
    }) as BackendDelivery<CallResponse<N>>;
  }
}

const transportOver = (backend: InProcessBackend, sleep = vi.fn(async () => {})) => ({
  transport: new MockTransport({ backend, sleep }),
  sleep,
});

const AUTH = { token: 'demo' };

describe('MockTransport', () => {
  it('routes each method to its own call name', async () => {
    const backend = new FakeBackend();
    const { transport } = transportOver(backend);

    await transport.authenticate(AUTH);
    await transport.spin({ roundId: 'r', stake: 100 } as never);
    await transport.featureSpin({ roundId: 'r', step: 1 } as never);
    await transport.settle({ roundId: 'r' } as never);

    expect(backend.calls.map((entry) => entry.call)).toEqual([
      'authenticate',
      'spin',
      'featureSpin',
      'settle',
    ]);
  });

  it('passes the request through untouched', async () => {
    const backend = new FakeBackend();
    const { transport } = transportOver(backend);

    await transport.authenticate(AUTH);

    expect(backend.calls[0]?.request).toEqual(AUTH);
  });

  it('resolves with whatever the backend delivered', async () => {
    const backend = new FakeBackend();
    backend.respondWith({ kind: 'DELIVER', delayMs: 0, response: { ok: true } as never });
    const { transport } = transportOver(backend);

    await expect(transport.authenticate(AUTH)).resolves.toEqual({ ok: true });
  });

  describe('latency', () => {
    it('waits for the delay the backend asked for', async () => {
      const backend = new FakeBackend();
      backend.respondWith({ kind: 'DELIVER', delayMs: 250, response: {} as never });
      const { transport, sleep } = transportOver(backend);

      await transport.authenticate(AUTH);

      expect(sleep).toHaveBeenCalledWith(250);
    });

    it('waits before rejecting, too — a failure takes time to arrive as well', async () => {
      const backend = new FakeBackend();
      backend.respondWith({
        kind: 'REJECT',
        delayMs: 400,
        error: new SlotError('TIMEOUT', 'injected'),
      });
      const { transport, sleep } = transportOver(backend);

      await expect(transport.spin({ roundId: 'r', stake: 100 } as never)).rejects.toThrow();
      expect(sleep).toHaveBeenCalledWith(400);
    });
  });

  describe('errors', () => {
    it('throws the classified error the backend produced', async () => {
      const backend = new FakeBackend();
      backend.respondWith({
        kind: 'REJECT',
        delayMs: 0,
        error: new SlotError('INSUFFICIENT_FUNDS', 'no funds'),
      });
      const { transport } = transportOver(backend);

      await expect(transport.spin({ roundId: 'r', stake: 100 } as never)).rejects.toMatchObject({
        code: 'INSUFFICIENT_FUNDS',
        errorClass: 'PLAYER',
      });
    });
  });

  describe('a dropped response', () => {
    /**
     * A hard disconnect, modelled honestly: the call happened, the answer never comes. Turning this
     * into a `TIMEOUT` belongs to the retry layer (C2) — doing it here would make the transport
     * useless for testing the retry layer.
     */
    it('never settles', async () => {
      const backend = new FakeBackend();
      backend.respondWith({ kind: 'DROP' });
      const { transport } = transportOver(backend);

      const settled = await Promise.race([
        transport.spin({ roundId: 'r', stake: 100 } as never).then(() => 'settled'),
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 20)),
      ]);

      expect(settled).toBe('still waiting');
    });

    it('still reached the backend — the round is real', async () => {
      const backend = new FakeBackend();
      backend.respondWith({ kind: 'DROP' });
      const { transport } = transportOver(backend);

      void transport.spin({ roundId: 'r', stake: 100 } as never);
      await Promise.resolve();

      expect(backend.calls).toHaveLength(1);
    });

    it('does not wait before hanging', async () => {
      const backend = new FakeBackend();
      backend.respondWith({ kind: 'DROP' });
      const { transport, sleep } = transportOver(backend);

      void transport.spin({ roundId: 'r', stake: 100 } as never);
      await Promise.resolve();

      // There is nothing to deliver, so there is nothing to be late.
      expect(sleep).not.toHaveBeenCalled();
    });
  });
});
