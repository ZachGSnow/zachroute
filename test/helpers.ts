import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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

/**
 * Decodes an 8-bit RGBA, non-interlaced PNG fixture (what the radar tile servers send) to raw
 * pixels, since Node has no canvas.
 */
export function decodeRgbaPng(name: string): { width: number; height: number; data: Uint8ClampedArray } {
  const buf = fs.readFileSync(fixturePath(name));
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error(`${name}: not 8-bit RGBA non-interlaced`);
    } else if (type === 'IDAT') idat.push(body);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? out[y * stride + i - 4] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= 4 && y > 0 ? out[(y - 1) * stride + i - 4] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + i] = v & 255;
    }
  }
  return { width, height, data: out };
}

/** The airport subset fixture with ICAO / FAA-LID string aliases resolved like main.ts does. */
export function loadAirportSubset(): Record<string, any> {
  const data = jsonFixture<Record<string, any>>('airports-subset.json');
  for (const key of Object.keys(data)) {
    if (typeof data[key] === 'string') data[key] = data[data[key]];
  }
  return data;
}
