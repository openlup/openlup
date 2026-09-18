import { afterEach, describe, expect, it, vi } from "vitest";
import handler from "./delivery-preferences.js";

function mockRes() {
  const res = { statusCode: 0, payload: null as unknown };
  const api = {
    setHeader: vi.fn(() => api),
    status: vi.fn((code: number) => { res.statusCode = code; return api; }),
    json: vi.fn((body: unknown) => { res.payload = body; return api; }),
    end: vi.fn(() => api),
  };
  return { res, api };
}

afterEach(() => {
  delete process.env.COMMERCE_V2_W12_CUSTOMER_AUTH_UI;
  delete process.env.COMMERCE_CUSTOMER_PREFERENCES_ENABLED;
});

describe("customers/delivery-preferences route", () => {
  it("is a mounted handler that fails closed when the preferences flags are off", async () => {
    delete process.env.COMMERCE_V2_W12_CUSTOMER_AUTH_UI;
    delete process.env.COMMERCE_CUSTOMER_PREFERENCES_ENABLED;
    expect(typeof handler).toBe("function");

    const { api } = mockRes();
    await handler(
      { method: "GET", headers: {}, query: {} } as never,
      api as never,
    );
    // Disabled => a BFF error response was written (no Supabase client, no throw).
    expect(api.json).toHaveBeenCalled();
  });
});
