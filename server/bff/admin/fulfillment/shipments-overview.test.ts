import { describe, expect, it, vi } from "vitest";
import handler from "./shipments-overview.js";

vi.mock("./shared.js", () => ({
  createFulfillmentAdminAuthContext: () => null,
  authorizeFulfillmentAdmin: vi.fn(),
}));

describe("fulfillment shipments overview admin BFF route", () => {
  it("executes the observed route and fails closed before persistence without managed auth env", async () => {
    const { req, res, output } = routeFixture();
    await handler(req as never, res as never);
    expect(output).toMatchObject({ status: 500, body: { ok: false, error: { code: "INTERNAL" } } });
  });
});

function routeFixture() {
  const output = { status: 200, body: {} as Record<string, unknown> };
  const req = { method: "GET", headers: {} };
  const res = { statusCode: 200, setHeader() {}, status(code: number) { output.status = code; return res; },
    json(body: Record<string, unknown>) { output.body = body; return res; } };
  return { req, res, output };
}
