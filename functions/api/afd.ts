import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/afd?lat=..&lon=..
// The aviation section of the National Weather Service forecast discussion (US only): the
// forecaster's own notes on what to expect for flying, written about four times a day.
// api.weather.gov /points gives the forecast office for a position (cached 30 days), then the
// office's latest discussion (cached 30 minutes) is cut down to its .AVIATION section.

interface Env {
  LORE_KV?: KVNamespace;
}

const OFFICE_TTL_SECONDS = 30 * 24 * 3600;
const AFD_TTL_SECONDS = 1800;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
  });

/**
 * The .AVIATION section of a forecast discussion as paragraphs, without its header line, the
 * "Issued at" line or the forecaster's sign-off. Null when there is no such section.
 */
export function aviationSection(text: string): { heading: string; paragraphs: string[] } | null {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => /^\.AVIATION\b/.test(l.trim()));
  if (start < 0) return null;
  // "/18Z TAFS THROUGH 00Z WEDNESDAY/" or similar after the name, when present.
  const heading = lines[start].trim().replace(/^\.AVIATION\s*/, '').replace(/^\/|\/?\.{3}$|\/$/g, '').trim();
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^&&/.test(l.trim()) || /^\.[A-Z][A-Z /]+\.{3}/.test(l.trim()) || /^\$\$/.test(l.trim())) break;
    // Offices differ: some put "(18Z TAFS)" or "Issued at ..." on lines of their own inside the first paragraph.
    if (/^\s*Issued at /i.test(l) || /^\s*\(\s*\d{2}Z TAFS?\s*\)\s*$/i.test(l)) continue;
    body.push(l);
  }
  const paragraphs = body
    .join('\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter((p) => p && !/^Issued at /i.test(p))
    // The last short line is the forecaster's name.
    .filter((p, i, all) => !(i === all.length - 1 && /^[A-Za-z.'-]+( [A-Za-z.'-]+)?$/.test(p)));
  return paragraphs.length ? { heading, paragraphs } : null;
}

async function getJson(url: string): Promise<any | null> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' } });
  if (!res.ok) return null;
  return res.json();
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const params = new URL(context.request.url).searchParams;
  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return json({ error: 'lat and lon are required' }, 400);
  }
  const kv = context.env.LORE_KV;
  const point = `${lat.toFixed(2)},${lon.toFixed(2)}`;

  try {
    // 1. Forecast office for the position (outside the US, weather.gov answers 404).
    let office: { id: string; name?: string } | null = null;
    const officeKey = `afd:office:v2:${point}`;
    if (kv) office = await kv.get(officeKey, { type: 'json' });
    if (!office) {
      const p = await getJson(`https://api.weather.gov/points/${point}`);
      // cwa is the office that writes the discussion; gridId can differ (Alaska's grids are AER/ALU).
      const id = p?.properties?.cwa || p?.properties?.gridId;
      if (!id) return json({ available: false });
      const city = p?.properties?.relativeLocation?.properties?.city;
      office = { id, name: undefined };
      const officeInfo = await getJson(`https://api.weather.gov/offices/${id}`).catch(() => null);
      office.name = officeInfo?.name || (city ? `near ${city}` : undefined);
      if (kv) await kv.put(officeKey, JSON.stringify(office), { expirationTtl: OFFICE_TTL_SECONDS });
    }

    // 2. That office's latest discussion, cut to the aviation section.
    const afdKey = `afd:text:v2:${office.id}`;
    const cached = kv ? await kv.get(afdKey, { type: 'json' }) : null;
    if (cached) return json(cached);

    const list = await getJson(`https://api.weather.gov/products/types/AFD/locations/${office.id}`);
    const latest = list?.['@graph']?.[0];
    if (!latest?.id) return json({ available: false });
    const product = await getJson(`https://api.weather.gov/products/${latest.id}`);
    const section = aviationSection(product?.productText || '');
    const result = section
      ? { available: true, office: office.id, officeName: office.name, issued: product.issuanceTime || latest.issuanceTime, ...section }
      : { available: false, office: office.id };
    if (kv) await kv.put(afdKey, JSON.stringify(result), { expirationTtl: AFD_TTL_SECONDS });
    return json(result);
  } catch (err: any) {
    return json({ available: false, error: err.message || 'NWS lookup failed' });
  }
};
