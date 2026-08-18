import type {
  AuthenticateReq,
  AuthenticateRes,
  CallName,
  CallResponse,
  FeatureSpinReq,
  FeatureSpinRes,
  SettleReq,
  SettleRes,
  SpinReq,
  SpinRes,
} from '@slot/protocol';
import type { InProcessBackend, RgsTransport } from './transport.js';

/**
 * `MockTransport` — the dev default: the simulator, in-process, at whatever latency it asks for.
 *
 * It is deliberately thin. The backend decides *what* happens to a call, including how long it takes
 * and whether it is answered at all; this class only enacts that decision, because the simulator is
 * a pure package and cannot sleep or hang on its own. One fault policy, enacted here in-process and
 * by `apps/mock-rgs` over HTTP (S2) — not two implementations that agree until they don't.
 *
 * A dropped response produces a promise that **never settles**, which is exactly what a hard
 * disconnect looks like to a caller. Turning that into a `TIMEOUT` is the retry layer's job (C2);
 * doing it here would mean the transport could never be used to test the retry layer.
 */

const wait = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export interface MockTransportOptions {
  backend: InProcessBackend;
  /**
   * Injected so a test can drive fault scenarios without actually waiting. Defaults to `setTimeout`.
   */
  sleep?: (ms: number) => Promise<void>;
}

export class MockTransport implements RgsTransport {
  readonly #backend: InProcessBackend;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor({ backend, sleep = wait }: MockTransportOptions) {
    this.#backend = backend;
    this.#sleep = sleep;
  }

  authenticate(request: AuthenticateReq): Promise<AuthenticateRes> {
    return this.#call('authenticate', request);
  }

  spin(request: SpinReq): Promise<SpinRes> {
    return this.#call('spin', request);
  }

  featureSpin(request: FeatureSpinReq): Promise<FeatureSpinRes> {
    return this.#call('featureSpin', request);
  }

  settle(request: SettleReq): Promise<SettleRes> {
    return this.#call('settle', request);
  }

  async #call<N extends CallName>(call: N, request: unknown): Promise<CallResponse<N>> {
    const delivery = this.#backend.deliver(call, request);

    // The backend already ran the call — the state moved and the answer is gone. Hanging forever is
    // the honest model of that, and the caller's timeout is what ends the wait.
    if (delivery.kind === 'DROP') return new Promise<never>(() => {});

    await this.#sleep(delivery.delayMs);

    if (delivery.kind === 'REJECT') throw delivery.error;
    return delivery.response;
  }
}
