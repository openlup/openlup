import { describe, expect, it, vi } from "vitest";
import { createPlatformControlPlaneHandler } from "./control-plane.js";

function response() {
  return { statusCode: 200, payload: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, json(value: unknown) { this.payload = value; return this; }, end() { return this; }, setHeader() {} };
}

describe("platform control-plane handler", () => {
  it("refuses before any database work", async () => {
    const readControlPlane = vi.fn();
    const res = response();
    await createPlatformControlPlaneHandler({
      authorizeAdmin: async () => false,
      port: { readControlPlane, mutateControlPlane: vi.fn() },
    })({ method: "GET" } as never, res as never);
    expect(res.statusCode).toBe(401);
    expect(readControlPlane).not.toHaveBeenCalled();
  });

  it("reads and mutates the neutral projection", async () => {
    const port = {
      readControlPlane: vi.fn(async () => ({ controls: [], jobs: [], alerts: [] })),
      mutateControlPlane: vi.fn(async () => ({
        action: "set-control" as const, replayed: false, revision: 1,
        recordedAt: "2026-08-13T20:00:00.000Z",
      })),
    };
    const handler = createPlatformControlPlaneHandler({ port, authorizeAdmin: async () => true });
    const get = response();
    await handler({ method: "GET" } as never, get as never);
    expect(get.payload).toEqual({ ok: true, data: { controls: [], jobs: [], alerts: [] } });

    const post = response();
    await handler({ method: "POST", body: {
      action: "set-control", idempotencyKey: "control-1", controlKey: "jobs.enabled", enabled: true,
    } } as never, post as never);
    expect(post.statusCode).toBe(200);
    expect(port.mutateControlPlane).toHaveBeenCalledWith({
      action: "set-control", idempotencyKey: "control-1", controlKey: "jobs.enabled", enabled: true,
    });
  });
});
