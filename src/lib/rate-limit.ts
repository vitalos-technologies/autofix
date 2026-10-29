import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/server";

const localBuckets = new Map<string, { count: number; resetAt: number }>();

/**
 * SHA-256 of "<UTC day>:<value>": how rate_limit_buckets keys an identifier. Also stored as
 * platform_enquiries.ip_hash, so it links one source's requests on one day and nothing more.
 */
export function rateLimitIdentifierHash(value: string, now: Date = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return createHash("sha256").update(`${day}:${value}`).digest("hex");
}

export async function consumeRateLimit(identifier: string, scope: string, limit = 10, windowSeconds = 60) {
  const key = rateLimitIdentifierHash(identifier);
  const admin = process.env.PLAYWRIGHT_TEST === "true" ? null : createAdminClient();

  if (admin) {
    const { data, error } = await admin.rpc("consume_rate_limit", {
      identifier_hash: key,
      limit_scope: scope,
      request_limit: limit,
      window_seconds: windowSeconds,
    });
    if (!error && typeof data === "boolean") return data;
  }

  const now = Date.now();
  const compound = `${scope}:${key}`;
  const bucket = localBuckets.get(compound);
  if (!bucket || bucket.resetAt <= now) {
    localBuckets.set(compound, { count: 1, resetAt: now + windowSeconds * 1000 });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}
