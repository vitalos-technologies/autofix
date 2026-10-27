import { vi } from "vitest";

// Test-only HTTP fakes for the vehicle clients. No network is ever touched.

export type FetchCall = { url: string; init: RequestInit };
type Reply = Response | Error;

export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** A fetch that answers with `handler(call)`; Errors are thrown like network failures. */
export function fakeFetch(handler: (call: FetchCall) => Reply | Promise<Reply>) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const reply = await handler(call);
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { fetch: fn as unknown as typeof fetch, calls, fn };
}

/** A fetch that answers with each reply in turn. */
export function queuedFetch(...replies: Reply[]) {
  const queue = [...replies];
  return fakeFetch(() => queue.shift() ?? new Error("unexpected extra request"));
}

export function header(call: FetchCall | undefined, name: string) {
  return new Headers(call?.init.headers).get(name);
}

export function formOf(call: FetchCall | undefined) {
  return Object.fromEntries(new URLSearchParams(String(call?.init.body ?? "")));
}

/** A controllable clock. */
export function fakeClock(startIso = "2026-10-26T09:00:00.000Z") {
  let current = Date.parse(startIso);
  return {
    now: () => current,
    date: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
    set(iso: string) {
      current = Date.parse(iso);
    },
  };
}

/** Everything an error exposes, for "the registration never appears" checks. */
export function describeError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  return [error.message, String(error), error.stack ?? "", JSON.stringify(error), JSON.stringify({ ...error }), String(error.cause ?? "")].join("\n");
}
