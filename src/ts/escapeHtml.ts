/**
 * Escapes text for use in HTML, both between tags and inside a quoted attribute. Every string from
 * an upstream feed or a crowd-edited dataset (OurAirports, OpenFlights) goes through this before it
 * reaches innerHTML, a Leaflet popup or a tooltip.
 */
export function escapeHtml(text: string | number | null | undefined): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
