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

describe("prelaunch lead detail impact edge", () => {
  it("executes the mounted dynamic route through an exact-path Vitest target", async () => {
    const res = response();
    await handler({
      method: "GET",
      headers: {},
      query: { sourceRef: "acquisition-case:11111111-1111-4111-8111-111111111111" },
    } as never, res as never);

    expect(directDetail).toHaveBeenCalledOnce();
  });
});
