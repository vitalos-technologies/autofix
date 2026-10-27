import "server-only";

import { NextResponse } from "next/server";
import type { z } from "zod";

// Response helpers shared by the public booking routes. Error bodies are flat
// (`{ code, message, ... }`) and never echo what the customer typed.

export const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;
/** Booking JSON bodies are small; anything bigger is not a booking. */
export const MAX_JSON_BYTES = 32 * 1024;

export function requesterIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim() || "unknown";
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE_HEADERS, ...headers } });
}

export function errorResponse(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  const headers: Record<string, string> = status === 429 ? { "Retry-After": "600" } : status === 503 ? { "Retry-After": "30" } : {};
  return jsonResponse({ code, message, ...extra }, status, headers);
}

/** Field paths and messages only: never the submitted values. */
export function validationIssues(error: z.ZodError) {
  return error.issues.slice(0, 20).map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
}

export type JsonBody = { ok: true; value: unknown } | { ok: false; status: 400 | 413 | 415 };

/** Reads a JSON body, refusing other content types and oversized bodies. */
export async function readJsonBody(request: Request): Promise<JsonBody> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type.trim())) return { ok: false, status: 415 };
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) return { ok: false, status: 413 };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, status: 400 };
  }
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) return { ok: false, status: 413 };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
}

export function bodyErrorResponse(status: 400 | 413 | 415) {
  if (status === 413) return errorResponse(413, "PAYLOAD_TOO_LARGE", "The request is too large.");
  if (status === 415) return errorResponse(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request as JSON.");
  return errorResponse(400, "INVALID_JSON", "The request could not be read.");
}
