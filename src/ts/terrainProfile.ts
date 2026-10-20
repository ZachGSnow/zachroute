// Route terrain profile: terrain height along a direct route (from /api/elevation) with the
// forecast freezing level from the cruise-wind request, as a small SVG chart for the route card.
// Airliners cruise far above terrain, but the highest ground decides the escape plan after a
// depressurization or engine failure, and the freezing level against the terrain shows where
// mountain tops in cloud ice up.

export interface ElevationProfile {
  points: [number, number][];
  elevationsM: number[];
  spacingMi: number;
}

const M_TO_FT = 3.28084;

export function fetchTerrainProfile(from: { lat: number; lon: number }, to: { lat: number; lon: number }): Promise<ElevationProfile | null> {
  const q = (p: { lat: number; lon: number }) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
  return fetch(`/api/elevation?from=${q(from)}&to=${q(to)}`)
    .then((res) => (res.ok ? (res.json() as Promise<ElevationProfile>) : null))
    .catch(() => null);
}

/** Highest sample: feet and miles from the origin. */
export function highestPoint(p: ElevationProfile): { ft: number; mi: number } {
  let best = 0;
  p.elevationsM.forEach((m, i) => {
    if (m > p.elevationsM[best]) best = i;
  });
  return { ft: Math.round(p.elevationsM[best] * M_TO_FT), mi: Math.round(best * p.spacingMi) };
}

/** Freezing level at a fraction of the route, interpolated between evenly spaced samples. */
export function freezingAt(levelsFt: number[], frac: number): number {
  if (levelsFt.length === 1) return levelsFt[0];
  const x = Math.max(0, Math.min(1, frac)) * (levelsFt.length - 1);
  const i = Math.min(levelsFt.length - 2, Math.floor(x));
  return levelsFt[i] + (levelsFt[i + 1] - levelsFt[i]) * (x - i);
}

/** Miles of route where the freezing level is at or below the terrain (ice on the ground and on mountain tops in cloud). */
export function frozenTerrainMiles(p: ElevationProfile, levelsFt: number[]): number {
  if (!levelsFt.length) return 0;
  const n = p.elevationsM.length;
  const frozen = p.elevationsM.filter((m, i) => m > 0 && freezingAt(levelsFt, i / (n - 1)) <= m * M_TO_FT).length;
  return Math.round(frozen * p.spacingMi);
}

/** A round axis top in feet: the next 5,000 above the highest of terrain and freezing level. */
export function axisTopFt(maxFt: number): number {
  return Math.max(5000, Math.ceil((maxFt + 500) / 5000) * 5000);
}

const W = 300;
const H = 90;
const PAD_L = 30;
const PAD_B = 14;

/** SVG chart: terrain (gray), freezing level (blue line), terrain above it (pale blue), highest point marked. */
export function profileSvg(p: ElevationProfile, levelsFt: number[], originCode: string, destCode: string): string {
  const n = p.elevationsM.length;
  const ft = p.elevationsM.map((m) => m * M_TO_FT);
  const fz = levelsFt.length ? ft.map((_, i) => freezingAt(levelsFt, i / (n - 1))) : [];
  const top = axisTopFt(Math.max(...ft, ...(fz.length ? fz : [0])));
  const x = (i: number) => PAD_L + ((W - PAD_L - 2) * i) / (n - 1);
  const y = (v: number) => (H - PAD_B) - ((H - PAD_B - 4) * Math.max(0, Math.min(top, v))) / top;
  const r = (v: number) => v.toFixed(1);
  const terrain = `M${r(x(0))},${r(y(0))} ${ft.map((v, i) => `L${r(x(i))},${r(y(v))}`).join(' ')} L${r(x(n - 1))},${r(y(0))} Z`;
  // Terrain above the freezing level, filled between the two lines.
  let frozen = '';
  if (fz.length) {
    for (let i = 0; i < n - 1; i++) {
      if (ft[i] > fz[i] || ft[i + 1] > fz[i + 1]) {
        const a = Math.max(ft[i], fz[i]);
        const b = Math.max(ft[i + 1], fz[i + 1]);
        frozen += `M${r(x(i))},${r(y(fz[i]))} L${r(x(i))},${r(y(a))} L${r(x(i + 1))},${r(y(b))} L${r(x(i + 1))},${r(y(fz[i + 1]))} Z `;
      }
    }
  }
  const freezingLine = fz.length ? `<polyline points="${fz.map((v, i) => `${r(x(i))},${r(y(v))}`).join(' ')}" fill="none" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="4 3"/>` : '';
  const hi = highestPoint(p);
  const hiIndex = p.elevationsM.indexOf(Math.max(...p.elevationsM));
  const ticks = [0, top / 2, top]
    .map((v) => `<text x="${PAD_L - 3}" y="${r(y(v) + 3)}" text-anchor="end" class="tp-axis">${v === 0 ? '0' : `${Number((v / 1000).toFixed(1))}k`}</text>`)
    .join('');
  return (
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Terrain along the route: highest ${hi.ft.toLocaleString()} ft" class="tp-chart">` +
    ticks +
    `<path d="${terrain}" fill="#64748b" fill-opacity="0.55" stroke="#94a3b8" stroke-width="0.8"/>` +
    (frozen ? `<path d="${frozen}" fill="#bae6fd" fill-opacity="0.75"/>` : '') +
    freezingLine +
    (hi.ft > 0 ? `<circle cx="${r(x(hiIndex))}" cy="${r(y(ft[hiIndex]))}" r="2.2" fill="#f8fafc"/>` : '') +
    `<text x="${PAD_L}" y="${H - 2}" class="tp-axis">${originCode}</text>` +
    `<text x="${W - 2}" y="${H - 2}" text-anchor="end" class="tp-axis">${destCode}</text>` +
    `</svg>`
  );
}
