// Phone layout: the results panel is a bottom sheet with three positions.
//   peek  - a one-line summary, the map gets almost the whole screen
//   half  - the default for a new result
//   full  - the card covers the map
// Drag the handle (snaps to the nearest position) or tap it (peek <-> half). The last
// position is remembered; a new result opens at half. Desktop keeps the side panel.

export type SheetState = 'peek' | 'half' | 'full';

const KEY = 'zachroute:sheet-state';
const PEEK_PX = 64;
const TAP_SLOP_PX = 6;

export interface SheetHeights {
  peek: number;
  half: number;
  full: number;
}

/** Pixel heights for the three positions inside a container of the given height. */
export function heightsFor(containerPx: number): SheetHeights {
  return { peek: PEEK_PX, half: Math.round(containerPx * 0.45), full: containerPx };
}

/** The position closest to a dragged height. */
export function nearestState(heightPx: number, h: SheetHeights): SheetState {
  const order: SheetState[] = ['peek', 'half', 'full'];
  return order.reduce((best, s) => (Math.abs(h[s] - heightPx) < Math.abs(h[best] - heightPx) ? s : best), 'half' as SheetState);
}

/** What a tap on the handle does. */
export function tapTarget(state: SheetState): SheetState {
  return state === 'peek' ? 'half' : 'peek';
}

function loadState(): SheetState {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'peek' || v === 'half' || v === 'full' ? v : 'half';
  } catch {
    return 'half';
  }
}

function saveState(s: SheetState) {
  try {
    localStorage.setItem(KEY, s);
  } catch {
    /* convenience only */
  }
}

export interface Sheet {
  setState(s: SheetState): void;
  setSummary(text: string): void;
  isPhone(): boolean;
}

export function initSheet(onResize: () => void): Sheet {
  const main = document.querySelector('.main-content') as HTMLElement;
  const header = document.getElementById('sheet-header') as HTMLElement;
  const summary = document.getElementById('sheet-summary') as HTMLElement;
  const phone = window.matchMedia('(max-width: 768px)');
  let state: SheetState = loadState();
  let resizeTimer: number | undefined;

  const notifyResize = () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(onResize, 220); // after the height transition
  };

  const apply = (heightPx?: number) => {
    if (!phone.matches) {
      main.style.removeProperty('--sheet-h');
      return;
    }
    const h = heightsFor(main.clientHeight);
    main.style.setProperty('--sheet-h', `${heightPx ?? h[state]}px`);
    main.dataset.sheet = state;
    header.setAttribute('aria-label', `Results panel (${state}). Drag or tap to resize.`);
  };

  const setState = (s: SheetState) => {
    state = s;
    saveState(s);
    apply();
    notifyResize();
  };

  // Drag / tap on the header strip
  let startY = 0;
  let startH = 0;
  let dragging = false;
  header.addEventListener('pointerdown', (e) => {
    if (!phone.matches) return;
    dragging = true;
    startY = e.clientY;
    startH = heightsFor(main.clientHeight)[state];
    header.setPointerCapture(e.pointerId);
    main.classList.add('sheet-dragging');
  });
  header.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const h = heightsFor(main.clientHeight);
    const next = Math.min(Math.max(startH + (startY - e.clientY), h.peek), h.full);
    apply(next);
  });
  const end = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    main.classList.remove('sheet-dragging');
    const moved = Math.abs(e.clientY - startY);
    if (moved < TAP_SLOP_PX) {
      setState(tapTarget(state));
      return;
    }
    const h = heightsFor(main.clientHeight);
    const dragged = Math.min(Math.max(startH + (startY - e.clientY), h.peek), h.full);
    setState(nearestState(dragged, h));
  };
  header.addEventListener('pointerup', end);
  header.addEventListener('pointercancel', end);
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setState(tapTarget(state));
    }
  });

  window.addEventListener('resize', () => apply());
  phone.addEventListener('change', () => {
    apply();
    notifyResize();
  });
  apply();

  return {
    setState,
    setSummary(text: string) {
      summary.textContent = text;
    },
    isPhone: () => phone.matches,
  };
}
