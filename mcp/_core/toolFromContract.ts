import { z, type ZodType } from "zod";
import type { BffClient } from "./bffClient.js";

/**
 * MCP agent head — generic `_core` (domain-neutral).
 *
 * Tool input schemas are PROJECTIONS of the BFF request contracts (invariant 12):
 * `toolInputSchema` derives the JSON Schema from the same Zod schema the BFF
 * validates against, so a tool can never drift from the contract and is never
 * hand-authored. A domain's tool list (`mcp/<domain>/tools.ts`) is built from its
 * `AgentDomainSpec`, dropping every mutation that carries a `lifecycleMarker`
 * (agents are draft-only) — so `activate`/publish/delete tools are structurally
 * absent, not merely omitted.
 */
export interface McpToolDefinition {
  /** `${domainKey}__${operation}`; matches `/^[a-z]+__[a-z_]+$/`. */
  readonly name: string;
  readonly description: string;
  /** BFF route path the tool calls. */
  readonly path: string;
  /** Expected BFF contract version for this tool. Defaults to the MCP client's default commerce version. */
  readonly contractVersion?: string | null;
  /** HTTP verb the tool uses; defaults to POST (a mutation/validate tool). READ tools set "GET". */
  readonly httpMethod?: "GET" | "POST";
  /** The contract the tool input is validated against AND derived from. */
  readonly requestSchema: ZodType;
  /** Derived JSON Schema — `zodToJsonSchema(requestSchema)`, inlined ($refStrategy:none). */
  readonly inputSchema: Record<string, unknown>;
  /** MCP safety hints; hosted read-only tools set these explicitly. */
  readonly annotations?: Readonly<Record<string, boolean | string>>;
  /** Optional pre-send transform (e.g. force `mode:"dry_run"` for a validate tool). */
  readonly transform?: (input: Record<string, unknown>) => Record<string, unknown>;
  /** Optional custom read-only dispatcher for composed support tools. */
  readonly call?: (input: Record<string, unknown>, context: McpToolCallContext) => Promise<Record<string, unknown>>;
}

export interface McpToolCallContext {
  readonly bffClient: BffClient;
}

/** Derive a tool's JSON Schema from its Zod request contract. Never hand-author this. */
export function toolInputSchema(schema: ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    target: "draft-07",
    io: "input",
    reused: "inline",
  }) as Record<string, unknown>;
}

/**
 * MCP tool inputs must advertise an object at the schema root. A Zod
 * discriminated union of object commands serializes as a root `oneOf`, so keep
 * that exact derived union and add the object constraint required by the SDK.
 */
export function toolInputObjectSchema(schema: ZodType): Record<string, unknown> {
  return { type: "object", ...toolInputSchema(schema) };
}
