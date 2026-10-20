// The Help panel covers every setting, and About credits every source the README lists, so neither
// falls behind when a layer or a source is added.
import fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { stubBrowser } from './helpers';
import { FEATURES } from '../src/ts/features';
import { HELP, TOPICS, helpHtml } from '../src/ts/help';
import { settingsHtml } from '../src/ts/settingsPanel';

beforeEach(() => {
  stubBrowser();
});

describe('Help', () => {
  it('has an entry for every setting, and every info button lands on one', () => {
    const html = helpHtml();
    for (const f of FEATURES) {
      expect(HELP[f.id], f.id).toBeDefined();
      expect(html).toContain(`data-help-entry="${f.id}"`);
    }
    const infos = [...settingsHtml(new Set()).matchAll(/data-help="([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(infos.length).toBe(FEATURES.length);
    for (const id of infos) expect(html).toContain(`id="help-${id}"`);
  });

  it('starts with the topics and shows the layers in their own colors', () => {
    const html = helpHtml();
    expect(html.indexOf('help-start')).toBeLessThan(html.indexOf('help-terrain'));
    expect(TOPICS.map((t) => t.id)).toEqual(['start', 'airport-card', 'route-card', 'live', 'severity', 'limits']);
    const radar = html.slice(html.indexOf('id="help-radar"'), html.indexOf('id="help-satellite"'));
    expect(radar).toContain('lg-row');
    expect(radar).toContain('Storm tops');
    expect(html).toContain('Not for navigation');
  });

  it('gives every entry a unique id', () => {
    const ids = [...helpHtml().matchAll(/id="(help-[a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('About', () => {
  const readme = fs.readFileSync('README.md', 'utf8');
  const html = fs.readFileSync('src/index.html', 'utf8');
  const about = html.slice(html.indexOf('<div id="about-modal"'), html.indexOf('<div class="main-content">'));
  const hosts = (text: string) => new Set([...text.matchAll(/https?:\/\/([^/)"\s]+)/g)].map((m) => m[1].replace(/^www\./, '')));

  it('links every source in the README data source table', () => {
    const table = readme.slice(readme.indexOf('## Data sources, freshness and licenses'), readme.indexOf('\n## ', readme.indexOf('## Data sources, freshness and licenses') + 5));
    const sourceCells = table
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| Data |'))
      .map((l) => l.split('|')[2] || '');
    const readmeHosts = hosts(sourceCells.join(' '));
    expect(readmeHosts.size).toBeGreaterThan(20);
    const aboutHosts = hosts(about);
    const missing = [...readmeHosts].filter((h) => !aboutHosts.has(h));
    expect(missing).toEqual([]);
  });

  it('has the header Help button and the window it opens', () => {
    expect(html).toContain('id="help-open"');
    expect(html).toContain('id="help-modal"');
    expect(html).toContain('id="help-search"');
  });
});
