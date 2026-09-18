import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
  createComposition: vi.fn(),
  createHandler: vi.fn(),
  composed: vi.fn(),
}));
vi.mock("../../../adapters/localReferenceStoreAdapter.js", () => ({ localReferenceDemoProfileEnabled: mocks.profile }));
vi.mock("../../admin/commerce/shared.js", () => ({ createCommerceAdminReferenceReadComposition: mocks.createComposition }));
vi.mock("../../../domains/commerce/referenceJourneyReadbackHandlers.js", () => ({ createReferenceJourneyOperatorReadbackHandler: mocks.createHandler }));
vi.mock("../../../adapters/referenceJourneyOrderReadbackAdapter.js", () => ({ referenceJourneyOrderReadbackAdapter: { kind: "readback" } }));
const { operatorReferenceJourneyOrderReadbackHandler } = await import("./order-readback.js");

function response() { const out: { status?: number } = {}; const res = { setHeader: vi.fn(), status: vi.fn((status: number) => { out.status = status; return res; }), json: vi.fn(() => res) }; return { out, res: res as never }; }
const request = { method: "GET", query: {}, headers: {} } as never;

describe("operator reference order readback route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.composed.mockResolvedValue(undefined);
  });

  it("checks the local profile before operator composition", async () => {
    mocks.profile.mockReturnValue(false); const result = response(); await operatorReferenceJourneyOrderReadbackHandler(request, result.res);
    expect(result.out.status).toBe(404);
    expect(mocks.createComposition).not.toHaveBeenCalled();
    expect(mocks.createHandler).not.toHaveBeenCalled();
  });

  it("passes only the neutral lazy composition to the handler", async () => {
    const composition = {
      authorize: vi.fn(),
      governance: vi.fn(),
      servicePort: vi.fn(),
    };
    mocks.profile.mockReturnValue(true);
    mocks.createComposition.mockReturnValue(composition);
    mocks.createHandler.mockReturnValue(mocks.composed);
    await operatorReferenceJourneyOrderReadbackHandler(request, response().res);
    expect(mocks.createComposition).toHaveBeenCalledWith(request);
    expect(mocks.createHandler).toHaveBeenCalledWith({
      ...composition,
      readback: { kind: "readback" },
    });
    expect(mocks.composed).toHaveBeenCalledWith(request, expect.anything());
  });
});
