// The settings window: built from features.ts into #settings-body, opened by the gear button.
// Sections fold (remembered), layer sections count what is on, switches are checkboxes with
// role="switch", and sub-options are segmented buttons over a hidden <select> so main.ts keeps
// wiring plain inputs and change events.

import { FEATURES, SECTIONS, isSettingKey, type Choice, type Feature } from './features';
import { readPref, writePref } from './prefs';

const OPEN_KEY = 'zachroute:settings-open';

function readOpenSections(): Set<string> {
  try {
    const saved = localStorage.getItem(OPEN_KEY);
    return new Set(saved ? (JSON.parse(saved) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveOpenSections(open: Set<string>) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
  } catch {
    /* convenience only */
  }
}

function segmentedHtml(input: string, label: string, choices: Choice[]): string {
  const buttons = choices
    .map((c, n) => `<button type="button" role="radio" aria-checked="${n === 0}" data-value="${c.value}">${c.label}</button>`)
    .join('');
  const options = choices.map((c) => `<option value="${c.value}">${c.label}</option>`).join('');
  return `<div class="segmented" role="radiogroup" aria-label="${label}" data-input="${input}">${buttons}</div><select id="${input}" hidden>${options}</select>`;
}

export function featureRowHtml(f: Feature): string {
  const c = f.control;
  const text = `<span class="setting-text"><span class="setting-label">${f.label}</span><span class="setting-desc">${f.desc}</span></span>`;
  const info = `<button type="button" class="setting-info" data-help="${f.id}" aria-label="Help: ${f.label}" title="What this shows">i</button>`;
  if (c.kind === 'choice') {
    return `<div class="setting-row setting-row--choice" data-feature="${f.id}">${text}${info}${segmentedHtml(c.input, f.label, c.choices)}</div>`;
  }
  const row = `<div class="setting-row" data-feature="${f.id}"><label class="setting-main" for="${c.input}">${text}</label>${info}<input type="checkbox" role="switch" class="switch" id="${c.input}" /></div>`;
  if (!c.option) return row;
  const o = c.option;
  return `${row}<div class="setting-option" data-for="${c.input}" hidden><span class="setting-option-label">${o.label}</span>${segmentedHtml(o.input, `${f.label}: ${o.label}`, o.choices)}</div>`;
}

export function settingsHtml(open: Set<string>): string {
  return SECTIONS.map((s) => {
    const rows = FEATURES.filter((f) => f.section === s.id).map(featureRowHtml).join('');
    const isOpen = open.has(s.id);
    const note = s.note ? `<p class="settings-note">${s.note}</p>` : '';
    return `<section class="settings-section" data-section="${s.id}" data-layers="${s.layers}">
      <button type="button" class="settings-section-head" aria-expanded="${isOpen}" aria-controls="settings-sec-${s.id}">
        <span class="settings-section-title">${s.title}</span>${s.layers ? '<span class="settings-count"></span>' : ''}<span class="settings-chevron" aria-hidden="true"></span>
      </button>
      <div class="settings-section-body" id="settings-sec-${s.id}"${isOpen ? '' : ' hidden'}>${note}${rows}</div>
    </section>`;
  }).join('');
}

export interface SettingsPanel {
  /** Re-reads every input (after main.ts restores saved values) and updates counts and buttons. */
  refresh(): void;
  close(): void;
}

/** Builds the settings window and wires opening, closing, folding and the segmented buttons. */
export function mountSettings(onHelp?: (feature: string) => void): SettingsPanel | null {
  const modal = document.getElementById('settings-modal') as HTMLElement | null;
  const body = document.getElementById('settings-body') as HTMLElement | null;
  const opener = document.getElementById('menu-toggle') as HTMLButtonElement | null;
  if (!modal || !body || !opener) return null;

  const open = readOpenSections();
  body.innerHTML = settingsHtml(open);

  // Map layer switches only: route and card choices are not layers.
  const switches = () => [...body.querySelectorAll<HTMLInputElement>('[data-layers="true"] input.switch')];

  // Settings the window stores itself: restore them now, save them on change.
  for (const f of FEATURES) {
    if (!f.pref) continue;
    const { key, default: fallback } = f.pref;
    const input = document.getElementById(f.control.input) as HTMLInputElement | HTMLSelectElement | null;
    if (!input) continue;
    if (input instanceof HTMLInputElement) input.checked = readPref(key, fallback) === 'true';
    else input.value = readPref(key, fallback);
    input.addEventListener('change', () => writePref(key, input instanceof HTMLInputElement ? String(input.checked) : input.value));
  }

  function syncSegmented(group: HTMLElement) {
    const select = document.getElementById(group.dataset.input || '') as HTMLSelectElement | null;
    if (!select) return;
    for (const b of group.querySelectorAll<HTMLButtonElement>('button')) {
      const on = b.dataset.value === select.value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }

  function refresh() {
    for (const opt of body!.querySelectorAll<HTMLElement>('.setting-option')) {
      const input = document.getElementById(opt.dataset.for || '') as HTMLInputElement | null;
      opt.hidden = !input?.checked;
    }
    for (const group of body!.querySelectorAll<HTMLElement>('.segmented')) syncSegmented(group);
    for (const sec of body!.querySelectorAll<HTMLElement>('.settings-section')) {
      const count = sec.querySelector('.settings-count');
      if (!count) continue;
      const on = sec.querySelectorAll('input.switch:checked').length;
      count.textContent = on ? `${on} on` : '';
    }
  }

  body.addEventListener('change', refresh);

  body.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const info = target.closest('.setting-info') as HTMLButtonElement | null;
    if (info) {
      onHelp?.(info.dataset.help || '');
      return;
    }
    const head = target.closest('.settings-section-head') as HTMLButtonElement | null;
    if (head) {
      const sec = head.closest('.settings-section') as HTMLElement;
      const panel = sec.querySelector('.settings-section-body') as HTMLElement;
      const nowOpen = panel.hidden;
      panel.hidden = !nowOpen;
      head.setAttribute('aria-expanded', String(nowOpen));
      const id = sec.dataset.section || '';
      if (nowOpen) open.add(id);
      else open.delete(id);
      saveOpenSections(open);
      return;
    }
    const seg = target.closest('.segmented button') as HTMLButtonElement | null;
    if (seg) {
      const group = seg.parentElement as HTMLElement;
      const select = document.getElementById(group.dataset.input || '') as HTMLSelectElement | null;
      if (!select || select.value === seg.dataset.value) return;
      select.value = seg.dataset.value || '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  // Arrow keys move between the buttons of a segmented group, as in a radio group.
  body.addEventListener('keydown', (e) => {
    const seg = (e.target as HTMLElement).closest('.segmented button') as HTMLButtonElement | null;
    if (!seg || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const buttons = [...(seg.parentElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button')];
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const next = buttons[(buttons.indexOf(seg) + step + buttons.length) % buttons.length];
    next.focus();
    next.click();
  });

  const allOff = document.getElementById('settings-all-off');
  allOff?.addEventListener('click', () => {
    for (const input of switches()) {
      if (!input.checked) continue;
      input.checked = false;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  const reset = document.getElementById('settings-reset');
  reset?.addEventListener('click', () => {
    try {
      const keys: string[] = [];
      for (let n = 0; n < localStorage.length; n++) {
        const k = localStorage.key(n);
        if (k && isSettingKey(k)) keys.push(k);
      }
      for (const k of keys) localStorage.removeItem(k);
    } catch {
      /* nothing stored to clear */
    }
    location.reload();
  });

  let returnFocus: HTMLElement | null = null;
  const panel = modal.querySelector('.modal-panel') as HTMLElement;

  function show() {
    returnFocus = document.activeElement as HTMLElement | null;
    refresh();
    modal!.hidden = false;
    opener!.setAttribute('aria-expanded', 'true');
    (modal!.querySelector('.modal-close') as HTMLElement | null)?.focus();
  }

  function close() {
    if (modal!.hidden) return;
    modal!.hidden = true;
    opener!.setAttribute('aria-expanded', 'false');
    returnFocus?.focus();
  }

  opener.addEventListener('click', () => (modal.hidden ? show() : close()));
  modal.querySelector('.modal-close')?.addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    // Keep keyboard focus inside the window while it is open.
    const focusable = [...panel.querySelectorAll<HTMLElement>('button, input, select, a[href]')].filter(
      (el) => !el.hidden && el.tabIndex >= 0 && el.offsetParent !== null
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  return { refresh, close };
}
