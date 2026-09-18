import { describe, expect, it, vi } from "vitest";

const directDetail = vi.fn();
vi.mock("../../../../marketing/prelaunchAcquisitionDirect.js", () => ({
  isDirectPrelaunchAcquisitionBundle: () => true,
  isPrelaunchAcquisitionSourceRef: (req: { query: Record<string, string> }) =>
    req.query.sourceRef?.startsWith("acquisition-case:"),
  createPrelaunchAcquisitionDetailHandler: () => directDetail,
}));
import handler from "./[sourceRef].js";

function response() {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe("marketing prelaunch lead detail admin BFF route", () => {
  it("loads through the observed admin route wrapper", () => {
    expect(handler).toBeTypeOf("function");
  });

  it("routes canonical direct case refs and rejects legacy source refs", async () => {
    const direct = response();
    await handler({
      method: "GET", headers: {},
      query: { sourceRef: "acquisition-case:11111111-1111-4111-8111-111111111111" },
    } as never, direct as never);
    expect(directDetail).toHaveBeenCalledOnce();

    const legacy = response();
    await handler({ method: "GET", headers: {}, query: { sourceRef: "testers:legacy" } } as never, legacy as never);
    expect(legacy.status).toHaveBeenCalledWith(404);
  });
});
