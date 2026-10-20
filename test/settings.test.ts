// The settings window is built from features.ts: every input main.ts wires must come from it,
// and every input it builds must be wired, so nothing is lost or left dead when a layer is added.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FEATURES, SECTIONS, isSettingKey } from '../src/ts/features';
import { settingsHtml } from '../src/ts/settingsPanel';

const main = fs.readFileSync('src/ts/main.ts', 'utf8');
const html = fs.readFileSync('src/index.html', 'utf8');
const built = settingsHtml(new Set());

const ids = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => m[1]);
const wired = ids(main, /getElementById\('([a-z0-9-]+)'\) as HTML(?:Input|Select)Element/g);
const builtInputs = ids(built, /<(?:input|select)[^>]* id="([a-z0-9-]+)"/g);

describe('settings window', () => {
  it('builds every input main.ts wires, and only those', () => {
    const inHtml = new Set(ids(html, /<(?:input|select)[^>]* id="([a-z0-9-]+)"/g));
    const settingsInputs = wired.filter((id) => !inHtml.has(id));
    expect(new Set(builtInputs)).toEqual(new Set(settingsInputs));
    expect(builtInputs).toContain('radar-toggle');
    expect(builtInputs).toContain('distance-unit');
  });

  it('gives each feature a unique id and input, in a known section', () => {
    const sections = new Set(SECTIONS.map((s) => s.id));
    expect(new Set(FEATURES.map((f) => f.id)).size).toBe(FEATURES.length);
    expect(new Set(builtInputs).size).toBe(builtInputs.length);
    for (const f of FEATURES) expect(sections.has(f.section)).toBe(true);
    for (const s of SECTIONS) expect(FEATURES.some((f) => f.section === s.id)).toBe(true);
  });

  it('opens the sections it is told to and folds the rest', () => {
    const open = settingsHtml(new Set(['weather']));
    expect(open).toMatch(/aria-expanded="true" aria-controls="settings-sec-weather"/);
    expect(open).toMatch(/id="settings-sec-map" hidden/);
    expect(open).not.toMatch(/id="settings-sec-weather" hidden/);
  });

  it('shows switches as switches and options as segmented buttons over a select', () => {
    expect(built).toMatch(/<input type="checkbox" role="switch" class="switch" id="radar-toggle" \/>/);
    expect(built).toMatch(/<div class="setting-option" data-for="radar-toggle" hidden>/);
    expect(built).toMatch(/data-input="radar-mode"[^]*<select id="radar-mode" hidden><option value="precip">/);
  });

  it('keeps the storage keys of earlier versions, and reset leaves favorites and history', () => {
    for (const key of ['show-radar', 'show-large', 'radar-mode', 'tcf-step', 'distance-unit', 'clock', 'weather-units', 'settings-open']) {
      expect(isSettingKey(`zachroute:${key}`)).toBe(true);
    }
    for (const key of ['favorites', 'recent-searches', 'sheet-state']) expect(isSettingKey(`zachroute:${key}`)).toBe(false);
    expect(isSettingKey('other:show-radar')).toBe(false);
    // The keys main.ts reads are the ones reset clears.
    for (const key of ids(main, /'zachroute:((?:show-|[a-z]+-(?:step|day|kind|mode))[a-z-]*)'/g)) {
      expect(isSettingKey(`zachroute:${key}`)).toBe(true);
    }
  });
});
