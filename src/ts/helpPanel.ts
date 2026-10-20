// The Help window: opened by the ? button in the header, by the info button on a setting (at that
// setting's entry), or by a link ending in #help or #help/<entry>. Built from help.ts.

import { helpHtml } from './help';

export interface HelpPanel {
  open(entry?: string): void;
  close(): void;
}

export function mountHelp(): HelpPanel | null {
  const modal = document.getElementById('help-modal') as HTMLElement | null;
  const body = document.getElementById('help-body') as HTMLElement | null;
  const search = document.getElementById('help-search') as HTMLInputElement | null;
  const opener = document.getElementById('help-open') as HTMLButtonElement | null;
  if (!modal || !body || !search) return null;
  let built = false;
  let returnFocus: HTMLElement | null = null;

  function filter() {
    const q = search!.value.trim().toLowerCase();
    let any = false;
    for (const section of body!.querySelectorAll<HTMLElement>('.help-section')) {
      let shown = 0;
      for (const entry of section.querySelectorAll<HTMLElement>('.help-entry')) {
        const hit = !q || (entry.textContent || '').toLowerCase().includes(q);
        entry.hidden = !hit;
        if (hit) shown += 1;
      }
      section.hidden = shown === 0;
      any ||= shown > 0;
    }
    const empty = body!.querySelector('.help-empty') as HTMLElement | null;
    if (empty) empty.hidden = any;
  }

  function open(entry?: string) {
    if (!built) {
      body!.innerHTML = helpHtml();
      built = true;
    }
    if (modal!.hidden) returnFocus = document.activeElement as HTMLElement | null;
    search!.value = '';
    filter();
    modal!.hidden = false;
    opener?.setAttribute('aria-expanded', 'true');
    const target = entry ? (body!.querySelector(`[data-help-entry="${CSS.escape(entry)}"]`) as HTMLElement | null) : null;
    if (target) {
      target.scrollIntoView({ block: 'start' });
      target.classList.remove('is-flash');
      void target.offsetWidth;
      target.classList.add('is-flash');
    } else {
      body!.scrollTop = 0;
    }
    (modal!.querySelector('.modal-close') as HTMLElement | null)?.focus();
  }

  function close() {
    if (modal!.hidden) return;
    modal!.hidden = true;
    opener?.setAttribute('aria-expanded', 'false');
    if (location.hash.startsWith('#help')) history.replaceState(history.state, '', location.pathname + location.search);
    returnFocus?.focus();
  }

  search.addEventListener('input', filter);
  opener?.addEventListener('click', () => (modal.hidden ? open() : close()));
  modal.querySelector('.modal-close')?.addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });

  // A link straight to Help: #help or #help/radar
  const fromHash = () => {
    const m = location.hash.match(/^#help(?:\/([a-z0-9-]+))?$/);
    if (m) open(m[1]);
  };
  fromHash();
  window.addEventListener('hashchange', fromHash);

  return { open, close };
}
