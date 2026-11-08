// Text from upstream feeds and crowd-edited datasets is escaped before it reaches the page.
import { describe, expect, it } from 'vitest';
import { stubBrowser, stubFetch } from './helpers';
import { escapeHtml } from '../src/ts/escapeHtml';
import { fetchPirepLines } from '../src/ts/advisories';

const HOSTILE = '<img src=x onerror="alert(1)">';

describe('escapeHtml', () => {
  it('escapes the five characters that matter between tags and in quoted attributes', () => {
    expect(escapeHtml(`a & b < c > d "e" 'f'`)).toBe('a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;');
  });

  it('turns missing values into an empty string and numbers into text', () => {
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(250)).toBe('250');
  });

  it('leaves plain text alone', () => {
    expect(escapeHtml('Moderate turbulence (rough ride)')).toBe('Moderate turbulence (rough ride)');
  });
});

describe('pilot reports on the airport card', () => {
  it('escape the aircraft type a pilot typed', async () => {
    stubBrowser();
    stubFetch([
      [
        '/api/pireps?icao=KORD',
        { available: true, reports: [{ obsTime: Math.floor(Date.now() / 1000) - 600, acType: HOSTILE, lat: 41.98, lon: -87.9, fltLvl: 120, turb: 'MOD' }] },
      ],
    ]);
    const lines = await fetchPirepLines({ icao: 'KORD', lat: 41.9786, lon: -87.9048 } as any);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).not.toContain('<img');
    expect(lines[0].text).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    // The markup the app adds itself still renders.
    expect(lines[0].text).toContain('<span class="muted">');
  });
});
