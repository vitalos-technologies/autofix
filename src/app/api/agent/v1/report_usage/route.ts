import { handleAgentToolRequest } from "@/lib/agent-api/handler";

/** `POST /api/agent/v1/report_usage` (docs/autofix/agent-api.yaml, P5.12): AI front desk minutes per conversation. The garage comes from the bearer token. */
export function POST(request: Request) {
  return handleAgentToolRequest("report_usage", request);
}
