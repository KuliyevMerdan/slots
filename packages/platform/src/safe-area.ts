/**
 * Safe-area insets — the notch, the home indicator, the rounded corners.
 *
 * CSS knows them as `env(safe-area-inset-*)`, and CSS is the only place they exist: there is no
 * JavaScript API. So this module asks CSS — a hidden probe element padded with the four `env()`
 * values, measured once with `getComputedStyle`, removed. The probe dance is the standard trick;
 * wrapping it here means the rest of the workspace gets four numbers and no DOM.
 */

export interface SafeAreaInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export const NO_INSETS: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * The slice of `document` the probe needs. Parameters are `unknown` so the real DOM's generically
 * typed methods satisfy the port structurally — the fake in the tests narrows them itself.
 */
export interface ProbeDocument {
  createElement(tag: string): ProbeElement;
  readonly body: {
    appendChild(node: unknown): unknown;
    removeChild(node: unknown): unknown;
  };
  readonly defaultView: {
    getComputedStyle(element: unknown): { getPropertyValue(name: string): string };
  } | null;
}

export interface ProbeElement {
  style: { cssText: string };
}

const parsePx = (value: string): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Measure the insets once. Call it again on `orientationchange` — a rotated phone moves its notch.
 * Returns zeros wherever the platform (or a test's fake) has nothing to say.
 */
export function readSafeAreaInsets(doc: ProbeDocument): SafeAreaInsets {
  const view = doc.defaultView;
  if (view === null) return NO_INSETS;

  const probe = doc.createElement('div');
  probe.style.cssText =
    'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;' +
    'padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);' +
    'padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);';
  doc.body.appendChild(probe);

  try {
    const style = view.getComputedStyle(probe);
    return {
      top: parsePx(style.getPropertyValue('padding-top')),
      right: parsePx(style.getPropertyValue('padding-right')),
      bottom: parsePx(style.getPropertyValue('padding-bottom')),
      left: parsePx(style.getPropertyValue('padding-left')),
    };
  } finally {
    doc.body.removeChild(probe);
  }
}
