// Recent searches and favorite airports, kept on this device only (localStorage). Every read and write is guarded:
// storage can be unavailable (private mode, blocked site data) and the app must still work.

const RECENT_KEY = 'zachroute:recent-searches';
export const MAX_RECENT = 8;

function read(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const value = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function write(key: string, list: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* storage full or blocked: recents are a convenience, skip */
  }
}

const sameSearch = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

export function loadRecent(): string[] {
  return read(RECENT_KEY).slice(0, MAX_RECENT);
}

/** Puts a search at the top of the list (moving it if already there), newest first. */
export function addRecent(query: string) {
  const q = query.trim();
  if (!q) return;
  const next = [q, ...read(RECENT_KEY).filter((r) => !sameSearch(r, q))].slice(0, MAX_RECENT);
  write(RECENT_KEY, next);
}

export function clearRecent() {
  write(RECENT_KEY, []);
}

// ---------------------------------------------------------------------------
// Favorite airports (stored as airport codes)
// ---------------------------------------------------------------------------

const FAVORITES_KEY = 'zachroute:favorites';
export const FAVORITES_CHANGED = 'zachroute:favorites-changed';

export function loadFavorites(): string[] {
  return read(FAVORITES_KEY);
}

export function isFavorite(code: string): boolean {
  return loadFavorites().some((c) => sameSearch(c, code));
}

/** Adds or removes an airport; returns whether it is now a favorite. */
export function toggleFavorite(code: string): boolean {
  const list = loadFavorites();
  const on = !list.some((c) => sameSearch(c, code));
  const next = on ? [...list, code.toUpperCase()] : list.filter((c) => !sameSearch(c, code));
  write(FAVORITES_KEY, next);
  try {
    window.dispatchEvent(new CustomEvent(FAVORITES_CHANGED));
  } catch {
    /* no window in tests */
  }
  return on;
}
