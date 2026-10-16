import * as SunCalc from 'suncalc';

/**
 * Formats "current local time" at an airport, e.g. "3:42 PM EDT".
 * Computed live from the IANA time zone resolved offline at build time
 * (scripts/etl_ourairports.js via geo-tz), so DST is always correct -
 * no stored UTC offset to go stale.
 */
export function localTimeLabel(timeZone?: string): string | null {
  if (!timeZone) return null;
  try {
    const now = new Date();
    const time = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(now);
    const zoneAbbrev = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'short',
    })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value;
    return zoneAbbrev ? `${time} ${zoneAbbrev}` : time;
  } catch {
    return null;
  }
}

/**
 * Returns the next sunrise/sunset transition at a location, e.g.
 * "Sunset 7:52 PM" during the day or "Sunrise 6:40 AM" at night.
 * Pure astronomical calculation (SunCalc) - no API call, no key, never stale.
 */
export function nextDaylightEventLabel(
  lat: number,
  lon: number,
  timeZone?: string
): string | null {
  try {
    const now = new Date();
    const today = SunCalc.getTimes(now, lat, lon);

    // At extreme latitudes the sun can stay up (or down) all day, in which
    // case SunCalc returns null for that transition - just skip the line.
    if (!today.sunrise || !today.sunset) return null;

    let label: string;
    let when: Date;

    if (now < today.sunrise) {
      label = 'Sunrise';
      when = today.sunrise;
    } else if (now < today.sunset) {
      label = 'Sunset';
      when = today.sunset;
    } else {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowSunrise = SunCalc.getTimes(tomorrow, lat, lon).sunrise;
      if (!tomorrowSunrise) return null;
      label = 'Sunrise';
      when = tomorrowSunrise;
    }

    const formatted = timeZone
      ? new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(when)
      : new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(when);

    return `${label} ${formatted}`;
  } catch {
    return null;
  }
}

/**
 * Moon phase + illumination, purely for flavor. Free byproduct of SunCalc,
 * which we already depend on for sunrise/sunset - no new dependency.
 */
export function moonPhaseLabel(date: Date = new Date()): string | null {
  try {
    const illum = SunCalc.getMoonIllumination(date);
    const pct = Math.round(illum.fraction * 100);
    const phase = illum.phase;

    let name: string;
    let emoji: string;
    if (phase < 0.03 || phase > 0.97) {
      name = 'New moon';
      emoji = '🌑';
    } else if (phase < 0.22) {
      name = 'Waxing crescent';
      emoji = '🌒';
    } else if (phase < 0.28) {
      name = 'First quarter';
      emoji = '🌓';
    } else if (phase < 0.47) {
      name = 'Waxing gibbous';
      emoji = '🌔';
    } else if (phase < 0.53) {
      name = 'Full moon';
      emoji = '🌕';
    } else if (phase < 0.72) {
      name = 'Waning gibbous';
      emoji = '🌖';
    } else if (phase < 0.78) {
      name = 'Last quarter';
      emoji = '🌗';
    } else {
      name = 'Waning crescent';
      emoji = '🌘';
    }

    return `${emoji} ${name} (${pct}%)`;
  } catch {
    return null;
  }
}

/** Whether it's currently daytime at a location - used to pick a clear-sky sun/moon emoji. */
export function isDaytime(lat: number, lon: number): boolean {
  try {
    const now = new Date();
    const times = SunCalc.getTimes(now, lat, lon);
    if (!times.sunrise || !times.sunset) return true;
    return now >= times.sunrise && now < times.sunset;
  } catch {
    return true;
  }
}

/**
 * Current UTC offset (in minutes) for an IANA time zone, resolved live so DST
 * is always correct. Used to compute the time-zone difference between two
 * airports in route view.
 */
export function utcOffsetMinutes(timeZone: string, date: Date = new Date()): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
    }).formatToParts(date);
    const offsetPart = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (!offsetPart) return null;
    const match = offsetPart.match(/GMT([+-])(\d+)(?::(\d+))?/);
    if (!match) return 0;
    const sign = match[1] === '-' ? -1 : 1;
    const hours = parseInt(match[2], 10);
    const minutes = match[3] ? parseInt(match[3], 10) : 0;
    return sign * (hours * 60 + minutes);
  } catch {
    return null;
  }
}
