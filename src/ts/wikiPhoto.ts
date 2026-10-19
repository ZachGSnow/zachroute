// Airport photo from the Wikipedia page summary (same article as the Wikipedia link
// on the card). Requested straight from the browser (the API sends CORS headers) and
// remembered per device, including "no photo", so each airport is looked up once.

const PHOTO_KEY = (title: string) => `zachroute:photo:${title}`;

function titleFromLink(link?: string): string | null {
  if (!link) return null;
  const m = link.match(/\/wiki\/([^?#]+)/);
  return m ? m[1] : null;
}

/**
 * Decoded article title when the link is to English Wikipedia (the only one /api/lore reads),
 * else null. Same rule as titleFromWikipediaLink in shared/wikiLore.js.
 */
export function englishWikiTitle(link?: string): string | null {
  const m = link?.match(/^https?:\/\/en\.(?:m\.)?wikipedia\.org\/wiki\/([^?#]+)/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).replace(/_/g, ' ').trim() || null;
  } catch {
    return null;
  }
}

function readCache(title: string): string | null | undefined {
  try {
    const v = localStorage.getItem(PHOTO_KEY(title));
    if (v === null) return undefined;
    return v === 'none' ? null : v;
  } catch {
    return undefined;
  }
}

function writeCache(title: string, url: string | null) {
  try {
    localStorage.setItem(PHOTO_KEY(title), url ?? 'none');
  } catch {
    /* storage full or blocked: just skip caching */
  }
}

/** Returns the article's thumbnail URL (~320px) for the airport's Wikipedia article, or null. */
/** Path form of an article title, as it appears after /wiki/ in a link. */
export function wikiPath(title: string): string {
  return encodeURIComponent(title.replace(/ /g, '_'));
}

/** Link to the airport's English Wikipedia article: the Wikidata title when there is one, else the OurAirports link. */
export function airportWikiLink(airport: { wikiTitle?: string; wikipediaLink?: string }): string | undefined {
  return airport.wikiTitle ? `https://en.wikipedia.org/wiki/${wikiPath(airport.wikiTitle)}` : airport.wikipediaLink;
}

export async function fetchAirportPhoto(wikipediaLink?: string): Promise<string | null> {
  const title = titleFromLink(wikipediaLink);
  if (!title) return null;

  const cached = readCache(title);
  if (cached !== undefined) return cached;
  if (!navigator.onLine) return null;

  try {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`);
    if (!res.ok) {
      if (res.status === 404) writeCache(title, null);
      return null;
    }
    const json = await res.json();
    const url: string | null = json.thumbnail?.source || null;
    writeCache(title, url);
    return url;
  } catch {
    return null;
  }
}
