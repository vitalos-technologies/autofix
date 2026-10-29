import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { AutofixClient } from "./autofix.js";
import { verifyClaim } from "./claim.js";
import { ready, type Config } from "./config.js";
import { DeskCall } from "./desk.js";
import type { Engine } from "./llm.js";
import type { Logger } from "./log.js";
import { twilioSignatureValid } from "./twilio-signature.js";

// GET /healthz   200 always (Pitline's voice webhook calls it to wake the container while the disclosure plays)
// GET /readyz    200 when the relay secret and the Claude key are set, else 503
// GET /relay     the ConversationRelay WebSocket: the signed claim in the query (and X-Twilio-Signature when
//                TWILIO_AUTH_TOKEN is set), one live socket per CallSid.

export type VoiceAppDeps = { autofix: AutofixClient; engine: Engine; log: Logger; now?: () => Date; sleep?: (ms: number) => Promise<void> };

export type VoiceApp = { server: Server; activeCalls: () => number; drain: (timeoutMs: number) => Promise<void> };

function refuse(socket: Duplex, status: number, reason: string) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function relayUrls(config: Config, request: IncomingMessage, search: string) {
  if (config.publicRelayUrl) return [`${config.publicRelayUrl}${search}`, `${config.publicRelayUrl.replace(/^wss:/, "https:")}${search}`];
  const host = request.headers.host ?? "";
  return [`wss://${host}${request.url ?? ""}`, `https://${host}${request.url ?? ""}`];
}

export function createVoiceApp(config: Config, deps: VoiceAppDeps): VoiceApp {
  const calls = new Map<string, DeskCall>();
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && path === "/healthz") return json(200, { ok: true });
    if (request.method === "GET" && path === "/readyz") return ready(config) ? json(200, { ready: true }) : json(503, { ready: false });
    return json(404, { error: "not_found" });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://relay.local");
    if (url.pathname !== "/relay") return refuse(socket, 404, "Not Found");
    if (!ready(config) || !config.relaySecret) {
      deps.log.error("relay_not_ready");
      return refuse(socket, 503, "Service Unavailable");
    }
    const claim = verifyClaim(config.relaySecret, url.searchParams, (deps.now ?? (() => new Date()))());
    if (!claim) {
      deps.log.warn("relay_bad_claim");
      return refuse(socket, 403, "Forbidden");
    }
    if (config.twilioAuthToken) {
      const signature = request.headers["x-twilio-signature"];
      if (!twilioSignatureValid(config.twilioAuthToken, relayUrls(config, request, url.search), typeof signature === "string" ? signature : undefined)) {
        deps.log.warn("relay_bad_signature", { garage_id: claim.garageId, call_sid: claim.callSid });
        return refuse(socket, 403, "Forbidden");
      }
    }
    if (calls.has(claim.callSid)) {
      deps.log.warn("relay_duplicate_call", { garage_id: claim.garageId, call_sid: claim.callSid });
      return refuse(socket, 409, "Conflict");
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const call = new DeskCall(claim, ws, { autofix: deps.autofix, engine: deps.engine, log: deps.log, maxCallSeconds: config.maxCallSeconds, now: deps.now, sleep: deps.sleep });
      calls.set(claim.callSid, call);
      ws.on("message", (data) => call.handle(String(data)));
      ws.on("close", () => {
        void call.close().finally(() => calls.delete(claim.callSid));
      });
      ws.on("error", () => ws.terminate());
    });
  });

  return {
    server,
    activeCalls: () => calls.size,
    async drain(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (calls.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
      await Promise.all([...calls.values()].map((call) => call.close()));
    },
  };
}
