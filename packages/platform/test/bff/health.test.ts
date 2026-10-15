import { describe, expect, it, vi } from "vitest";
import { createBffResponder } from "../../src/bff/envelope.js";
import { createHealthHandler, type HealthContract } from "../../src/bff/health.js";
import type { HttpRequest, HttpResponse } from "../../src/http/types.js";

type Health = { status: "ok"; contractVersion: string };

function fixture(payload: unknown = { status: "ok", contractVersion: " health.v4 " }) {
  const safeParse = vi.fn((value: unknown): ReturnType<HealthContract<Health>["safeParse"]> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { success: false };
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || record.status !== "ok"
      || typeof record.contractVersion !== "string" || !record.contractVersion.trim()) {
      return { success: false };
    }
    return { success: true, data: { status: "ok", contractVersion: record.contractVersion.trim() } };
  });
  const read = vi.fn(() => payload);
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  const handler = createHealthHandler({ responder: createBffResponder(), contract: { safeParse }, read });
  const invoke = (method: string | undefined) => handler({ method } as HttpRequest, res as unknown as HttpResponse);
  return { ...res, invoke, read, safeParse };
}

describe("health handler", () => {
  it("answers GET with parsed data and its parsed contract version", () => {
    const { invoke, read, safeParse, status, json, setHeader } = fixture();
    invoke("GET");
    expect(read).toHaveBeenCalledExactlyOnceWith();
    expect(safeParse.mock.calls).toStrictEqual([[{ status: "ok", contractVersion: " health.v4 " }]]);
    expect(read.mock.invocationCallOrder[0]).toBeLessThan(safeParse.mock.invocationCallOrder[0]!);
    expect(status.mock.calls).toEqual([[200]]);
    expect(json.mock.calls).toStrictEqual([[{
      ok: true, data: { status: "ok", contractVersion: "health.v4" },
      meta: { contractVersion: "health.v4" },
    }]]);
    expect(setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "application/json");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "get", "", undefined])(
    "refuses method %j before reading or parsing", (method) => {
      const { invoke, read, safeParse, status, json, setHeader } = fixture();
      invoke(method);
      expect(read).not.toHaveBeenCalled();
      expect(safeParse).not.toHaveBeenCalled();
      expect(setHeader).toHaveBeenCalledWith("Allow", "GET");
      expect(status.mock.calls).toEqual([[405]]);
      expect(json.mock.calls).toStrictEqual([[{
        ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
      }]]);
    },
  );

  it.each([
    null, [], "invalid", {}, { status: "ok" },
    { status: "failed", contractVersion: "health.v4" },
    { status: "ok", contractVersion: 4 },
    { status: "ok", contractVersion: " " },
    { status: "ok", contractVersion: "health.v4", extra: true },
  ])("refuses invalid payload %j with the contract error", (payload) => {
    const { invoke, read, safeParse, status, json } = fixture(payload);
    invoke("GET");
    expect(read).toHaveBeenCalledOnce();
    expect(safeParse).toHaveBeenCalledExactlyOnceWith(payload);
    expect(status.mock.calls).toEqual([[500]]);
    expect(json.mock.calls).toStrictEqual([[{
      ok: false, error: { code: "INTERNAL", message: "Health contract is invalid" },
    }]]);
  });

  it("reads fresh data exactly once for each GET", () => {
    const { invoke, read, json } = fixture();
    read.mockReturnValueOnce({ status: "ok", contractVersion: "health.v5" });
    invoke("GET");
    invoke("GET");
    expect(read).toHaveBeenCalledTimes(2);
    expect(json.mock.calls).toStrictEqual([
      [{ ok: true, data: { status: "ok", contractVersion: "health.v5" }, meta: { contractVersion: "health.v5" } }],
      [{ ok: true, data: { status: "ok", contractVersion: "health.v4" }, meta: { contractVersion: "health.v4" } }],
    ]);
  });
});
