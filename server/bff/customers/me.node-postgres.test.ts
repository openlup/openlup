import { afterEach, describe, expect, it, vi } from "vitest";

const FLAG = "COMMERCE_V2_W12_CUSTOMER_AUTH_UI";
const ORIGINAL_FLAG = process.env[FLAG];
const ORIGINAL_BUNDLE = process.env.PLATFORM_BUNDLE;

afterEach(() => {
  vi.doUnmock("../../runtime/customers/customerIdentityBinding.js");
  vi.resetModules();
  if (ORIGINAL_FLAG === undefined) delete process.env[FLAG];
  else process.env[FLAG] = ORIGINAL_FLAG;
  if (ORIGINAL_BUNDLE === undefined) delete process.env.PLATFORM_BUNDLE;
  else process.env.PLATFORM_BUNDLE = ORIGINAL_BUNDLE;
});

describe("GET /api/bff/customers/me direct identity errors", () => {
  it("maps invalid direct verifier configuration to the existing authentication-upstream envelope", async () => {
    const mePort = { getCustomerMe: vi.fn() };
    const handler = await routeWith({
      authenticateUser: vi.fn(async () => {
        throw new Error("invalid configuration");
      }),
      mePort,
    });
    const res = response();

    await handler(request(), res as never);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "Customer authentication failed",
      },
      meta: { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    });
    expect(mePort.getCustomerMe).not.toHaveBeenCalled();
  });

  it("maps a rejected direct token to the existing unauthorized envelope", async () => {
    const mePort = { getCustomerMe: vi.fn() };
    const handler = await routeWith({
      authenticateUser: vi.fn(async () => ({
        ok: false as const,
        code: "UNAUTHORIZED",
        message: "Customer session required",
      })),
      mePort,
    });
    const res = response();

    await handler(request(), res as never);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: { code: "UNAUTHORIZED", message: "Customer session required" },
      meta: { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    });
    expect(mePort.getCustomerMe).not.toHaveBeenCalled();
  });
});

async function routeWith(binding: unknown) {
  process.env[FLAG] = "true";
  process.env.PLATFORM_BUNDLE = "node-postgres";
  vi.doMock("../../runtime/customers/customerIdentityBinding.js", () => ({
    createCustomerIdentityBinding: vi.fn(() => binding),
  }));
  return (await import("./me.js")).default;
}

function request() {
  return {
    method: "GET",
    query: {},
    headers: { authorization: "Bearer customer-token" },
  } as never;
}

function response() {
  const res = { json: vi.fn(), setHeader: vi.fn(), status: vi.fn() };
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
