import { describe, expect, it } from "vitest";
import { idempotencyKey, runTool, speakableTime, toolDefinitions } from "../src/tools.js";
import { CALL, CALLER, fakeAutofix, SERVICE } from "./helpers.js";

const facts = { callSid: CALL, callerNumber: CALLER, timezone: "Europe/London" };

async function session(handlers: Parameters<typeof fakeAutofix>[0] = {}) {
  const fake = fakeAutofix(handlers);
  return { session: await fake.client.openSession({ garageId: "g", callSid: CALL, expires: 0, signature: "" }), calls: fake.calls };
}

describe("desk tools", () => {
  it("are strict and closed", () => {
    expect(toolDefinitions.map((tool) => tool.name)).toEqual(["available_slots", "lookup_vehicle", "create_booking", "get_booking", "end_call"]);
    for (const tool of toolDefinitions) {
      expect(tool.strict).toBe(true);
      expect((tool.input_schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
  });

  it("idempotency keys are UUIDs, the same for the same request on the same call", () => {
    const key = idempotencyKey(CALL, SERVICE, "2026-11-03T09:00:00.000Z");
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(idempotencyKey(CALL, SERVICE, "2026-11-03T09:00:00.000Z")).toBe(key);
    expect(idempotencyKey(CALL, SERVICE, "2026-11-03T09:30:00.000Z")).not.toBe(key);
  });

  it("says times in the garage's time zone, across the clock change", () => {
    expect(speakableTime("2026-10-24T08:30:00.000Z", "Europe/London")).toBe("Saturday 24 October at 9:30 am");
    expect(speakableTime("2026-10-26T09:30:00.000Z", "Europe/London")).toBe("Monday 26 October at 9:30 am");
  });

  it("available_slots passes the request through and returns at most 12 speakable times", async () => {
    const slots = Array.from({ length: 20 }, (_, index) => ({ startsAt: new Date(Date.UTC(2026, 10, 3, 9, index * 15)).toISOString(), endsAt: "x" }));
    const { session: s, calls } = await session({ available_slots: () => ({ status: 200, body: { timezone: "Europe/London", slots } }) });
    const outcome = await runTool("available_slots", { serviceId: SERVICE, from: "2026-11-03", to: "2026-11-04" }, s, facts);
    expect(calls).toEqual([{ tool: "available_slots", body: { serviceId: SERVICE, from: "2026-11-03", to: "2026-11-04" } }]);
    const body = JSON.parse(outcome.content) as { slots: Array<{ say: string }>; more: boolean };
    expect(body.slots).toHaveLength(12);
    expect(body.slots[0]?.say).toBe("Tuesday 3 November at 9:00 am");
    expect(body.more).toBe(true);
    expect(await runTool("available_slots", { serviceId: "nope", from: "x", to: "y" }, s, facts)).toMatchObject({ isError: true });
  });

  it("create_booking books a request with the caller's number, the same key on a retry, and never a confirmed status", async () => {
    const { session: s, calls } = await session({
      create_booking: () => ({ status: 201, body: { booking: { reference: "HRM-4821", status: "requested", startsAt: "2026-11-03T09:00:00.000Z", endsAt: "2026-11-03T11:00:00.000Z" }, replayed: false } }),
    });
    const input = { serviceId: SERVICE, startsAt: "2026-11-03T09:00:00.000Z", customerName: "Sam Patel", mobile: null, registration: "AB12 CDE", make: "Vauxhall", model: null, notes: "Brakes squeal" };
    const outcome = await runTool("create_booking", input, s, facts);
    expect(outcome).toMatchObject({ booked: true, isError: false });
    expect(JSON.parse(outcome.content)).toMatchObject({ booking: { reference: "HRM-4821", status: "requested", say: "Tuesday 3 November at 9:00 am" } });
    expect(calls[0]).toEqual({
      tool: "create_booking",
      body: {
        serviceId: SERVICE,
        startsAt: "2026-11-03T09:00:00.000Z",
        locationMode: "workshop",
        customer: { name: "Sam Patel", phone: CALLER, channel: "sms" },
        vehicle: { registration: "AB12 CDE", make: "Vauxhall" },
        notes: "Booked by phone with the AI front desk. Brakes squeal",
        idempotencyKey: idempotencyKey(CALL, SERVICE, "2026-11-03T09:00:00.000Z"),
      },
    });
    await runTool("create_booking", { ...input, mobile: "07700 900999" }, s, facts);
    expect((calls[1]?.body.customer as { phone: string }).phone).toBe("07700 900999");
    expect(calls[1]?.body.idempotencyKey).toBe(calls[0]?.body.idempotencyKey);
  });

  it("create_booking asks for what is missing instead of calling Autofix", async () => {
    const { session: s, calls } = await session();
    const base = { serviceId: SERVICE, startsAt: "2026-11-03T09:00:00.000Z", customerName: "Sam Patel", mobile: null, registration: "AB12 CDE", make: null, model: null, notes: null };
    expect(await runTool("create_booking", base, s, { ...facts, callerNumber: null })).toMatchObject({ isError: true });
    expect(await runTool("create_booking", { ...base, customerName: "" }, s, facts)).toMatchObject({ isError: true });
    expect(await runTool("create_booking", { ...base, registration: "" }, s, facts)).toMatchObject({ isError: true });
    expect(calls).toEqual([]);
  });

  it("passes Autofix's errors (fixed wording) back to the model", async () => {
    const { session: s } = await session({ create_booking: () => ({ status: 409, body: { code: "SLOT_UNAVAILABLE", message: "That time is no longer free.", alternatives: [] } }) });
    const outcome = await runTool("create_booking", { serviceId: SERVICE, startsAt: "2026-11-03T09:00:00.000Z", customerName: "Sam Patel", mobile: null, registration: "AB12CDE", make: null, model: null, notes: null }, s, facts);
    expect(outcome).toMatchObject({ isError: true });
    expect(outcome.booked).toBeUndefined();
    expect(JSON.parse(outcome.content)).toMatchObject({ status: 409, code: "SLOT_UNAVAILABLE" });
  });

  it("end_call ends locally", async () => {
    const { session: s, calls } = await session();
    expect(await runTool("end_call", { next: "voicemail" }, s, facts)).toMatchObject({ end: "voicemail" });
    expect(await runTool("end_call", { next: "goodbye" }, s, facts)).toMatchObject({ end: "goodbye" });
    expect(calls).toEqual([]);
  });
});
