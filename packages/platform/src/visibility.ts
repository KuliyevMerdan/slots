/**
 * Tab visibility, behind a port.
 *
 * The one consumer that matters is audio — a slot that keeps chiming from a background tab is a
 * bug with a soundtrack — but the seam is generic: anything that should pause when the player
 * looks away subscribes here rather than to the DOM.
 */

/** The slice of `document` this module reads. The real one satisfies it. */
export interface VisibilityDocument {
  readonly visibilityState: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * Watch visibility. The callback fires immediately with the current state — a subscriber's first
 * question is "am I visible *now*?", and answering it here means no caller ever reads the DOM —
 * and then on every change. Returns the unsubscribe.
 */
export function watchVisibility(
  doc: VisibilityDocument,
  onChange: (visible: boolean) => void,
): () => void {
  const notify = (): void => {
    onChange(doc.visibilityState !== 'hidden');
  };

  doc.addEventListener('visibilitychange', notify);
  notify();

  return () => {
    doc.removeEventListener('visibilitychange', notify);
  };
}
