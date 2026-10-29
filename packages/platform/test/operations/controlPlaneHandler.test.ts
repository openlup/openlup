import { describe, expect, it, vi } from "vitest";
import { PlatformControlPlaneConflictError, PlatformControlPlaneUnavailableError } from "../../src/operations/index.js";
import { createPlatformControlPlaneHandler } from "../../src/operations/server/controlPlaneHandler.js";

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

function operationsPort() {
  return {
    readControlPlane: vi.fn(async () => ({ controls: [], jobs: [], alerts: [] })),
    mutateControlPlane: vi.fn(async () => ({
      action: "set-control" as const, replayed: false, revision: 1,
      recordedAt: "2026-09-07T06:30:00.000Z",
    })),
  };
}

const toggleCommand = {
  action: "set-control", idempotencyKey: "toggle-sample-42", controlKey: "queue.enabled", enabled: true,
};

describe("control-plane request and response characterization", () => {
  it.each(["POST", "DELETE"])("checks authorization before malformed %s input or port work", async method => {
    const port = operationsPort();
    const res = response();
    await createPlatformControlPlaneHandler({ port, authorizeAdmin: async () => false })(
      { method, body: "{unfinished" } as never, res as never,
    );
    expect(res.statusCode).toBe(401);
    expect(res.payload).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(port.readControlPlane).not.toHaveBeenCalled();
    expect(port.mutateControlPlane).not.toHaveBeenCalled();
  });

  it.each(["DELETE", "PATCH", "PUT", "OPTIONS"])("rejects authorized %s without calling the port", async method => {
    const port = operationsPort();
    const res = response();
    await createPlatformControlPlaneHandler({ port, authorizeAdmin: async () => true })(
      { method, body: toggleCommand } as never, res as never,
    );
    expect(res.statusCode).toBe(405);
    expect(res.payload).toMatchObject({ ok: false, error: { code: "METHOD_NOT_ALLOWED" } });
    expect(port.readControlPlane).not.toHaveBeenCalled();
    expect(port.mutateControlPlane).not.toHaveBeenCalled();
  });

  it.each([
    ["broken JSON", "{unfinished"],
    ["null payload", null],
    ["unrecognized action", { ...toggleCommand, action: "replace-runtime" }],
    ["caller-supplied operator", { ...toggleCommand, operatorId: "spoofed-operator" }],
    ["text instead of boolean", { ...toggleCommand, enabled: "true" }],
    ["blank command key", { ...toggleCommand, idempotencyKey: " " }],
  ])("rejects %s before mutation", async (_label, body) => {
    const port = operationsPort();
    const res = response();
    await createPlatformControlPlaneHandler({ port, authorizeAdmin: async () => true })(
      { method: "POST", body } as never, res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(res.payload).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
    expect(port.mutateControlPlane).not.toHaveBeenCalled();
  });

  it("normalizes JSON command keys and returns the exact replay receipt", async () => {
    const port = operationsPort();
    port.mutateControlPlane.mockResolvedValueOnce({
      action: "set-control", replayed: true, revision: 11, recordedAt: "2026-09-06T06:30:00.000Z",
    });
    const res = response();
    await createPlatformControlPlaneHandler({ port, authorizeAdmin: async () => true })(
      { method: "POST", body: JSON.stringify({ ...toggleCommand, controlKey: " queue.enabled ", idempotencyKey: " toggle-sample-42 " }) } as never,
      res as never,
    );
    expect(port.mutateControlPlane).toHaveBeenCalledExactlyOnceWith(toggleCommand);
    expect(res.payload).toEqual({ ok: true, data: {
      action: "set-control", replayed: true, revision: 11, recordedAt: "2026-09-06T06:30:00.000Z",
    } });
  });

  it("forwards the supplied heartbeat evidence without deciding readiness", async () => {
    const heartbeat = { action: "record-heartbeat", idempotencyKey: "pulse-sample-09", health: "degraded", firingCount: 3, maxSeverity: "p1", promotionReady: false };
    const port = operationsPort();
    port.mutateControlPlane.mockResolvedValueOnce({ action: "record-heartbeat", replayed: false, revision: null, recordedAt: "2026-09-07T06:30:00.000Z" } as never);
    const res = response();
    await createPlatformControlPlaneHandler({ port, authorizeAdmin: async () => true })(
      { method: "POST", body: heartbeat } as never, res as never,
    );
    expect(port.mutateControlPlane).toHaveBeenCalledExactlyOnceWith(heartbeat);
    expect(res.payload).toMatchObject({ ok: true, data: { action: "record-heartbeat", revision: null } });
  });

  it.each(["GET", "POST"])("contains malformed %s port results", async method => {
    const port = operationsPort();
    port.readControlPlane.mockResolvedValueOnce({ controls: "wrong-shape", jobs: [], alerts: [] } as never);
    port.mutateControlPlane.mockResolvedValueOnce({ action: "set-control", replayed: false, revision: 0, recordedAt: "not-a-time" } as never);
    const res = response();
    await createPlatformControlPlaneHandler({ port, authorizeAdmin: async () => true })(
      { method, body: toggleCommand } as never, res as never,
    );
    expect(res.statusCode).toBe(502);
    expect(res.payload).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
  });

  it.each(["GET", "POST"])("retains %s conflict semantics and hides upstream details", async method => {
    for (const [failure, code, status, message] of [
      [new PlatformControlPlaneConflictError("control_command_conflict"), "CONFLICT", 409, "control_command_conflict"],
      [new PlatformControlPlaneUnavailableError("synthetic internal transport detail"), "UPSTREAM_UNAVAILABLE", 503, "Platform control plane unavailable"],
      [new Error("synthetic internal transport detail"), "UPSTREAM_UNAVAILABLE", 503, "Platform control plane unavailable"],
    ] as const) {
      const port = operationsPort();
      port.readControlPlane.mockRejectedValueOnce(failure);
      port.mutateControlPlane.mockRejectedValueOnce(failure);
      const res = response();
      await createPlatformControlPlaneHandler({ port, authorizeAdmin: async () => true })(
        { method, body: toggleCommand } as never, res as never,
      );
      expect(res.statusCode).toBe(status);
      expect(res.payload).toMatchObject({ ok: false, error: { code, message } });
      expect(JSON.stringify(res.payload)).not.toContain("synthetic internal transport detail");
    }
  });
});
