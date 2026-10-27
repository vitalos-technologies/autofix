import { handleAgentToolRequest } from "@/lib/agent-api/handler";

/** `POST /api/agent/v1/list_services` (docs/autofix/agent-api.yaml). The garage comes from the bearer token. */
export function POST(request: Request) {
  return handleAgentToolRequest("list_services", request);
}
