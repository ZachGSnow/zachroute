// A small "Severe"-style pill for cards and lists, colored like the map.

import { severityColor, severityName, type Severity } from './severity';

export function severityBadge(s: Severity): string {
  return `<span class="sev-badge" style="--c:${severityColor(s)}">${severityName(s)}</span>`;
}
