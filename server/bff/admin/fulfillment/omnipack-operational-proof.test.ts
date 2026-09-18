import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import handler from "./omnipack-operational-proof.js";

vi.mock("./shared.js", () => ({
  createFulfillmentAdminAuthContext: () => null,
  authorizeFulfillmentAdmin: vi.fn(),
}));

describe("fulfillment OmniPack operational proof admin BFF route", () => {
  it("executes the observed wrapper, fails closed without auth env, and contains no provider calls", async () => {
    const source = readFileSync(
      join(process.cwd(), "server/bff/admin/fulfillment/omnipack-operational-proof.ts"),
      "utf8",
    );

    const { req, res, output } = routeFixture();
    await handler(req as never, res as never);
    expect(output).toMatchObject({ status: 500, body: { ok: false, error: { code: "INTERNAL" } } });
    expect(source).toContain("createOmnipackOperationalProofHandler");
    expect(source).toContain("createSupabaseOmnipackOperationalProofPort");
    expect(source).not.toMatch(/\.(?:from|rpc|storage)\b/);
    expect(source).not.toContain("fetch(");
  });
});

function routeFixture() {
  const output = { status: 200, body: {} as Record<string, unknown> };
  const req = { method: "GET", headers: {} };
  const res = { statusCode: 200, setHeader() {}, status(code: number) { output.status = code; return res; },
    json(body: Record<string, unknown>) { output.body = body; return res; } };
  return { req, res, output };
}
