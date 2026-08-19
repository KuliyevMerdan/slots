/**
 * The shared drawer — one DOM frame, two occupants.
 *
 * The round-history panel (player-facing, every build) and the debug panel (dev builds only) are
 * documents, and a document wants scroll, focus order and a screen reader — so they share one
 * `<aside>` in the shell rather than each inventing an overlay. The drawer knows nothing about
 * what it shows: a view is a title, an element to unhide, and an optional `onOpen` (the history
 * panel refetches there). Opening a second view swaps the first out; opening the same view again
 * closes it, so the launcher buttons toggle.
 *
 * Real DOM types on purpose: this is shell wiring, the same altitude as the reality-check dialog
 * in game.ts — the panels behind it are the tested surface.
 */

export interface DrawerView {
  title: string;
  /** Optional in the structural sense only — the panels' port types declare it `hidden?`. */
  element: { hidden?: boolean };
  /** Called on every open, not the first: what is shown must be current, not remembered. */
  onOpen?: () => void;
}

export interface DrawerOptions {
  root: HTMLElement;
  title: HTMLElement;
  close: HTMLButtonElement;
  closeLabel: string;
}

export interface Drawer {
  /** Open the view — or close the drawer if this view is the one already showing. */
  toggle(view: DrawerView): void;
  close(): void;
  destroy(): void;
}

export function createDrawer({ root, title, close, closeLabel }: DrawerOptions): Drawer {
  let current: DrawerView | undefined;
  close.textContent = closeLabel;

  const doClose = (): void => {
    if (current !== undefined) current.element.hidden = true;
    current = undefined;
    root.hidden = true;
  };

  const onCloseClick = (): void => {
    doClose();
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') doClose();
  };
  close.addEventListener('click', onCloseClick);
  root.addEventListener('keydown', onKeydown);

  return {
    toggle(view) {
      if (current === view) {
        doClose();
        return;
      }
      if (current !== undefined) current.element.hidden = true;
      current = view;
      title.textContent = view.title;
      view.element.hidden = false;
      root.hidden = false;
      view.onOpen?.();
      close.focus();
    },
    close: doClose,
    destroy() {
      close.removeEventListener('click', onCloseClick);
      root.removeEventListener('keydown', onKeydown);
      doClose();
    },
  };
}

/**
 * Keep Tab inside a modal dialog.
 *
 * The reality check moves focus in when it opens; without this, the next Tab walks out into a page
 * the overlay is covering — a keyboard user can reach controls a pointer user cannot see. Cycling
 * at the edges is the WAI-ARIA dialog pattern's answer, and it is a listener rather than an inert
 * attribute because `inert` on everything-else is a bigger hammer than a demo shell needs.
 */
export function trapFocus(container: HTMLElement): () => void {
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;

    const focusable = Array.from(
      container.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hasAttribute('disabled'));

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;

    const active = container.ownerDocument.activeElement;
    if (event.shiftKey && (active === first || !container.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !container.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  container.addEventListener('keydown', onKeydown);
  return () => {
    container.removeEventListener('keydown', onKeydown);
  };
}
