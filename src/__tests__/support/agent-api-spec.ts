/**
 * docs/autofix/agent-api.yaml loaded for contract tests (unit and integration):
 * response bodies and request examples are validated with Ajv (JSON Schema
 * 2020-12, the dialect of OpenAPI 3.1).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { expect } from "vitest";
import { parse } from "yaml";
import type { AgentTool } from "@/lib/agent-api/schemas";

const SPEC_PATH = path.join(process.cwd(), "docs/autofix/agent-api.yaml");
const SPEC_ID = "https://pitline.co.uk/agent-api.yaml";
type Operation = {
  operationId: string;
  requestBody?: { required?: boolean; content: Record<string, { schema: unknown; example?: unknown }> };
  responses: Record<string, { $ref?: string; content?: Record<string, { schema: unknown }> }>;
};
export const spec = parse(readFileSync(SPEC_PATH, "utf8")) as {
  openapi: string;
  paths: Record<string, { post?: Operation } & Record<string, unknown>>;
  components: Record<string, Record<string, unknown>>;
};

export const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ ...spec, $id: SPEC_ID });

const pointer = (...parts: string[]) => parts.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join("/");

export function operation(tool: AgentTool): Operation {
  const op = spec.paths[`/${tool}`]?.post;
  if (!op) throw new Error(`agent-api.yaml has no POST /${tool}`);
  return op;
}

/** JSON pointer to the response schema the spec documents for this status (falls back to `default`). */
function responseSchemaRef(tool: AgentTool, status: number) {
  const responses = operation(tool).responses;
  const key = responses[String(status)] ? String(status) : "default";
  const response = responses[key]!;
  if (response.$ref) {
    const name = response.$ref.replace("#/components/responses/", "");
    return `${SPEC_ID}#/${pointer("components", "responses", name, "content", "application/json", "schema")}`;
  }
  return `${SPEC_ID}#/${pointer("paths", `/${tool}`, "post", "responses", key, "content", "application/json", "schema")}`;
}

export function documentedStatuses(tool: AgentTool) {
  return Object.keys(operation(tool).responses).filter((key) => key !== "default").map(Number);
}

export function expectMatchesSpec(tool: AgentTool, status: number, body: unknown) {
  const validate = ajv.compile({ $ref: responseSchemaRef(tool, status) });
  const valid = validate(body);
  expect(valid, `${tool} ${status}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(body)}`).toBe(true);
}

export function requestValidator(tool: AgentTool) {
  return ajv.compile({ $ref: `${SPEC_ID}#/${pointer("paths", `/${tool}`, "post", "requestBody", "content", "application/json", "schema")}` });
}
