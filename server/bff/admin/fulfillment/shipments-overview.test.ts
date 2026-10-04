import { describe, expect, it, vi } from "vitest";
import handler from "./shipments-overview.js";

const auth = vi.hoisted(() => ({ context: vi.fn(() => null), authorize: vi.fn() }));
vi.mock("./shared.js", () => ({
  createFulfillmentAdminAuthContext: auth.context,
  authorizeFulfillmentAdmin: auth.authorize,
}));

describe("fulfillment shipments overview admin BFF route", () => {
  it("public default refuses before resolving operator authorization", async () => {
    const { req, res, output } = routeFixture();
    await handler(req as never, res as never);
    expect(auth.context).not.toHaveBeenCalled();
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(output).toMatchObject({ status: 503, body: { ok: false, error: { code: "UPSTREAM_UNAVAILABLE", details: { reason: "adopter_policy_required" } } } });
  });
});

function routeFixture() {
  const output = { status: 200, body: {} as Record<string, unknown> };
  const req = { method: "GET", headers: {} };
  const res = { statusCode: 200, setHeader() {}, status(code: number) { output.status = code; return res; },
    json(body: Record<string, unknown>) { output.body = body; return res; } };
  return { req, res, output };
}
