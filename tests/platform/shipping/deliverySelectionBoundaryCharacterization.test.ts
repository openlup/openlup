import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDeliverySelectionPort, createValidatedDeliverySelectionPort } from "../../../server/bff/shipping/deliverySelectionFactory.js";
import { createPickupPointSearchPort } from "../../../server/bff/shipping/pickupPointSearchFactory.js";
import { createDeliveryOptionsHandler, createPickupPointSearchHandler, createPickupPointValidationHandler } from "../../../server/domains/shipping/deliverySelectionHandler.js";
import { pickupPointAddressSchema } from "../../../src/domains/shipping/deliverySelectionContracts.js";

// The donor template is private and absent here. Equivalent synthetic dictionary
// plumbing exercises the existing loader and empty-allowlist branch unchanged.
// The expected country is the reference contract's own literal, read from its schema.
const referenceCountry = pickupPointAddressSchema.shape.country.value;
const status = { providerStatus: "ready", localStatus: "provider_received", timelineEvent: "ready", customerVisible: false, terminal: false, quarantine: false };
const dictionary = JSON.stringify({
  productGroups: [{ code: "GROUP", appliesToSkus: ["ITEM"] }],
  carriers: [{ kind: "sample", code: "SAMPLE", services: [{ code: "STANDARD", deliveryKind: "courier", requiresPickupPoint: false }] }],
  pickupPoints: {},
  statuses: { orders: ["ready"], fulfilments: ["ready"], shipments: ["ready"], subStatuses: [] },
  statusMappings: { orders: [status], fulfilments: [status], shipments: [status], subStatuses: [] },
  stageSkus: [{ sku: "ITEM", productGroup: "GROUP", stockedQuantity: 1, pack: { weightGrams: 1, lengthMm: 1, widthMm: 1, heightMm: 1 } }],
});
function response() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res);
  return res;
}
afterEach(() => vi.unstubAllGlobals());

describe("W6 resolved delivery sources → handler contracts", () => {
  it("refuses empty dictionary options at the handler while malformed dictionary falls back to accepted routes", async () => {
    const configured = resolveDeliverySelectionPort({ OMNIPACK_MERCHANT_DICTIONARY_JSON: dictionary });
    const fallback = resolveDeliverySelectionPort({ OMNIPACK_MERCHANT_DICTIONARY_JSON: "invalid", OMNIPACK_ENABLED_CARRIERS: "dpd,unknown" });
    expect(configured.source).toBe("dictionary");
    expect(fallback.source).toBe("static_accepted_catalog");
    const empty = response(), narrowed = response();
    await createDeliveryOptionsHandler(configured.port)({ method: "GET" } as never, empty as never);
    await createDeliveryOptionsHandler(fallback.port)({ method: "GET" } as never, narrowed as never);
    expect(await configured.port.listOptions()).toEqual([]);
    expect(empty.status).toHaveBeenCalledWith(502);
    expect(empty.json).toHaveBeenCalledWith({ ok: false, error: { code: "INVALID_RESPONSE", message: "Delivery options returned invalid response" } });
    expect(narrowed.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, data: expect.objectContaining({ options: [
      expect.objectContaining({ carrierKind: "dpd", carrierCode: "DPD_COURIER_STANDARD", serviceCode: "DPD_COURIER_STANDARD", addressRequired: true }),
    ] }) }));
  });
  it("returns canonical point evidence from injected HTTP, never the browser address", async () => {
    const fetchImpl = vi.fn(async (_url: unknown) => ({ ok: true, status: 200, json: async () => ({ name: "TEST01", status: "Operating",
      address: { line1: "Example 1" }, address_details: { city: "Warszawa", post_code: "00-001" } }) }));
    const port = createValidatedDeliverySelectionPort({ INPOST_POINTS_API_BASE_URL: "https://example.invalid" }, fetchImpl as never);
    const res = response();
    await createPickupPointValidationHandler(port)({ method: "POST", body: { carrierKind: "inpost", pointId: "TEST01" } } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ valid: true,
      pickupPoint: { id: "TEST01", provider: "inpost", name: "Paczkomat TEST01", address: { line1: "Example 1", postalCode: "00-001", city: "Warszawa", country: referenceCountry } },
    }) }));
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://example.invalid/points/TEST01");
  });
  it("returns an explicit invalid point for captured missing HTTP evidence", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }));
    const res = response();
    await createPickupPointValidationHandler(createValidatedDeliverySelectionPort({}, fetchImpl as never))(
      { method: "POST", body: { carrierKind: "inpost", pointId: "MISSING" } } as never, res as never);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, data: expect.objectContaining({ valid: false, pickupPoint: null }) }));
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("lets unsupported or excluded search resolve empty without any HTTP call", async () => {
    const fetchImpl = vi.fn(() => { throw new Error("unexpected HTTP"); });
    vi.stubGlobal("fetch", fetchImpl);
    const handler = createPickupPointSearchHandler(createPickupPointSearchPort({ OMNIPACK_ENABLED_CARRIERS: "dpd" }));
    for (const carrierKind of ["inpost", "orlen"]) {
      const res = response();
      await handler({ method: "POST", body: { carrierKind, postalCode: "00-001" } } as never, res as never);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ carrierKind, points: [] }) }));
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
