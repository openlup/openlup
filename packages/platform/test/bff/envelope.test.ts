import { describe, expect, it, vi } from "vitest";
import { createBffResponder } from "../../src/bff/envelope.js";
import type { HttpResponse } from "../../src/http/types.js";

function response() {
  const res = {
    setHeader: vi.fn(), removeHeader: vi.fn(),
    status: vi.fn(), json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return { res: res as unknown as HttpResponse, ...res };
}

const statuses = [
  ["BAD_REQUEST", 400], ["UNAUTHORIZED", 401], ["FORBIDDEN", 403],
  ["NOT_FOUND", 404], ["METHOD_NOT_ALLOWED", 405], ["CONFLICT", 409],
  ["RATE_LIMITED", 429], ["UPSTREAM_UNAVAILABLE", 503],
  ["INTERNAL", 500], ["INVALID_RESPONSE", 502],
] as const;

describe("BFF envelope", () => {
  it("writes a minimal success with JSON and private cache defaults", () => {
    const { res, status, json, setHeader } = response();
    createBffResponder().sendBffSuccess(res, { id: "entry-4" });
    expect(status.mock.calls).toEqual([[200]]);
    expect(json.mock.calls).toStrictEqual([[{ ok: true, data: { id: "entry-4" } }]]);
    expect(setHeader.mock.calls).toEqual([
      ["Content-Type", "application/json"], ["Cache-Control", "no-store"],
    ]);
  });

  it.each(statuses)("answers %s with status %i and a minimal error", (code, expected) => {
    const { res, status, json, setHeader } = response();
    createBffResponder().sendBffError(res, code, "Request refused");
    expect(status.mock.calls).toEqual([[expected]]);
    expect(json.mock.calls).toStrictEqual([[{
      ok: false, error: { code, message: "Request refused" },
    }]]);
    expect(setHeader.mock.calls).toEqual([
      ["Content-Type", "application/json"], ["Cache-Control", "no-store"],
    ]);
  });

  it("honors an explicit error status, details and metadata", () => {
    const { res, status, json } = response();
    createBffResponder().sendBffError(res, "CONFLICT", "State changed", {
      status: 422, details: { expected: 2 }, meta: { contractVersion: "reply.v2", attempt: 3 },
    });
    expect(status).toHaveBeenCalledWith(422);
    expect(json.mock.calls).toStrictEqual([[{
      ok: false, error: { code: "CONFLICT", message: "State changed", details: { expected: 2 } },
      meta: { contractVersion: "reply.v2", attempt: 3 },
    }]]);
  });

  it("removes undefined object members recursively while retaining array positions and null", () => {
    const { res, json } = response();
    const data = {
      absent: undefined, nil: null, enabled: false, count: 0,
      nested: { absent: undefined, value: "kept" },
      rows: [undefined, { absent: undefined, nested: [{ absent: undefined, value: 2 }] }, null],
    };
    const expected = {
      nil: null, enabled: false, count: 0, nested: { value: "kept" },
      rows: [undefined, { nested: [{ value: 2 }] }, null],
    };
    const responder = createBffResponder();
    responder.sendBffSuccess(res, data, { absent: undefined, nested: { absent: undefined, value: 1 } });
    responder.sendBffError(res, "BAD_REQUEST", "Invalid input", {
      details: data, meta: { absent: undefined, rows: [{ absent: undefined }] },
    });
    expect(json.mock.calls).toStrictEqual([
      [{ ok: true, data: expected, meta: { nested: { value: 1 } } }],
      [{ ok: false, error: { code: "BAD_REQUEST", message: "Invalid input", details: expected }, meta: { rows: [{}] } }],
    ]);
    expect(data).toHaveProperty("absent");
    expect(data.rows[1]).toHaveProperty("absent");
  });

  it("keeps supplied metadata when no response reference is available", () => {
    const { res, json, setHeader } = response();
    createBffResponder({ responseRequestId: () => undefined }).sendBffSuccess(res, [], {
      requestId: "supplied-reference", contractVersion: "reply.v2",
    });
    expect(json.mock.calls).toStrictEqual([[{
      ok: true, data: [], meta: { requestId: "supplied-reference", contractVersion: "reply.v2" },
    }]]);
    expect(setHeader).not.toHaveBeenCalledWith("x-request-id", expect.anything());
  });

  it("puts the reference in the header without adding metadata to a minimal success", () => {
    const { res, json, setHeader } = response();
    const responseRequestId = vi.fn(() => "observed-reference");
    createBffResponder({ responseRequestId }).sendBffSuccess(res, { ready: true });
    expect(responseRequestId.mock.calls).toEqual([[res]]);
    expect(setHeader).toHaveBeenCalledWith("x-request-id", "observed-reference");
    expect(json.mock.calls).toStrictEqual([[{ ok: true, data: { ready: true } }]]);
  });

  it("enriches success metadata and replaces a supplied reference without mutating it", () => {
    const { res, json, setHeader } = response();
    const meta = { requestId: "supplied-reference", contractVersion: "reply.v2", nextCursor: "offset-7" };
    createBffResponder({ responseRequestId: () => "observed-reference" }).sendBffSuccess(res, [], meta);
    expect(setHeader).toHaveBeenCalledWith("x-request-id", "observed-reference");
    expect(json.mock.calls).toStrictEqual([[{
      ok: true, data: [], meta: { ...meta, requestId: "observed-reference" },
    }]]);
    expect(meta.requestId).toBe("supplied-reference");
  });

  it.each([undefined, {}, { contractVersion: "reply.v2", requestId: "supplied-reference" }])(
    "adds the observed reference to error metadata %j", (meta) => {
      const { res, json, setHeader } = response();
      createBffResponder({ responseRequestId: () => "observed-reference" }).sendBffError(res, "INTERNAL", "Read failed", { meta });
      expect(setHeader).toHaveBeenCalledWith("x-request-id", "observed-reference");
      expect(json.mock.calls).toStrictEqual([[{
        ok: false, error: { code: "INTERNAL", message: "Read failed" },
        meta: { ...meta, requestId: "observed-reference" },
      }]]);
    },
  );

  it.each([
    "public", "PUBLIC, max-age=20", "max-age=20, PuBlIc",
    "s-maxage=45", "private, S-MAXAGE = 45, stale-while-revalidate=60",
    "public, s-maxage=300, stale-while-revalidate=86400",
  ])("removes shared response references for %s without reading context", (cacheControl) => {
    const { res, json, setHeader, removeHeader } = response();
    const responseRequestId = vi.fn(() => { throw new Error("unexpected_context_read"); });
    const meta = { requestId: "prior-reference", contractVersion: "reply.v2" };
    createBffResponder({ responseRequestId }).sendBffSuccess(res, [], meta, { cacheControl });
    expect(responseRequestId).not.toHaveBeenCalled();
    expect(setHeader).toHaveBeenCalledWith("Cache-Control", cacheControl);
    expect(setHeader).not.toHaveBeenCalledWith("x-request-id", expect.anything());
    expect(removeHeader.mock.calls).toEqual([["x-request-id"]]);
    expect(json.mock.calls).toStrictEqual([[{ ok: true, data: [], meta: { contractVersion: "reply.v2" } }]]);
    expect(meta.requestId).toBe("prior-reference");
  });

  it("drops metadata emptied by shared reference removal", () => {
    const { res, json } = response();
    createBffResponder().sendBffSuccess(res, null, { requestId: "prior-reference" }, { cacheControl: "public" });
    expect(json.mock.calls).toStrictEqual([[{ ok: true, data: null }]]);
  });

  it("supports shared responses without metadata or a header removal method", () => {
    const { res, json, setHeader } = response();
    Object.defineProperty(res, "removeHeader", { value: undefined });
    const responseRequestId = vi.fn();
    createBffResponder({ responseRequestId }).sendBffSuccess(res, [], undefined, { cacheControl: "public" });
    expect(responseRequestId).not.toHaveBeenCalled();
    expect(setHeader).not.toHaveBeenCalledWith("x-request-id", expect.anything());
    expect(json.mock.calls).toStrictEqual([[{ ok: true, data: [] }]]);
  });

  it.each(["private, max-age=20", "max-age=20", "x-public=1, x-s-maxage=2"])(
    "retains the private reference for %s", (cacheControl) => {
      const { res, setHeader, removeHeader } = response();
      const responseRequestId = vi.fn(() => "observed-reference");
      createBffResponder({ responseRequestId }).sendBffSuccess(res, [], {}, { cacheControl });
      expect(responseRequestId).toHaveBeenCalledOnce();
      expect(setHeader).toHaveBeenCalledWith("Cache-Control", cacheControl);
      expect(setHeader).toHaveBeenCalledWith("x-request-id", "observed-reference");
      expect(removeHeader).not.toHaveBeenCalled();
    },
  );

  it.each([["GET"], ["GET", "POST", "OPTIONS"]])("joins allowed methods in order: %j", (...methods) => {
    const { res, setHeader, status, json } = response();
    createBffResponder().sendMethodNotAllowed(res, methods);
    expect(setHeader).toHaveBeenCalledWith("Allow", methods.join(", "));
    expect(status).toHaveBeenCalledWith(405);
    expect(json.mock.calls).toStrictEqual([[{
      ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
    }]]);
  });
});
