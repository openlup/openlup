import { describe, expect, it, vi } from "vitest";

const { directHandler } = vi.hoisted(() => ({ directHandler: vi.fn(async () => undefined) }));

vi.mock("../../_lib/observability/route.js", () => ({
  withObservedRoute: (_options: unknown, routeHandler: unknown) => routeHandler,
}));
vi.mock("./partnerAcquisitionDirect.js", () => ({
  isDirectPartnerAcquisitionBundle: () => true,
  createPartnerAcquisitionSubmitHandler: () => directHandler,
}));
import handler from "./b2b-inquiries.js";

describe("partners B2B inquiries public BFF route", () => {
  it("loads through the observed public route wrapper", () => {
    expect(handler).toBeTypeOf("function");
  });

  it("executes the mounted direct route branch", async () => {
    const req = { method: "GET", headers: {}, query: {} };
    const res = {};
    await handler(req as never, res as never);
    expect(directHandler).toHaveBeenCalledWith(req, res);
  });
});
