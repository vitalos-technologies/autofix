import "server-only";

import { NextResponse } from "next/server";
import { getAllowedPlatformAdmin, type PlatformAdmin } from "@/lib/platform/access";
import { PlatformError } from "@/lib/platform/store";

const NO_STORE = { "cache-control": "no-store" };
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** Same answer as for a route that does not exist: the platform API is never revealed. */
export function notFoundJson() {
  return json({ error: "NOT_FOUND" }, 404);
}

/**
 * Mutations must be same-origin JSON: the content type forces a CORS preflight and the Origin, when sent,
 * must be this host. Cookies carry the session, so this is the CSRF check.
 */
export function isSameOriginJson(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === (request.headers.get("host") ?? new URL(request.url).host);
  } catch {
    return false;
  }
}

/** Runs `handler` for a platform admin at AAL2; 404 for everyone else; maps PlatformError codes to 4xx. */
export async function withPlatformAdmin(request: Request, handler: (admin: PlatformAdmin) => Promise<Response>, options: { mutation?: boolean } = {}) {
  const admin = await getAllowedPlatformAdmin();
  if (!admin) return notFoundJson();
  if (options.mutation && !isSameOriginJson(request)) return json({ error: "BAD_REQUEST" }, 400);
  try {
    return await handler(admin);
  } catch (error) {
    if (error instanceof PlatformError) {
      if (error.code === "FORBIDDEN") return notFoundJson();
      if (error.code === "GARAGE_NOT_FOUND") return json({ error: error.code }, 404);
      if (error.code.startsWith("INVALID") || error.code === "NOTHING_TO_CHANGE") return json({ error: error.code }, 422);
    }
    return json({ error: "UNAVAILABLE" }, 503);
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
