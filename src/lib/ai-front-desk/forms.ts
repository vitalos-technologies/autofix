// Settings · AI front desk form rules (P5.12). Client-safe.

import type { SetupFormState } from "@/lib/settings/setup";

export type IssueTokenState = SetupFormState<"name"> & {
  /** The raw token, shown once in this response and never stored or logged. */
  token?: string;
  tokenName?: string;
};

export const initialIssueTokenState: IssueTokenState = { seq: 0, status: "idle" };

export const TOKEN_NAME_MAX = 80;

/** The token's label: 1–80 characters after trimming and folding spaces. */
export function parseTokenName(value: unknown): { ok: true; name: string } | { ok: false; message: string } {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!name) return { ok: false, message: "Give the token a name, for example Workforce calls." };
  if (name.length > TOKEN_NAME_MAX) return { ok: false, message: `Keep the name to ${TOKEN_NAME_MAX} characters or fewer.` };
  return { ok: true, name };
}

/** Flash messages for the page's redirects (`?done=` / `?error=` codes, never free text). */
export const AI_FRONT_DESK_MESSAGES: Record<string, string> = {
  "done:enabled": "The AI front desk is on. Missed calls go to it once Workforce is connected.",
  "done:disabled": "The AI front desk is off. Missed calls get your voicemail and a text back.",
  "done:revoked": "Token revoked. Anything using it is refused straight away.",
  "done:already_revoked": "That token was already revoked.",
  "error:owner_only": "Only the garage owner can switch the AI front desk on or off.",
  "error:manage_only": "Only the garage's owners and managers can manage tokens.",
  "error:plan_required": "The AI front desk is part of Autofix Pro. The garage owner can upgrade in Settings, Plan.",
  "error:save_failed": "That change could not be saved. Try again.",
};
