/**
 * The telemetry seam — one interface, one console adapter, and the four places worth reporting.
 *
 * The problem it solves is narrow and real: a `FATAL` error in a deployed build is currently visible
 * to nobody. The debug panel exports an event log *locally*, which helps whoever is sitting at the
 * machine and nobody else, and a `SCHEMA_MISMATCH` against a server that quietly changed shape is
 * exactly the failure that never gets reported by the player who hit it.
 *
 * So this is deliberately a **seam rather than a reporter**. Wiring Sentry, an operator's collector
 * or a `navigator.sendBeacon` later means constructing a different object at boot; nothing above
 * this file learns which one it got. Same move as `RgsTransport` and the persistence port — the
 * thing the pure code cannot do arrives as an argument.
 *
 * It lives in the client rather than in a package because every report site is here: the boot
 * failure happens before the engine exists, the engine's errors arrive as events the client already
 * subscribes to, and the dev-build assertions are the client's own. When `@slot/platform` lands (C6)
 * and something else needs to report, the interface moves there and this file keeps the adapter.
 */

export type TelemetryLevel = 'INFO' | 'WARN' | 'ERROR';

export interface TelemetryEvent {
  /** Stable, snake_case, low-cardinality — a name you can group by, not a sentence. */
  name: string;
  level: TelemetryLevel;
  message?: string;
  /** The round this belongs to, when there is one. Every real investigation starts here. */
  roundId?: string;
  /** The server's id for the call, echoed back — what joins a browser report to a server log. */
  correlationId?: string;
  detail?: Record<string, unknown>;
}

export interface Telemetry {
  report(event: TelemetryEvent): void;
}

/** The sink for a production build with nothing wired: reports go nowhere, and cost nothing. */
export const noopTelemetry = (): Telemetry => ({ report: () => undefined });

/**
 * The default adapter: the console, with the fields laid out so they are greppable.
 *
 * Console output is not a reporting strategy — but it is an honest one for a demo, and it makes the
 * seam something you can watch working rather than take on trust.
 */
export const consoleTelemetry = (
  sink: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Telemetry => ({
  report: (event) => {
    const line = `[telemetry] ${event.name}${event.message === undefined ? '' : ` — ${event.message}`}`;
    const context = {
      ...(event.roundId === undefined ? {} : { roundId: event.roundId }),
      ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
      ...event.detail,
    };

    if (event.level === 'ERROR') sink.error(line, context);
    else if (event.level === 'WARN') sink.warn(line, context);
    else sink.info(line, context);
  },
});

/**
 * Wrap a reporter so it cannot take the game down.
 *
 * A telemetry call sits on the error path, which is the worst possible place for a second failure: a
 * reporter that throws while reporting an error turns a frozen reel set into a blank page. Every
 * report site goes through this, so the guarantee is structural rather than a rule to remember.
 */
export const guarded = (telemetry: Telemetry): Telemetry => ({
  report: (event) => {
    try {
      telemetry.report(event);
    } catch {
      // Deliberately silent. There is nowhere left to report a reporting failure to.
    }
  },
});
