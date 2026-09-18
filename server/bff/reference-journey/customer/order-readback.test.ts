import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
  enabled: vi.fn(),
  createComposition: vi.fn(),
  createHandler: vi.fn(),
  composed: vi.fn(),
}));
vi.mock("../../../adapters/localReferenceStoreAdapter.js", () => ({ localReferenceDemoProfileEnabled: mocks.profile }));
vi.mock("../../customers/shared.js", () => ({
  customerSelfServiceEnabled: mocks.enabled,
  createCustomerReferenceReadComposition: mocks.createComposition,
}));
vi.mock("../../../domains/commerce/referenceJourneyReadbackHandlers.js", () => ({ createReferenceJourneyCustomerReadbackHandler: mocks.createHandler }));
vi.mock("../../../adapters/referenceJourneyOrderReadbackAdapter.js", () => ({ referenceJourneyOrderReadbackAdapter: { kind: "readback" } }));
const { customerReferenceJourneyOrderReadbackHandler } = await import("./order-readback.js");

function response() { const out: { status?: number } = {}; const res = { setHeader: vi.fn(), status: vi.fn((status: number) => { out.status = status; return res; }), json: vi.fn(() => res) }; return { out, res: res as never }; }
const request = { method: "GET", query: {}, headers: {} } as never;

describe("customer reference order readback route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.composed.mockResolvedValue(undefined);
  });

  it("checks the local profile before customer flags or composition", async () => {
    mocks.profile.mockReturnValue(false); const result = response(); await customerReferenceJourneyOrderReadbackHandler(request, result.res);
    expect(result.out.status).toBe(404);
    expect(mocks.enabled).not.toHaveBeenCalled();
    expect(mocks.createComposition).not.toHaveBeenCalled();
    expect(mocks.createHandler).not.toHaveBeenCalled();
  });

  it("passes only the neutral request composition after the local customer gates", async () => {
    const composition = {
      authorize: vi.fn(),
      actorPort: vi.fn(),
    };
    mocks.profile.mockReturnValue(true);
    mocks.enabled.mockReturnValue(true);
    mocks.createComposition.mockReturnValue(composition);
    mocks.createHandler.mockReturnValue(mocks.composed);
    await customerReferenceJourneyOrderReadbackHandler(request, response().res);
    expect(mocks.createComposition).toHaveBeenCalledWith(request);
    expect(mocks.createHandler).toHaveBeenCalledWith({
      ...composition,
      readback: { kind: "readback" },
    });
    expect(mocks.composed).toHaveBeenCalledWith(request, expect.anything());
  });
});
