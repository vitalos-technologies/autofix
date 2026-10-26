// Small HTTP helpers shared by the vehicle data clients.
//
// Privacy: upstream URLs can contain a registration (DVSA puts it in the path),
// so errors thrown by fetch are never re-thrown, attached as a cause or logged.
// Clients turn every failure into a VehicleLookupError carrying codes only.

export type FetchLike = typeof fetch;

export type JsonResponse = {
  status: number;
  ok: boolean;
  headers: Headers;
  /** Parsed JSON body, or null when the body is empty or not JSON. */
  body: unknown;
};

/** Fetch and read a JSON body inside one timeout, so a stalled body cannot hang the lookup. */
export async function requestJson(
  fetchImpl: FetchLike,
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<JsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal, cache: "no-store" });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, ok: response.ok, headers: response.headers, body };
  } finally {
    clearTimeout(timer);
  }
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date. Capped at 24 hours. */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, DAY_MS);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(0, date - nowMs), DAY_MS);
}

/**
 * After a 429 the source is skipped until the cooldown passes, so a burst of
 * customer lookups does not keep hammering a provider that has asked us to stop.
 */
export class Cooldown {
  private until = 0;

  constructor(private readonly now: () => number) {}

  remainingMs() {
    return Math.max(0, this.until - this.now());
  }

  extend(ms: number) {
    this.until = Math.max(this.until, this.now() + Math.max(0, ms));
  }
}

export type TokenBucket = { take(): Promise<void> };

/**
 * In-process token bucket: at most `burst` calls at once, refilled at
 * `ratePerSecond`. Calls queue in order. Each serverless instance has its own
 * bucket, which is what a batch job (one invocation) needs.
 */
export function createTokenBucket(options: {
  ratePerSecond: number;
  burst: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): TokenBucket {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let tokens = options.burst;
  let last = now();
  let chain: Promise<void> = Promise.resolve();

  function refill() {
    const current = now();
    tokens = Math.min(options.burst, tokens + ((current - last) / 1000) * options.ratePerSecond);
    last = current;
  }

  return {
    take() {
      const turn = chain.then(async () => {
        refill();
        if (tokens < 1) {
          await sleep(Math.ceil(((1 - tokens) / options.ratePerSecond) * 1000));
          refill();
          tokens = Math.max(tokens, 1);
        }
        tokens -= 1;
      });
      chain = turn.catch(() => undefined);
      return turn;
    },
  };
}

/** A string field, trimmed, or undefined. */
export function stringField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
