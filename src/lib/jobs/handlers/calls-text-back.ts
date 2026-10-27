import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseTextBackRepo, sendCallTextBack, type TextBackRepo } from "@/lib/calls/text-back";
import { getChannel, type ChannelKind, type MessageChannel } from "@/lib/messaging/channel";
import { loadJobGarage } from "../garages";
import { callsTextBackPayload, parsePayload } from "../payloads";
import type { JobHandler } from "../types";

// `calls.text_back` (P4.1): queued by the voice webhook when a call is missed
// (key `calls.text_back:<call id>`) and drained straight after the webhook's
// response, so the caller gets the text within seconds. Database errors
// before the send are retried; after the claim nothing is (A14).

export type CallsTextBackDeps = {
  repo?: (db: SupabaseClient) => TextBackRepo;
  channelFor?: (kind: ChannelKind, env: Readonly<Record<string, string | undefined>>) => MessageChannel;
};

export function createCallsTextBackHandler(deps: CallsTextBackDeps = {}): JobHandler {
  const repoFor = deps.repo ?? createSupabaseTextBackRepo;
  const channelFor = deps.channelFor ?? ((kind, env) => getChannel(kind, env));

  return async (payload, context) => {
    const input = parsePayload(callsTextBackPayload, payload, context.job);
    const garage = await loadJobGarage(context.db, input.garageId);
    const result = await sendCallTextBack({
      garage,
      callId: input.callId,
      repo: repoFor(context.db),
      channelFor: (kind) => channelFor(kind, context.env),
      now: context.now(),
      env: context.env,
    });
    return { outcome: result.outcome };
  };
}

export const callsTextBackHandler = createCallsTextBackHandler();
