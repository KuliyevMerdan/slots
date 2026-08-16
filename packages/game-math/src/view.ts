import type { SymbolId } from '@slot/protocol';

/**
 * Derive the visible grid from the server's stops — `view[reel][row]`.
 *
 * `stops` is the authority; the view is a projection of it. The server sends both so the client can
 * assert they agree (`__ASSERT_MATH__`), which is what turns a strip-alignment bug into a console
 * error during development instead of a support ticket.
 */
export function viewFrom(
  strips: readonly (readonly SymbolId[])[],
  stops: readonly number[],
  rows: number,
): SymbolId[][] {
  if (stops.length !== strips.length) {
    throw new RangeError(`expected ${strips.length} stops, got ${stops.length}`);
  }
  if (rows < 1) {
    throw new RangeError(`rows must be at least 1, got ${rows}`);
  }

  return strips.map((strip, reel) => {
    if (strip.length === 0) {
      throw new RangeError(`reel ${reel} has an empty strip`);
    }

    const stop = stops[reel];
    if (stop === undefined || !Number.isInteger(stop) || stop < 0) {
      throw new RangeError(`reel ${reel} has an invalid stop: ${String(stop)}`);
    }

    return Array.from({ length: rows }, (_unused, row) => {
      // Wrap-around: a strip is a loop, and a stop near the end shows the start underneath it.
      const symbol = strip[(stop + row) % strip.length];
      if (symbol === undefined) {
        throw new RangeError(`reel ${reel} produced no symbol at row ${row}`);
      }
      return symbol;
    });
  });
}

/**
 * Do the two representations of the same outcome agree?
 *
 * Used by the dev-build assertion, and by the contract suite against every server target — a server
 * whose `view` disagrees with its own `stops` is a server with a strip-alignment bug.
 */
export function viewMatchesStops(
  strips: readonly (readonly SymbolId[])[],
  stops: readonly number[],
  view: readonly (readonly SymbolId[])[],
): boolean {
  const rows = view[0]?.length ?? 0;
  if (rows === 0 || view.length !== strips.length) return false;

  let derived: SymbolId[][];
  try {
    derived = viewFrom(strips, stops, rows);
  } catch {
    return false;
  }

  return derived.every((reel, reelIndex) =>
    reel.every((symbol, row) => symbol === view[reelIndex]?.[row]),
  );
}
