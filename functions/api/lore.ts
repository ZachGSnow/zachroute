import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/lore?iata=XXX
// Resolves Wikipedia summary via search + summary endpoints and caches in KV

interface Env {
  LORE_KV?: KVNamespace;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const iata = url.searchParams.get('iata')?.toUpperCase();

  if (!iata) {
    return new Response(JSON.stringify({ error: 'Missing iata parameter' }), { status: 400 });
  }

  const cacheKey = `lore:${iata}`;

  // Check KV first (if bound)
  if (context.env.LORE_KV) {
    const cached = await context.env.LORE_KV.get(cacheKey, { type: 'json' });
    if (cached) {
      return new Response(JSON.stringify(cached), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
      });
    }
  }

  try {
    // Step 1: Search Wikipedia for the airport page
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(iata + ' airport')}&format=json&origin=*`;
    const searchRes = await fetch(searchUrl, {
      headers: { 'User-Agent': USER_AGENT }
    });
    const searchJson: any = await searchRes.json();
    const pageTitle = searchJson.query?.search?.[0]?.title;

    if (!pageTitle) {
      return new Response(JSON.stringify({ error: 'No Wikipedia page found' }), { status: 404 });
    }

    // Step 2: Fetch summary
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`;
    const summaryRes = await fetch(summaryUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': USER_AGENT
      },
    });
    if (!summaryRes.ok) {
      return new Response(JSON.stringify({ error: 'Wikipedia summary request failed', status: summaryRes.status }), { status: 502 });
    }
    const summary: any = await summaryRes.json();

    const result = {
      iata,
      title: summary.title,
      extract: summary.extract,
      thumbnail: summary.thumbnail?.source || null,
      url: summary.content_urls?.desktop?.page || null,
    };

    // Cache in KV (7 days) if bound
    if (context.env.LORE_KV) {
      await context.env.LORE_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 604800 });
    }

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Wikipedia lookup failed' }), { status: 502 });
  }
};