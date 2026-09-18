import {
  BackendRequestRefContext,
  BffToolError,
  type BffClient,
  type BffRequestOptions,
  withBackendRequestDiagnostics,
} from "./bffClient.js";
import type { McpToolDefinition } from "./toolFromContract.js";

/**
 * MCP agent head — generic `_core` (domain-neutral).
 *
 * The multi-domain tool registry the one stdio server is built from. It freezes
 * the tool name convention (`/^[a-z]+__[a-z_]+$/`, unique), exposes the derived
 * `tools/list` projection, and dispatches `tools/call`: validate the input
 * against the SAME contract the tool was derived from, apply any pre-send
 * transform, then post to the BFF. A `BffToolError` (validation, rule violation,
 * publish denial, …) propagates so the server can render it as an MCP tool error.
 */
const TOOL_NAME_PATTERN = /^[a-z]+__[a-z_]+$/;

export interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: Readonly<Record<string, boolean | string>>;
}

export interface ToolRegistry {
  listTools(): ListedTool[];
  callTool(
    name: string,
    args: unknown,
    requestContext?: BackendRequestRefContext,
  ): Promise<Record<string, unknown>>;
}

export interface ToolRegistryDeps {
  readonly tools: readonly McpToolDefinition[];
  readonly bffClient: BffClient;
}

export function createToolRegistry(deps: ToolRegistryDeps): ToolRegistry {
  const byName = new Map<string, McpToolDefinition>();
  for (const tool of deps.tools) {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new Error(`Invalid MCP tool name: ${tool.name}`);
    }
    if (byName.has(tool.name)) {
      throw new Error(`Duplicate MCP tool name: ${tool.name}`);
    }
    byName.set(tool.name, tool);
  }

  return {
    listTools() {
      return [...byName.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      }));
    },
    async callTool(name, args, suppliedContext) {
      const tool = byName.get(name);
      if (!tool) {
        throw new BffToolError("NOT_FOUND", `Unknown tool: ${name}`, "not_found", false);
      }
      const parsed = tool.requestSchema.safeParse(args ?? {});
      if (!parsed.success) {
        throw new BffToolError(
          "BAD_REQUEST",
          "Invalid tool input",
          "validation_failed",
          false,
          parsed.error.flatten(),
        );
      }
      const requestContext = suppliedContext ?? new BackendRequestRefContext();
      const bffClient = bindRequestContext(deps.bffClient, requestContext);
      const input = parsed.data as Record<string, unknown>;
      const body = tool.transform ? tool.transform(input) : input;
      try {
        if (tool.call) return await tool.call(body, { bffClient });
        const options = { contractVersion: tool.contractVersion, requestContext };
        if (tool.httpMethod === "GET") {
          return await bffClient.get(
            tool.path,
            body as Record<string, string | number | undefined>,
            options,
          );
        }
        return await bffClient.post(tool.path, body, options);
      } catch (error) {
        throw withBackendRequestDiagnostics(error, requestContext.snapshot());
      }
    },
  };
}

function bindRequestContext(
  bffClient: BffClient,
  requestContext: BackendRequestRefContext,
): BffClient {
  const options = (value?: BffRequestOptions): BffRequestOptions => ({
    ...value,
    requestContext,
  });
  return {
    post: (path, body, value) => bffClient.post(path, body, options(value)),
    get: (path, query, value) => bffClient.get(path, query, options(value)),
  };
}
