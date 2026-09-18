import { describe, expect, it, vi } from "vitest";

const directList = vi.fn();
vi.mock("../../../marketing/prelaunchAcquisitionDirect.js", () => ({
  isDirectPrelaunchAcquisitionBundle: () => true,
  isPrelaunchAcquisitionListView: (req: { query: Record<string, string> }) => req.query.view === "prelaunch_acquisition_v1",
  createPrelaunchAcquisitionListHandler: () => directList,
}));
import handler from "./leads.js";

function response() {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe("marketing prelaunch admin BFF routes", () => {
  it("load through the observed admin route wrapper", () => {
    expect(handler).toBeTypeOf("function");
  });

  it("routes only the explicit direct V1 projection", async () => {
    const direct = response();
    await handler({ method: "GET", headers: {}, query: { view: "prelaunch_acquisition_v1" } } as never, direct as never);
    expect(directList).toHaveBeenCalledOnce();

    const legacy = response();
    await handler({ method: "GET", headers: {}, query: {} } as never, legacy as never);
    expect(legacy.status).toHaveBeenCalledWith(404);
  });
});
