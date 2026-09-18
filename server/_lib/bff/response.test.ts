import { describe, expect, it, vi } from "vitest";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "./response.js";
import type { VercelResponse } from "../types/vercel.js";
import type { VercelRequest } from "../types/vercel.js";
import { installObservedRequestContext } from "../observability/requestContext.js";

describe("BFF response helpers", () => {
  it("sends success envelopes without undefined branches", () => {
    const res = createResponse();

    sendBffSuccess(res, { id: "client_1" });

    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { id: "client_1" },
    });
  });

  it("allows explicit cache headers for safe public read-only responses", () => {
    const res = createResponse();

    sendBffSuccess(
      res,
      { products: [] },
      { contractVersion: "catalog.v1" },
      { cacheControl: "public, s-maxage=300, stale-while-revalidate=86400" },
    );

    expect(res.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "public, s-maxage=300, stale-while-revalidate=86400",
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("preserves explicit metadata when no observed context is installed", () => {
    const res = createResponse();

    sendBffSuccess(res, { id: "client_1" }, {
      contractVersion: "example.v1",
      requestId: "legacy-request-1",
    });

    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { id: "client_1" },
      meta: { contractVersion: "example.v1", requestId: "legacy-request-1" },
    });
  });

  it("returns the observed header without expanding a success envelope", () => {
    const res = createResponse();
    installObservedRequestContext(request("bff-axiom-canary-response-success"), res);

    sendBffSuccess(res, { id: "client_1" });

    expect(res.setHeader).toHaveBeenCalledWith(
      "x-request-id",
      "bff-axiom-canary-response-success",
    );
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { id: "client_1" } });
  });

  it("enriches existing success metadata with the observed reference", () => {
    const res = createResponse();
    installObservedRequestContext(request("bff-axiom-canary-response-meta"), res);

    sendBffSuccess(res, { id: "client_1" }, {
      contractVersion: "example.v1",
      nextCursor: "client_2",
    });

    expect(res.setHeader).toHaveBeenCalledWith(
      "x-request-id",
      "bff-axiom-canary-response-meta",
    );
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { id: "client_1" },
      meta: {
        contractVersion: "example.v1",
        nextCursor: "client_2",
        requestId: "bff-axiom-canary-response-meta",
      },
    });
  });

  it("maps standard error codes to HTTP status", () => {
    const res = createResponse();

    sendBffError(res, "RATE_LIMITED", "Too many requests");

    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: { code: "RATE_LIMITED", message: "Too many requests" },
    });
  });

  it("returns the observed reference in a non-cacheable error body and header", () => {
    const res = createResponse();
    installObservedRequestContext(request("bff-axiom-canary-response-error"), res);

    sendBffError(res, "CONFLICT", "Already changed", {
      meta: { contractVersion: "example.v1" },
    });

    expect(res.setHeader).toHaveBeenCalledWith(
      "x-request-id",
      "bff-axiom-canary-response-error",
    );
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: { code: "CONFLICT", message: "Already changed" },
      meta: {
        contractVersion: "example.v1",
        requestId: "bff-axiom-canary-response-error",
      },
    });
  });

  it("omits request-specific references from shared cached responses", () => {
    const res = createResponse();
    installObservedRequestContext(request("bff-axiom-canary-cached"), res);

    sendBffSuccess(
      res,
      { products: [] },
      { contractVersion: "catalog.v1", requestId: "stale-request" },
      { cacheControl: "public, s-maxage=300" },
    );

    expect(res.setHeader).not.toHaveBeenCalledWith("x-request-id", expect.anything());
    expect(res.removeHeader).toHaveBeenCalledWith("x-request-id");
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { products: [] },
      meta: { contractVersion: "catalog.v1" },
    });
  });

  it("sets Allow header for method errors", () => {
    const res = createResponse();

    sendMethodNotAllowed(res, ["GET"]);

    expect(res.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(res.status).toHaveBeenCalledWith(405);
  });
});

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    removeHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;

  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function request(requestId: string): VercelRequest {
  return {
    method: "GET",
    headers: { "x-request-id": requestId },
    query: {},
  } as unknown as VercelRequest;
}
