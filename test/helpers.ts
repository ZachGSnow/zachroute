import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';

const FIXTURES = path.resolve(__dirname, 'fixtures');

export function fixturePath(name: string): string {
  return path.join(FIXTURES, name);
}

export function readFixture(name: string): string {
  return fs.readFileSync(fixturePath(name), 'utf8');
}

export function jsonFixture<T = any>(name: string): T {
  return JSON.parse(readFixture(name));
}

/**
 * Replaces global fetch. `routes` maps a substring of the requested URL to a body (string or
 * JSON-able value); the first matching entry answers. Unmatched URLs fail the test loudly.
 */
export function stubFetch(routes: Array<[string, unknown]>) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const hit = routes.find(([needle]) => url.includes(needle));
    if (!hit) throw new Error(`Unexpected fetch in test: ${url}`);
    const body = typeof hit[1] === 'string' ? hit[1] : JSON.stringify(hit[1]);
    return new Response(body, { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

/** Minimal Pages Function context: a request and an env with no KV bound. */
export function pagesContext(url: string): any {
  return { request: new Request(url), env: {} };
}

/** Browser globals the client modules touch. */
export function stubBrowser() {
  const store = new Map<string, string>();
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

/** The airport subset fixture with ICAO / FAA-LID string aliases resolved like main.ts does. */
export function loadAirportSubset(): Record<string, any> {
  const data = jsonFixture<Record<string, any>>('airports-subset.json');
  for (const key of Object.keys(data)) {
    if (typeof data[key] === 'string') data[key] = data[data[key]];
  }
  return data;
}
