import { describe, expect, it, vi } from "vitest";

const { directHandler } = vi.hoisted(() => ({ directHandler: vi.fn(async () => undefined) }));

vi.mock("../../../../_lib/observability/route.js", () => ({
  withObservedRoute: (_options: unknown, routeHandler: unknown) => routeHandler,
}));
vi.mock("../../../partners/partnerAcquisitionDirect.js", () => ({
  isDirectPartnerAcquisitionBundle: () => true,
  createPartnerAcquisitionTransitionHandler: () => directHandler,
}));
import handler from "./status.js";

describe("partners B2B inquiry status admin BFF route", () => {
  it("loads through the observed admin route wrapper", () => {
    expect(handler).toBeTypeOf("function");
  });

  it("executes the mounted direct status route branch", async () => {
    const req = { method: "GET", headers: {}, query: {} };
    const res = {};
    await handler(req as never, res as never);
    expect(directHandler).toHaveBeenCalledWith(req, res);
  });
});
