// Environment for the voice service. Secrets come from Azure Container App secrets (secretref:) and are
// never logged. Missing ANTHROPIC_API_KEY or VOICE_RELAY_SECRET leaves /readyz at 503 and refuses calls,
// so Pitline's webhook falls back to the voicemail (Twilio reports the failed session).

export type Config = {
  port: number;
  /** Shared with Pitline (Vercel VOICE_RELAY_SECRET): checks the relay claim; the key for /api/voice/v1/session. */
  relaySecret: string | null;
  /** https origin of the Pitline admin host, e.g. https://pitline.co.uk. */
  autofixBaseUrl: string;
  anthropicApiKey: string | null;
  model: string;
  /** Twilio's signing key, to check X-Twilio-Signature on the WebSocket upgrade (optional extra check). */
  twilioAuthToken: string | null;
  /** The relay URL Twilio connects to (wss://host/relay), as Twilio signs it. */
  publicRelayUrl: string | null;
  /** Longest call the desk takes before it wraps up. */
  maxCallSeconds: number;
};

/** Fast and low-cost for live speech; set VOICE_CLAUDE_MODEL to change it. */
export const DEFAULT_MODEL = "claude-haiku-5-5";

function text(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): Config {
  const secret = text(env.VOICE_RELAY_SECRET);
  const base = text(env.AUTOFIX_BASE_URL) ?? "https://pitline.co.uk";
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
    throw new Error("AUTOFIX_BASE_URL must be an https origin with no path");
  }
  const maxCall = Number(env.VOICE_MAX_CALL_SECONDS ?? "600");
  return {
    port: Number(env.PORT ?? "8080") || 8080,
    relaySecret: secret && secret.length >= 32 ? secret : null,
    autofixBaseUrl: base,
    anthropicApiKey: text(env.ANTHROPIC_API_KEY),
    model: text(env.VOICE_CLAUDE_MODEL) ?? DEFAULT_MODEL,
    twilioAuthToken: text(env.TWILIO_AUTH_TOKEN),
    publicRelayUrl: text(env.PUBLIC_RELAY_URL),
    maxCallSeconds: Number.isFinite(maxCall) && maxCall >= 60 && maxCall <= 1800 ? Math.trunc(maxCall) : 600,
  };
}

export function ready(config: Config) {
  return Boolean(config.relaySecret && config.anthropicApiKey);
}
