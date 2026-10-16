// Dropdown under the search box. Shows suggestions as the user types; nothing changes on the
// map until one is picked (tap, click, or Enter on the highlighted row).

export interface SuggestItem {
  query: string;
  title: string;
  detail?: string;
  /** Small label shown at the right of the row ("Route", "Recent", ...). */
  badge?: string;
  /** Runs instead of a search when picked (e.g. "Clear recent searches"). */
  action?: () => void;
  /** Rendered muted, for utility rows like "Clear recent searches". */
  subtle?: boolean;
}

export interface SuggestList {
  show(items: SuggestItem[]): void;
  hide(): void;
  isOpen(): boolean;
  /** Arrow keys / Enter / Escape. Returns true when the key was handled. */
  handleKey(e: KeyboardEvent): boolean;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function createSuggestList(input: HTMLInputElement, listEl: HTMLElement, onPick: (item: SuggestItem) => void): SuggestList {
  let items: SuggestItem[] = [];
  let active = -1;

  const render = () => {
    listEl.innerHTML = items
      .map(
        (item, i) =>
          `<li role="option" id="suggest-${i}" class="suggest-item${i === active ? ' is-active' : ''}${item.subtle ? ' is-subtle' : ''}" data-index="${i}" aria-selected="${i === active}">` +
          `<span class="suggest-title">${esc(item.title)}</span>` +
          (item.badge ? `<span class="suggest-badge">${esc(item.badge)}</span>` : '') +
          (item.detail ? `<span class="suggest-detail">${esc(item.detail)}</span>` : '') +
          `</li>`
      )
      .join('');
    listEl.hidden = items.length === 0;
    input.setAttribute('aria-expanded', String(items.length > 0));
    if (active >= 0) input.setAttribute('aria-activedescendant', `suggest-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };

  // pointerdown (not click) so the pick happens before the input loses focus and closes the list.
  listEl.addEventListener('pointerdown', (e) => {
    const li = (e.target as HTMLElement).closest('.suggest-item') as HTMLElement | null;
    if (!li) return;
    e.preventDefault();
    const item = items[Number(li.dataset.index)];
    if (item) onPick(item);
  });

  return {
    show(next) {
      items = next;
      active = -1;
      render();
    },
    hide() {
      items = [];
      active = -1;
      render();
    },
    isOpen: () => items.length > 0,
    handleKey(e) {
      if (!items.length) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const step = e.key === 'ArrowDown' ? 1 : -1;
        active = (active + step + items.length + 1) % (items.length + 1);
        if (active === items.length) active = -1;
        render();
        return true;
      }
      if (e.key === 'Enter' && active >= 0) {
        onPick(items[active]);
        return true;
      }
      if (e.key === 'Escape') {
        items = [];
        active = -1;
        render();
        return true;
      }
      return false;
    },
  };
}
