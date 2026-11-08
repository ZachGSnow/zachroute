// public/_headers sets the Content Security Policy for the static app. These checks keep it and
// index.html in step: the policy only allows the site's own scripts, so the page must not grow an
// inline script or a CDN tag.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const headers = fs.readFileSync(path.join(root, 'public/_headers'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');

function header(name: string): string {
  const line = headers.split(/\r?\n/).find((l) => l.trim().toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? line.slice(line.indexOf(':') + 1).trim() : '';
}

function directives(): Map<string, string[]> {
  return new Map(
    header('Content-Security-Policy')
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((p) => p[0])
      .map((p) => [p[0], p.slice(1)])
  );
}

describe('security headers (public/_headers)', () => {
  it('apply to every static path', () => {
    expect(headers).toMatch(/^\/\*\s*$/m);
  });

  it('allow scripts only from the site itself', () => {
    const csp = directives();
    expect(csp.get('script-src')).toEqual(["'self'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'self'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('leave out upgrade-insecure-requests, which breaks the service worker on a local http server', () => {
    expect(directives().has('upgrade-insecure-requests')).toBe(false);
  });

  it('send nosniff, a referrer policy and geolocation for this site only', () => {
    expect(header('X-Content-Type-Options')).toBe('nosniff');
    expect(header('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(header('Permissions-Policy')).toContain('geolocation=(self)');
  });
});

describe('index.html under that policy', () => {
  it('has no inline script and no script or stylesheet from another host', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const attrs of scripts) expect(attrs).toMatch(/\bsrc="\/[^/]/);
    const links = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)].map((m) => m[0]);
    for (const link of links) expect(link).not.toMatch(/href="https?:/);
  });

  it('has no inline event handlers', () => {
    expect(html).not.toMatch(/\son[a-z]+="/i);
  });
});
