import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "../validation/zod.js";
import { BffClientError, requestBff } from "./client";
import { bffErrorMessage } from "./errorMessage";
import { installObservedRequestContext } from "../../../server/_lib/observability/requestContext.js";
import { sendBffError } from "../../../server/_lib/bff/response.js";
import type { VercelRequest, VercelResponse } from "../../../server/_lib/types/vercel.js";

describe("requestBff", () => {
  afterEach(() => vi.useRealTimers());

  it("returns typed data from a valid success envelope", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, {
      ok: true,
      data: { id: "client_1" },
    }));

    await expect(
      requestBff("/api/bff/example", z.object({ id: z.string() }), {
        method: "POST",
        body: { email: "hi@example.com" },
        fetcher,
      }),
    ).resolves.toEqual({ id: "client_1" });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/example",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "hi@example.com" }),
      }),
    );
  });

  it("throws BffClientError for valid error envelopes", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(403, {
      ok: false,
      error: { code: "FORBIDDEN", message: "Nope" },
    }));

    await expect(
      requestBff("/api/bff/example", z.object({ id: z.string() }), { fetcher }),
    ).rejects.toMatchObject({
      name: "BffClientError",
      code: "FORBIDDEN",
      status: 403,
      message: "Nope",
      requestId: undefined,
    });
  });

  it.each([409, 500])("preserves the server reference from an integrated HTTP %s error", async (status) => {
    const requestId = `bff-axiom-canary-browser-${status}`;
    const fetcher = vi.fn().mockResolvedValue(serverErrorResponse(status, requestId));

    await expect(
      requestBff("/api/bff/example", z.object({ id: z.string() }), { fetcher }),
    ).rejects.toMatchObject({ status, requestId });
  });

  it("uses a valid response header for non-JSON diagnostics", async () => {
    const response = new Response("not json", {
      status: 502,
      headers: { "x-request-id": "node:non-json-42" },
    });

    await expect(
      requestBff("/api/bff/example", z.object({ id: z.string() }), {
        fetcher: vi.fn().mockResolvedValue(response),
      }),
    ).rejects.toMatchObject({ requestId: "node:non-json-42" });
  });

  it("drops the reference when valid header and metadata values disagree", async () => {
    const response = jsonResponse(409, {
      ok: false,
      error: { code: "CONFLICT", message: "Nope" },
      meta: { requestId: "node:body-42" },
    }, { "x-request-id": "node:header-42" });

    await expect(
      requestBff("/api/bff/example", z.object({ id: z.string() }), {
        fetcher: vi.fn().mockResolvedValue(response),
      }),
    ).rejects.toMatchObject({ requestId: undefined });
  });

  it("drops the reference when either response carrier is malformed", async () => {
    const response = jsonResponse(500, {
      ok: false,
      error: { code: "INTERNAL", message: "Nope" },
      meta: { requestId: "contains spaces" },
    }, { "x-request-id": "node:valid-header" });

    await expect(
      requestBff("/api/bff/example", z.object({ id: z.string() }), {
        fetcher: vi.fn().mockResolvedValue(response),
      }),
    ).rejects.toMatchObject({ requestId: undefined });
  });

  it("preserves INVALID_RESPONSE for an empty metadata reference", async () => {
    const response = jsonResponse(500, {
      ok: false,
      error: { code: "INTERNAL", message: "Nope" },
      meta: { requestId: "" },
    }, { "x-request-id": "node:valid-header" });

    await expect(
      requestBff("/api/bff/example", z.object({ id: z.string() }), {
        fetcher: vi.fn().mockResolvedValue(response),
      }),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      requestId: undefined,
    });
  });

  it("retains a trusted reference when the response contract is otherwise invalid", async () => {
    const response = jsonResponse(200, {
      ok: true,
      meta: { requestId: "node:invalid-contract-42" },
    }, { "x-request-id": "node:invalid-contract-42" });

    await expect(
      requestBff("/api/bff/example", z.object({ id: z.string() }), {
        fetcher: vi.fn().mockResolvedValue(response),
      }),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      requestId: "node:invalid-contract-42",
    });
  });

  it("does not invent a reference when transport fails before a response", async () => {
    const transportError = new Error("offline");
    const caught = await requestBff("/api/bff/example", z.object({ id: z.string() }), {
      fetcher: vi.fn().mockRejectedValue(transportError),
    }).catch((error) => error);

    expect(caught).toBe(transportError);
    expect(caught).not.toHaveProperty("requestId");
  });

  it("throws INVALID_RESPONSE when the envelope does not match", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));

    await expect(
      requestBff("/api/bff/example", z.object({ id: z.string() }), { fetcher }),
    ).rejects.toBeInstanceOf(BffClientError);
  });

  it("keeps the opt-in deadline active while a response body stalls after headers", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_path: RequestInfo | URL, init?: RequestInit) => Promise.resolve({
      status: 200,
      headers: new Headers(),
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    } as Response));

    const pending = requestBff("/api/bff/example", z.object({ id: z.string() }), {
      fetcher,
      timeoutMs: 25_000,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      status: 0,
      details: { reason: "timeout" },
    });
    await vi.advanceTimersByTimeAsync(25_000);
    await rejection;
  });
});

describe("bffErrorMessage", () => {
  it("appends the support code an operator has to quote to the provider", () => {
    const error = new BffClientError(
      {
        code: "UPSTREAM_UNAVAILABLE",
        message: "DHL: cutoff",
        details: { supportCode: "DHL-20260601222250-ABC123" },
      },
      503,
    );

    expect(bffErrorMessage(error)).toBe("DHL: cutoff (DHL-20260601222250-ABC123)");
  });

  it("returns the bare message when the error carries no support code", () => {
    expect(bffErrorMessage(new Error("boom"))).toBe("boom");
    expect(
      bffErrorMessage(new BffClientError({ code: "CONFLICT", message: "taken" }, 409)),
    ).toBe("taken");
  });

  it("falls back to a plain object message, then to String()", () => {
    expect(bffErrorMessage({ message: "postgrest said no" })).toBe("postgrest said no");
    expect(bffErrorMessage("plain string")).toBe("plain string");
    expect(bffErrorMessage(null)).toBe("null");
  });
});

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function serverErrorResponse(status: number, requestId: string): Response {
  let responseStatus = 200;
  let body: unknown;
  const headers = new Headers();
  const res = {
    setHeader: (name: string, value: string) => { headers.set(name, value); },
    status: (value: number) => { responseStatus = value; return res; },
    json: (value: unknown) => { body = value; return res; },
  } as unknown as VercelResponse;
  const req = {
    method: "GET",
    headers: { "x-request-id": requestId },
    query: {},
  } as unknown as VercelRequest;
  installObservedRequestContext(req, res);
  sendBffError(res, status === 409 ? "CONFLICT" : "INTERNAL", "Nope", { status });
  return new Response(JSON.stringify(body), { status: responseStatus, headers });
}
