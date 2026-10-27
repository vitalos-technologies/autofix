/** Which nav href the current page belongs to. Pure; shared by the server nav and the client `NavLink`. */

function trimSlash(path: string) {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** Path and query, without the hash or a trailing slash. */
function withoutHash(href: string) {
  const [beforeHash = href] = href.split("#");
  const [path = beforeHash, query] = beforeHash.split("?");
  return query === undefined ? trimSlash(path) : `${trimSlash(path)}?${query}`;
}

function pathOf(href: string) {
  return trimSlash(href.split(/[?#]/)[0] ?? href);
}

/**
 * The href among `hrefs` that `activeHref` belongs to: an exact match (then one that differs only
 * by `#hash`), otherwise the longest plain path it sits under (`/app/bookings/123` →
 * `/app/bookings`). Top-level hrefs (`/app`) only match exactly, so they do not light up for
 * every page.
 */
export function resolveActiveHref(hrefs: readonly string[], activeHref: string): string | null {
  const exact = hrefs.find((href) => href === activeHref);
  if (exact) return exact;
  const active = withoutHash(activeHref);
  const sameTarget = hrefs.find((href) => withoutHash(href) === active);
  if (sameTarget) return sameTarget;
  const activePath = pathOf(activeHref);
  let best: string | null = null;
  for (const href of hrefs) {
    if (href.includes("?")) continue;
    const path = pathOf(href);
    if (path.split("/").filter(Boolean).length < 2) continue;
    if (activePath.startsWith(`${path}/`) && (!best || path.length > pathOf(best).length)) best = href;
  }
  return best;
}
