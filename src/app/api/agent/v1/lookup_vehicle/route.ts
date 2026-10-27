import { handleAgentToolRequest } from "@/lib/agent-api/handler";

/** `POST /api/agent/v1/lookup_vehicle` (docs/autofix/agent-api.yaml). The garage comes from the bearer token. */
export function POST(request: Request) {
  return handleAgentToolRequest("lookup_vehicle", request);
}
