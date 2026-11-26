/**
 * Back navigation for detail pages. A page that opens another passes where it is, list filters
 * and page included: `navigate(to, { state: { from: pathname + search } })`. The detail page's
 * Back button returns there, or to `fallback` when opened directly (a deep link, a new tab).
 */

/** Router location state carrying the path a page was opened from. */
export interface FromState {
  from: string;
}

/** The in-app path in `state.from`, else `fallback`. Only same-app paths ("/…") are used. */
export function backPath(state: unknown, fallback: string): string {
  const from = (state as Partial<FromState> | null)?.from;
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//')
    ? from
    : fallback;
}
