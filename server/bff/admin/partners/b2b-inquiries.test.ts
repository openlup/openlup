import { describe, expect, it, vi } from "vitest";

vi.mock("../../../_lib/observability/route.js", () => ({
  withObservedRoute: (_options: unknown, routeHandler: unknown) => routeHandler,
}));
vi.mock("../../partners/partnerAcquisitionDirect.js", () => ({
  isDirectPartnerAcquisitionBundle: () => true,
  isPartnerAcquisitionView: () => false,
  createPartnerAcquisitionListHandler: () => vi.fn(),
}));
import handler from "./b2b-inquiries.js";

function response() {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe("partners B2B inquiries admin BFF route", () => {
  it("loads through the observed admin route wrapper", () => {
    expect(handler).toBeTypeOf("function");
  });

  it("executes the mounted direct view refusal", async () => {
    const res = response();
    await handler({ method: "GET", headers: {}, query: {} } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });
});
