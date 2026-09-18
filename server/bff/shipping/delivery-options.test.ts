import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";

function request(method: string): VercelRequest {
  return { method, query: {}, body: {}, headers: {} } as unknown as VercelRequest;
}

function createResponse() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: vi.fn(),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res as unknown as VercelResponse;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res as unknown as VercelResponse;
    }),
    end: vi.fn(() => res as unknown as VercelResponse),
  };
  return res;
}

describe("delivery-options route", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    // Force the fail-safe static catalog so the happy path is deterministic.
    delete process.env.COMMERCE_DHL_ONLY_DELIVERY;
    delete process.env.OMNIPACK_MERCHANT_DICTIONARY_JSON;
    delete process.env.OMNIPACK_ENABLED_CARRIERS;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("returns the delivery-options contract on GET (unconditional; no flag gate)", async () => {
    const { default: handler } = await import("./delivery-options.js");
    const res = createResponse();

    await handler(request("GET"), res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it("rejects a non-GET method with 405", async () => {
    const { default: handler } = await import("./delivery-options.js");
    const res = createResponse();

    await handler(request("POST"), res as unknown as VercelResponse);

    expect(res.statusCode).toBe(405);
  });
});
