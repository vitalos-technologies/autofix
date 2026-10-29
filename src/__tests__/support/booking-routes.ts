import { NextRequest } from "next/server";
import { vi } from "vitest";
import type { BookingEngine } from "@/lib/booking-engine/types";

/** Every request in these tests arrives on Hartley Road's booking host. */
export const GARAGE_HOST = "https://hartley-road.pitline.co.uk";

export function fakeEngine(): { [K in keyof BookingEngine]: ReturnType<typeof vi.fn> } & BookingEngine {
  const engine = {
    listOnlineServices: vi.fn(async () => []),
    getAvailableSlots: vi.fn(async () => []),
    createBooking: vi.fn(),
  };
  return engine as unknown as { [K in keyof BookingEngine]: ReturnType<typeof vi.fn> } & BookingEngine;
}

export function getRequest(path: string, init: { cookie?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": init.ip ?? "198.51.100.7" };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`${GARAGE_HOST}${path}`, { method: "GET", headers });
}

export function jsonRequest(path: string, body: unknown, init: { method?: string; cookie?: string; ip?: string; contentType?: string; raw?: string } = {}) {
  const headers: Record<string, string> = {
    "content-type": init.contentType ?? "application/json",
    "x-forwarded-for": init.ip ?? "198.51.100.7",
  };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`${GARAGE_HOST}${path}`, { method: init.method ?? "POST", headers, body: init.raw ?? JSON.stringify(body) });
}
