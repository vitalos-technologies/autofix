import { handleAgentToolRequest } from "@/lib/agent-api/handler";

/** `POST /api/agent/v1/log_call_summary` (docs/autofix/agent-api.yaml, voice desk): the AI front desk's note on a call. Per-call tokens only. */
export function POST(request: Request) {
  return handleAgentToolRequest("log_call_summary", request);
}
