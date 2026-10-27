"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

export type NotificationRefresherProps = {
  /** The count the server rendered (the bell badge). */
  count: number;
  /** Authenticated count route; answers `{ count }`. */
  endpoint?: string;
  /** Poll interval in ms (default 20 s). */
  intervalMs?: number;
};

/**
 * Keeps the bell and the Bookings badge current: polls the notification count (every 20 s, and
 * when the tab comes back into view) and refreshes the server-rendered admin when it changes, so a
 * new online booking shows up without a reload. Renders nothing.
 */
export function NotificationRefresher({ count, endpoint = "/api/admin/notifications/count", intervalMs = 20_000 }: NotificationRefresherProps) {
  const router = useRouter();
  const known = useRef(count);

  useEffect(() => {
    known.current = count;
  }, [count]);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const response = await fetch(endpoint, { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as { count?: unknown };
        if (cancelled || typeof payload.count !== "number" || payload.count === known.current) return;
        known.current = payload.count;
        router.refresh();
      } catch {
        // Keep the last known count; the next poll tries again.
      }
    }

    function checkWhenVisible() {
      if (document.visibilityState === "visible") void check();
    }

    const timer = window.setInterval(() => void check(), intervalMs);
    window.addEventListener("focus", checkWhenVisible);
    document.addEventListener("visibilitychange", checkWhenVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", checkWhenVisible);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [endpoint, intervalMs, router]);

  return null;
}
