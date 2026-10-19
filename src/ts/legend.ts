// Map legend: one panel at the bottom left with a row for each layer that is switched on, built
// from the same colors the layers draw with. Open on a computer; on a phone it starts as a
// "Legend (n)" chip so it does not cover the map. Opening or closing it is remembered.

export interface LegendItem {
  color: string;
  label: string;
  /** How the swatch is drawn: a filled dot (default), a ring, a solid or dashed line, or a text glyph. */
  mark?: 'dot' | 'ring' | 'line' | 'dash' | 'glyph' | 'diamond' | 'square';
  glyph?: string;
}

export type LegendSpec =
  | { kind: 'gradient'; title: string; colors: string[]; labels: string[]; note?: string; items?: LegendItem[] }
  | { kind: 'items'; title: string; items: LegendItem[]; note?: string };

/** Rows are shown in this order, whatever order the layers were switched on in. */
export const LEGEND_ORDER = ['route', 'stations', 'pireps', 'hazards', 'cyclones', 'tfrs', 'fires', 'freezing', 'satellite', 'aerosol'];

const OPEN_KEY = 'zachroute:legend-open';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function swatchHtml(item: LegendItem): string {
  const mark = item.mark || 'dot';
  if (mark === 'glyph') return `<span class="lg-glyph" style="color:${item.color}">${esc(item.glyph || '')}</span>`;
  return `<span class="lg-swatch lg-${mark}" style="--c:${item.color}"></span>`;
}

function itemsHtml(items: LegendItem[]): string {
  return `<div class="lg-items">${items.map((i) => `<span class="lg-item">${swatchHtml(i)}${esc(i.label)}</span>`).join('')}</div>`;
}

/** One legend row as HTML. Pure, so it can be tested. */
export function legendRowHtml(spec: LegendSpec): string {
  const note = spec.note ? `<div class="lg-note">${esc(spec.note)}</div>` : '';
  if (spec.kind === 'items') {
    return `<div class="lg-row"><div class="lg-title">${esc(spec.title)}</div>${itemsHtml(spec.items)}${note}</div>`;
  }
  const bar = `<div class="lg-bar" style="background:linear-gradient(90deg, ${spec.colors.join(', ')})"></div>`;
  const labels = `<div class="lg-labels">${spec.labels.map((l) => `<span>${esc(l)}</span>`).join('')}</div>`;
  const extra = spec.items?.length ? itemsHtml(spec.items) : '';
  return `<div class="lg-row"><div class="lg-title">${esc(spec.title)}</div>${bar}${labels}${extra}${note}</div>`;
}

const specs = new Map<string, LegendSpec>();
let open: boolean | null = null;

function isPhone(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 768px)').matches;
}

function readOpen(): boolean {
  if (open !== null) return open;
  try {
    const saved = localStorage.getItem(OPEN_KEY);
    if (saved !== null) return (open = saved === 'true');
  } catch {
    /* convenience only */
  }
  return (open = !isPhone());
}

function render() {
  const el = document.getElementById('map-legend');
  if (!el) return;
  const ids = LEGEND_ORDER.filter((id) => specs.has(id));
  if (!ids.length) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const isOpen = readOpen();
  el.hidden = false;
  el.classList.toggle('is-open', isOpen);
  el.innerHTML =
    `<button type="button" class="lg-toggle" aria-expanded="${isOpen}">Legend${isOpen ? '' : ` (${ids.length})`}<span class="lg-chev">${isOpen ? '\u25be' : '\u25b8'}</span></button>` +
    (isOpen ? `<div class="lg-body">${ids.map((id) => legendRowHtml(specs.get(id)!)).join('')}</div>` : '');
  el.querySelector('.lg-toggle')?.addEventListener('click', () => {
    open = !readOpen();
    try {
      localStorage.setItem(OPEN_KEY, String(open));
    } catch {
      /* convenience only */
    }
    render();
  });
}

/** Shows (or, with null, removes) the legend row for one layer. */
export function setLegend(id: string, spec: LegendSpec | null) {
  if (spec) specs.set(id, spec);
  else specs.delete(id);
  render();
}
