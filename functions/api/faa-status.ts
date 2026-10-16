import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/faa-status
// FAA National Airspace System status (ground delay programs, ground stops,
// general arrival/departure delays) keyed by 3-letter US airport code. Free, no key.
// The upstream feed is XML; this parses just the delay lists. Airport closures are
// ignored on purpose: the feed lumps partial (GA-only, hours-limited) NOTAM closures
// in with real ones, which would be misleading on a card. KV-cached 5 minutes.

interface Env {
  LORE_KV?: KVNamespace;
}

const CACHE_KEY = 'faastatus:all';
const CACHE_TTL_SECONDS = 300;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' },
  });

function tag(block: string, name: string): string | undefined {
  // The tag name must end at whitespace or ">", so <Delay> does not also match <Delay_type>.
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : undefined;
}

function blocks(xml: string, name: string): string[] {
  return Array.from(xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>`, 'g'))).map((m) => m[0]);
}

interface AirportStatus {
  groundStop?: { reason?: string; endTime?: string };
  groundDelay?: { reason?: string; avg?: string; max?: string };
  delay?: { reason?: string; type?: string; min?: string; max?: string; trend?: string };
}

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.env.LORE_KV) {
    const cached = await context.env.LORE_KV.get(CACHE_KEY, { type: 'json' });
    if (cached) return json(cached);
  }

  try {
    const res = await fetch('https://nasstatus.faa.gov/api/airport-status-information', {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return json({ available: false, airports: {} });

    const xml = await res.text();
    const airports: Record<string, AirportStatus> = {};
    const entry = (code: string) => (airports[code] = airports[code] || {});

    for (const g of blocks(xml, 'Ground_Delay')) {
      const code = tag(g, 'ARPT');
      if (code) entry(code).groundDelay = { reason: tag(g, 'Reason'), avg: tag(g, 'Avg'), max: tag(g, 'Max') };
    }
    for (const p of blocks(xml, 'Program')) {
      const code = tag(p, 'ARPT');
      if (code) entry(code).groundStop = { reason: tag(p, 'Reason'), endTime: tag(p, 'End_Time') };
    }
    for (const d of blocks(xml, 'Delay')) {
      const code = tag(d, 'ARPT');
      if (!code) continue;
      const typeMatch = d.match(/<Arrival_Departure Type="([^"]+)"/);
      entry(code).delay = {
        reason: tag(d, 'Reason'),
        type: typeMatch ? typeMatch[1] : undefined,
        min: tag(d, 'Min'),
        max: tag(d, 'Max'),
        trend: tag(d, 'Trend'),
      };
    }

    const result = { available: true, updated: tag(xml, 'Update_Time'), airports };
    if (context.env.LORE_KV) {
      await context.env.LORE_KV.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
    }
    return json(result);
  } catch (err: any) {
    return json({ available: false, airports: {}, error: err.message || 'FAA status lookup failed' });
  }
};
