import { describe, expect, it, vi } from "vitest";
import handler from "./content.js";

vi.mock("../../../../_lib/observability/route.js", () => ({
  withObservedRoute: (_options: unknown, routeHandler: typeof handler) => routeHandler,
}));

describe("communications template content admin BFF route", () => {
  it("loads through the observed admin route wrapper", () => {
    expect(handler).toBeTypeOf("function");
  });

  it("fails closed for an invalid bearer", async () => {
    const res = response();
    await handler({ method: "PATCH", headers: { authorization: "Bearer invalid" } } as never, res as never);
    expect(res.statusCode).toBe(401);
    expect(res.payload).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
  });
});

function response() {
  return {
    statusCode: 200,
    payload: undefined as unknown,
    setHeader: vi.fn(),
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.payload = value; return this; },
  };
}
