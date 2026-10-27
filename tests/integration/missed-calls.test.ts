/**
 * Missed calls end to end against local Supabase (P4.1): the voice webhook
 * (voicemail, dial-through, dial outcomes, recording callback) writing
 * `calls`, the calls.text_back job through claim_call_text_back() (once per
 * number per garage per 24 hours, never to opted-out or STOP numbers), and the
 * "Needs your OK" read and "Mark handled" through a member's RLS client.
 * Handlers run directly, so this suite never claims other suites' jobs.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createLocalClient, createLocalGarage, createLocalIdentity, getLocalSupabaseConfig, localRunId, type LocalTestGarage } from "../helpers/local-supabase";

const configured = Boolean(process.env.INTEGRATION_SUPABASE_URL);

const AUTH_TOKEN = `integration-twilio-token-${localRunId}`;
const WEBHOOK_BASE = "https://autofix.integration.test";
const ENV = { TWILIO_AUTH_TOKEN: AUTH_TOKEN, TWILIO_WEBHOOK_BASE_URL: WEBHOOK_BASE };
const suffix = String(Number.parseInt(localRunId.slice(0, 6), 16) % 10_000).padStart(4, "0");
const GARAGE_NUMBER = `+44113496${suffix}`;
const OWN_PHONE = `+44113497${suffix}`;
const SAM = "+447700916941";
const OLA = "+447700916942";
const UNA = "+447700916943";
const RECORDING = "https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Recordings/RE00000000000000000000000000000041";
const sid = (n: number) => `CA${localRunId}${String(n).padStart(4, "0")}`;

describe.skipIf(!configured).sequential("missed calls against local Supabase", () => {
  let service: SupabaseClient;
  let staff: SupabaseClient;
  let staffId: string;
  let garage: LocalTestGarage;
  let webhooks: typeof import("../../src/lib/messaging/twilio-webhooks");
  let repoModule: typeof import("../../src/lib/messaging/twilio-webhook-repository");
  let textBack: typeof import("../../src/lib/jobs/handlers/calls-text-back");
  let queueModule: typeof import("../../src/lib/jobs/queue");
  let logModule: typeof import("../../src/lib/jobs/log");
  let missed: typeof import("../../src/lib/calls/missed-calls");
  let mock: typeof import("../../src/lib/messaging/mock");

  function call(params: Record<string, string>, step?: string) {
    const body = new URLSearchParams(params).toString();
    const path = `/api/webhooks/twilio/voice${step ? `?step=${step}` : ""}`;
    return webhooks.handleTwilioWebhook(new Request(`http://localhost:3000${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilioSignature(`${WEBHOOK_BASE}${path}`, body),
      },
      body,
    }), "voice", { repo: () => repoModule.createSupabaseTwilioWebhookRepo(service), env: ENV, log: logModule.createJobLogger({}, () => undefined) });
  }

  let twilioSignature: (url: string, body: string) => string;

  function sms(params: Record<string, string>) {
    const body = new URLSearchParams(params).toString();
    const path = "/api/webhooks/twilio/sms";
    return webhooks.handleTwilioWebhook(new Request(`http://localhost:3000${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(`${WEBHOOK_BASE}${path}`, body) },
      body,
    }), "sms", { repo: () => repoModule.createSupabaseTwilioWebhookRepo(service), env: ENV, log: logModule.createJobLogger({}, () => undefined) });
  }

  async function runTextBack(callSid: string) {
    const row = await service.from("calls").select("id").eq("provider_call_sid", callSid).single();
    const callId = (row.data as { id: string }).id;
    const queued = await service.from("jobs").select("payload,status").eq("dedupe_key", `calls.text_back:${callId}`).maybeSingle();
    expect(queued.data).toMatchObject({ status: "queued", payload: { garageId: garage.id, callId } });
    const payload = { garageId: garage.id, callId };
    const now = new Date();
    return textBack.callsTextBackHandler(payload, {
      job: { id: randomUUID(), kind: "calls.text_back", garage_id: garage.id, payload, dedupe_key: null, run_at: now.toISOString(), status: "running", attempts: 1, max_attempts: 5 },
      db: service,
      now: () => now,
      clock: Date.now,
      deadline: Date.now() + 10_000,
      queue: queueModule.createSupabaseJobQueue(service),
      log: logModule.createJobLogger({}, () => undefined),
      env: {},
    });
  }

  const ringing = (n: number, from: string, extra: Record<string, string> = {}) => ({ CallSid: sid(n), From: from, To: GARAGE_NUMBER, CallStatus: "ringing", Direction: "inbound", ...extra });

  beforeAll(async () => {
    const config = getLocalSupabaseConfig();
    process.env.NEXT_PUBLIC_SUPABASE_URL = config.url;
    process.env.SUPABASE_SECRET_KEY = config.secretKey;
    process.env.MESSAGING_MODE = "mock";
    service = createLocalClient(config.secretKey);
    webhooks = await import("../../src/lib/messaging/twilio-webhooks");
    repoModule = await import("../../src/lib/messaging/twilio-webhook-repository");
    textBack = await import("../../src/lib/jobs/handlers/calls-text-back");
    queueModule = await import("../../src/lib/jobs/queue");
    logModule = await import("../../src/lib/jobs/log");
    missed = await import("../../src/lib/calls/missed-calls");
    mock = await import("../../src/lib/messaging/mock");
    const twilio = await import("../../src/lib/messaging/twilio");
    twilioSignature = (url, body) => twilio.computeTwilioSignature(url, new URLSearchParams(body), AUTH_TOKEN);

    garage = await createLocalGarage(service, "mc");
    const defaults = await service.rpc("seed_garage_defaults", { p_garage_id: garage.id });
    if (defaults.error) throw new Error(defaults.error.message);
    const number = await service.from("garage_phone_numbers").insert({ garage_id: garage.id, number: GARAGE_NUMBER, purpose: "forwarding", provider_sid: `PN${localRunId}mc` });
    if (number.error) throw new Error(`Could not provision the garage number: ${number.error.message}`);
    const customers = await service.from("customers").insert([
      { garage_id: garage.id, name: "Sam Caller", phone: SAM, preferred_contact: "phone", channel: "sms" },
      { garage_id: garage.id, name: "Ola Optedout", phone: OLA, preferred_contact: "phone", channel: "sms", opted_out_at: new Date().toISOString() },
    ]);
    if (customers.error) throw new Error(customers.error.message);

    const identity = await createLocalIdentity(service, config.publishableKey, `missed-calls-owner-${localRunId}@example.test`);
    staffId = identity.id;
    const member = await service.from("garage_members").insert({ garage_id: garage.id, user_id: identity.id, role: "owner" });
    if (member.error) throw new Error(member.error.message);
    staff = createLocalClient(config.publishableKey, identity.accessToken, garage.id);
  }, 60_000);

  afterAll(async () => {
    if (!service || !garage) return;
    await service.from("twilio_webhook_events").delete().like("provider_sid", `%${localRunId}%`);
    await service.from("jobs").delete().eq("garage_id", garage.id);
    await service.from("garage_phone_numbers").delete().eq("garage_id", garage.id);
  });

  it("a call with nobody to ring goes to voicemail, is logged missed and texts the caller back once", async () => {
    const response = await call(ringing(1, SAM));
    expect(await response.text()).toContain("<Record ");
    const row = await service.from("calls").select("garage_id,from_number,to_number,status,missed,dial_status").eq("provider_call_sid", sid(1)).single();
    expect(row.data).toEqual({ garage_id: garage.id, from_number: SAM, to_number: GARAGE_NUMBER, status: "ringing", missed: true, dial_status: null });

    mock.clearMockOutbox();
    expect(await runTextBack(sid(1))).toEqual({ outcome: "sent" });
    const [sent] = mock.getMockOutbox().filter((entry) => entry.garageId === garage.id);
    expect(sent).toMatchObject({ kind: "sms", to: SAM });
    expect(sent!.body).toMatch(/^Sorry we missed your call\. Book online in about a minute: http:\/\/it-mc-.+\.localhost:3000\/ or we'll call you back soon\. .+\nReply STOP to opt out\.$/);
    const linked = await service.from("calls").select("text_back_message_id").eq("provider_call_sid", sid(1)).single();
    const message = await service.from("messages").select("direction,status,to_address,call_id,provider,provider_msg_id").eq("id", linked.data!.text_back_message_id).single();
    expect(message.data).toMatchObject({ direction: "outbound", status: "queued", to_address: SAM, provider: "mock", provider_msg_id: sent!.providerMessageId });

    // The same job again (at-least-once delivery) sends nothing more.
    expect(await runTextBack(sid(1))).toEqual({ outcome: "already_sent" });
  });

  it("stores the voicemail link from Twilio's recording callback", async () => {
    await call({ CallSid: sid(1), RecordingSid: "RE00000000000000000000000000000041", RecordingUrl: RECORDING, RecordingStatus: "completed", RecordingDuration: "23" }, "recording");
    const row = await service.from("calls").select("voicemail_url,voicemail_duration_s").eq("provider_call_sid", sid(1)).single();
    expect(row.data).toEqual({ voicemail_url: RECORDING, voicemail_duration_s: 23 });
  });

  it("a second missed call from the same number within 24 hours gets no second text", async () => {
    await call(ringing(2, SAM));
    mock.clearMockOutbox();
    expect(await runTextBack(sid(2))).toEqual({ outcome: "recent_text_back" });
    expect(mock.getMockOutbox().filter((entry) => entry.garageId === garage.id)).toEqual([]);
  });

  it("opted-out customers and numbers that texted STOP get nothing", async () => {
    await call(ringing(3, OLA));
    expect(await runTextBack(sid(3))).toEqual({ outcome: "opted_out" });

    const stop = await sms({ MessageSid: `SM${localRunId}mc01`, From: UNA, To: GARAGE_NUMBER, Body: "STOP", NumMedia: "0" });
    expect(stop.status).toBe(200);
    await call(ringing(4, UNA));
    expect(await runTextBack(sid(4))).toEqual({ outcome: "opted_out" });
  });

  it("with its own phone set, the garage is rung first; an answered call is not missed, a no-answer is", async () => {
    const own = await service.from("garage_phone_numbers").insert({ garage_id: garage.id, number: OWN_PHONE, purpose: "forwarding" });
    if (own.error) throw new Error(own.error.message);
    const SECOND = "+447700916944";
    const THIRD = "+447700916945";

    const dial = await (await call(ringing(5, SECOND))).text();
    expect(dial).toContain(`<Number>${OWN_PHONE}</Number>`);
    expect(dial).toContain(`action="${WEBHOOK_BASE}/api/webhooks/twilio/voice?step=dial"`);
    expect((await service.from("calls").select("missed").eq("provider_call_sid", sid(5)).single()).data?.missed).toBe(false);
    const answered = await (await call({ ...ringing(5, SECOND), CallStatus: "in-progress", DialCallStatus: "completed", DialCallDuration: "60" }, "dial")).text();
    expect(answered).toContain("<Hangup/>");
    expect((await service.from("calls").select("missed,dial_status").eq("provider_call_sid", sid(5)).single()).data).toEqual({ missed: false, dial_status: "completed" });

    await call(ringing(6, THIRD));
    const unanswered = await (await call({ ...ringing(6, THIRD), CallStatus: "in-progress", DialCallStatus: "no-answer" }, "dial")).text();
    expect(unanswered).toContain("<Record ");
    expect((await service.from("calls").select("missed,dial_status").eq("provider_call_sid", sid(6)).single()).data).toEqual({ missed: true, dial_status: "no-answer" });
    mock.clearMockOutbox();
    expect(await runTextBack(sid(6))).toEqual({ outcome: "sent" });

    // The same caller ringing straight back (our own forward returning) is not dialled again.
    const returned = await (await call(ringing(7, THIRD))).text();
    expect(returned).not.toContain("<Dial");
  });

  it("members see their unhandled missed calls (masked) and mark them handled as themselves", async () => {
    const cards = await missed.listMissedCallsNeedingOk(staff, garage.id);
    const sam = cards.find((card) => card.callBackHref === `tel:${SAM}` && card.voicemailHref);
    expect(sam).toMatchObject({ callerName: "Sam Caller", maskedNumber: "07••• •••941", voicemailSeconds: 23, textedBack: true });
    expect(cards.some((card) => card.callBackHref === "tel:+447700916944")).toBe(false); // answered, not missed
    const count = await missed.countMissedCallsNeedingOk(staff, garage.id);
    expect(count).toBe(cards.length);

    const forged = await staff.from("calls").update({ handled_at: new Date().toISOString(), handled_by: randomUUID() }).eq("id", sam!.id).select("id");
    expect(forged.error).not.toBeNull();
    const handled = await staff.from("calls").update({ handled_at: new Date().toISOString(), handled_by: staffId }).eq("id", sam!.id).select("id");
    expect(handled.error).toBeNull();
    expect(handled.data).toHaveLength(1);
    expect((await missed.listMissedCallsNeedingOk(staff, garage.id)).some((card) => card.id === sam!.id)).toBe(false);
    expect(await missed.countMissedCallsNeedingOk(staff, garage.id)).toBe(count - 1);

    // Staff cannot touch what the webhook records.
    const tampered = await staff.from("calls").update({ voicemail_url: null }).eq("id", sam!.id).select("id");
    expect(tampered.error?.code).toBe("42501");
  });
});
