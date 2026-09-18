import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import type { BffClient } from "./bffClient.js";
import {
  BackendRequestRefContext,
  BffToolError,
  createBffClient,
} from "./bffClient.js";
import { createToolRegistry } from "./registry.js";
import type { McpToolDefinition } from "./toolFromContract.js";

const schema = z.object({ mode: z.enum(["commit", "dry_run"]).default("commit"), name: z.string() }).strict();

function tool(overrides: Partial<McpToolDefinition> = {}): McpToolDefinition {
  return {
    name: "demo__create",
    description: "demo",
    path: "/api/demo/create",
    requestSchema: schema,
    inputSchema: { type: "object" },
    ...overrides,
  };
}

function fakeBff(
  post = vi.fn(async () => ({ ok: 1 })),
  get = vi.fn(async () => ({ ok: 1 })),
): { bffClient: BffClient; post: typeof post; get: typeof get } {
  return { bffClient: { post, get }, post, get };
}

describe("createToolRegistry", () => {
  it("rejects tool names that violate the convention", () => {
    const { bffClient } = fakeBff();
    expect(() => createToolRegistry({ tools: [tool({ name: "Demo-Create" })], bffClient })).toThrow(/Invalid MCP tool name/);
  });

  it("rejects duplicate tool names", () => {
    const { bffClient } = fakeBff();
    expect(() => createToolRegistry({ tools: [tool(), tool()], bffClient })).toThrow(/Duplicate/);
  });

  it("listTools projects name + description + derived inputSchema", () => {
    const { bffClient } = fakeBff();
    const registry = createToolRegistry({ tools: [tool()], bffClient });
    expect(registry.listTools()).toEqual([
      { name: "demo__create", description: "demo", inputSchema: { type: "object" } },
    ]);
  });

  it("callTool validates input against the contract before hitting the BFF", async () => {
    const { bffClient, post } = fakeBff();
    const registry = createToolRegistry({ tools: [tool()], bffClient });
    const error = await registry.callTool("demo__create", { name: 123 }).catch((e) => e);
    expect(error).toBeInstanceOf(BffToolError);
    expect(error.reason).toBe("validation_failed");
    expect(post).not.toHaveBeenCalled();
  });

  it("callTool applies the transform and posts to the tool path", async () => {
    const { bffClient, post } = fakeBff();
    const registry = createToolRegistry({
      tools: [tool({ transform: (input) => ({ ...input, mode: "dry_run" }) })],
      bffClient,
    });
    await registry.callTool("demo__create", { name: "abc" });
    expect(post).toHaveBeenCalledWith(
      "/api/demo/create",
      { mode: "dry_run", name: "abc" },
      expect.objectContaining({
        contractVersion: undefined,
        requestContext: expect.any(BackendRequestRefContext),
      }),
    );
  });

  it("dispatches GET tools to bffClient.get and POST tools to bffClient.post", async () => {
    const { bffClient, post, get } = fakeBff();
    const registry = createToolRegistry({
      tools: [
        tool({ name: "demo__list", path: "/api/demo/list", httpMethod: "GET" }),
        tool({ name: "demo__create", path: "/api/demo/create" }),
      ],
      bffClient,
    });

    await registry.callTool("demo__list", { name: "abc" });
    expect(get).toHaveBeenCalledWith(
      "/api/demo/list",
      { mode: "commit", name: "abc" },
      expect.objectContaining({ requestContext: expect.any(BackendRequestRefContext) }),
    );
    expect(post).not.toHaveBeenCalled();

    await registry.callTool("demo__create", { name: "abc" });
    expect(post).toHaveBeenCalledWith(
      "/api/demo/create",
      { mode: "commit", name: "abc" },
      expect.objectContaining({ requestContext: expect.any(BackendRequestRefContext) }),
    );
  });

  it("passes a per-tool contract version to the BFF client", async () => {
    const { bffClient, get } = fakeBff();
    const registry = createToolRegistry({
      tools: [tool({ name: "demo__list", path: "/api/demo/list", httpMethod: "GET", contractVersion: "clients.v1" })],
      bffClient,
    });

    await registry.callTool("demo__list", { name: "abc" });
    expect(get).toHaveBeenCalledWith(
      "/api/demo/list",
      { mode: "commit", name: "abc" },
      expect.objectContaining({
        contractVersion: "clients.v1",
        requestContext: expect.any(BackendRequestRefContext),
      }),
    );
  });

  it("supports custom composed tool calls after validating and transforming input", async () => {
    const { bffClient, get } = fakeBff();
    const call = vi.fn(async (input: Record<string, unknown>) => ({ received: input.name }));
    const registry = createToolRegistry({
      tools: [tool({ name: "demo__compose", path: "mcp://demo/compose", call })],
      bffClient,
    });

    await expect(registry.callTool("demo__compose", { name: "abc" })).resolves.toEqual({ received: "abc" });
    expect(call).toHaveBeenCalledWith(
      { mode: "commit", name: "abc" },
      { bffClient: expect.objectContaining({ get: expect.any(Function), post: expect.any(Function) }) },
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("callTool on an unknown tool throws not_found (the activate path is simply absent)", async () => {
    const { bffClient } = fakeBff();
    const registry = createToolRegistry({ tools: [tool()], bffClient });
    const error = await registry.callTool("demo__activate", {}).catch((e) => e);
    expect(error).toBeInstanceOf(BffToolError);
    expect(error.reason).toBe("not_found");
  });

  it("keeps interleaved tool-call backend references isolated", async () => {
    let secondStarted!: () => void;
    const secondStartedPromise = new Promise<void>((resolve) => { secondStarted = resolve; });
    const client = createBffClient({
      baseUrl: "https://bff.example.test",
      getBearer: vi.fn(async () => "bearer"),
      contractVersion: "example.v1",
      fetchImpl: vi.fn(async (_url, init) => {
        const name = JSON.parse(String(init?.body)).name as string;
        if (name === "first") await secondStartedPromise;
        if (name === "second") secondStarted();
        return errorResponse(`node:${name}`);
      }) as typeof fetch,
    });
    const registry = createToolRegistry({ tools: [tool()], bffClient: client });

    const [first, second] = await Promise.all([
      registry.callTool("demo__create", { name: "first" }).catch((error) => error),
      registry.callTool("demo__create", { name: "second" }).catch((error) => error),
    ]);

    expect(first.backendRequestRefs).toEqual(["node:first"]);
    expect(second.backendRequestRefs).toEqual(["node:second"]);
  });

  it("marks a composed failure incomplete while another child is unsettled", async () => {
    let releasePending!: () => void;
    const pending = new Promise<Response>((resolve) => {
      releasePending = () => resolve(errorResponse("node:pending"));
    });
    const client = createBffClient({
      baseUrl: "https://bff.example.test",
      getBearer: vi.fn(async () => "bearer"),
      contractVersion: "example.v1",
      fetchImpl: vi.fn(async (url) => String(url).includes("pending")
        ? pending
        : errorResponse("node:failed")) as typeof fetch,
    });
    const compose = tool({
      name: "demo__compose",
      call: async (_input, { bffClient }) => {
        const [result] = await Promise.all([
          bffClient.get("/failed", {}),
          bffClient.get("/pending", {}),
        ]);
        return result;
      },
    });
    const registry = createToolRegistry({ tools: [compose], bffClient: client });

    const error = await registry.callTool("demo__compose", { name: "x" }).catch((value) => value);
    releasePending();

    expect(error.backendRequestRefs).toEqual(["node:failed"]);
    expect(error.backendRequestRefsIncomplete).toBe(true);
  });
});

function errorResponse(requestId: string): Response {
  return new Response(JSON.stringify({
    ok: false,
    error: { code: "CONFLICT", message: "changed" },
    meta: { requestId },
  }), { status: 409, headers: { "x-request-id": requestId } });
}
