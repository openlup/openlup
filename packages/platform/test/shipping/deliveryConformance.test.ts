import { describe, expect, it, vi } from "vitest";
import { createBffResponder } from "@openlup/platform/bff";
import {
  DELIVERY_SELECTION_CONTRACT_VERSION, PICKUP_POINT_SEARCH_CONTRACT_VERSION,
  createDeliveryOptionsHandler, createPickupPointSearchHandler, createPickupPointValidationHandler,
  resolveDeliverySelectionEvidence, summarizeDeliverySelection,
  type DeliverySelectionPort, type DeliverySelectionSchemas, type PickupPointSearchPort,
} from "@openlup/platform/shipping";
import type { DeliveryKind, DeliveryProviderKind, DeliveryCarrierKind, DeliveryService, PickupPoint, DeliveryOption, DeliveryOptionsResponse, PickupPointSearchRequest, PickupPointSearchResult, PickupPointSearchResponse, PickupPointValidationRequest, PickupPointValidationResponse } from "@openlup/platform/shipping/contracts";

function response() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res);
  return res;
}

describe("shipping public conformance", () => {
  it("preserves method, request, port and response validation order with injected schemas", async () => {
    expect(DELIVERY_SELECTION_CONTRACT_VERSION).toBe("shipping.delivery_selection.v1");
    expect(PICKUP_POINT_SEARCH_CONTRACT_VERSION).toBe("shipping.pickup_point_search.v1");
    const calls: string[] = [];
    const refused = (name: string) => ({ safeParse: (_input: unknown) => {
      calls.push(name);
      return { success: false as const, error: { flatten: () => ({ fieldErrors: { selection: ["host policy"] } }) } };
    } });
    const schemas: DeliverySelectionSchemas = {
      deliveryOptionsResponseSchema: refused("options-response"),
      pickupPointSearchRequestSchema: refused("search-request"),
      pickupPointSearchResponseSchema: refused("search-response"),
      pickupPointValidationRequestSchema: refused("validation-request"),
      pickupPointValidationResponseSchema: refused("validation-response"),
    };
    const port: DeliverySelectionPort = {
      listOptions: async () => { calls.push("list"); return []; },
      validatePickupPoint: async () => { calls.push("validate"); return null; },
    };
    const searchPort: PickupPointSearchPort = { searchPickupPoints: async () => { calls.push("search"); return []; } };
    const responder = createBffResponder();
    const options = createDeliveryOptionsHandler(port, schemas, responder);
    const search = createPickupPointSearchHandler(searchPort, schemas, responder);
    const validation = createPickupPointValidationHandler(port, schemas, responder);
    for (const handler of [options, search, validation]) {
      const res = response();
      await handler({ method: "DELETE" } as never, res as never);
      expect(res.status).toHaveBeenCalledWith(405);
    }
    expect(calls).toEqual([]);
    for (const handler of [search, validation]) {
      const res = response();
      await handler({ method: "POST", body: {} } as never, res as never);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: "BAD_REQUEST", details: { fieldErrors: { selection: ["host policy"] } } }) }));
    }
    expect(calls.splice(0)).toEqual(["search-request", "validation-request"]);
    const invalid = response();
    await options({ method: "GET" } as never, invalid as never);
    expect(calls.splice(0)).toEqual(["list", "options-response"]);
    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(invalid.json).toHaveBeenCalledWith({ ok: false, error: { code: "INVALID_RESPONSE", message: "Delivery options returned invalid response" } });
    const request: PickupPointValidationRequest = { pointId: "POINT", carrierKind: "sample" };
    schemas.pickupPointValidationRequestSchema = { safeParse: () => { calls.push("validation-request"); return { success: true, data: request }; } };
    schemas.pickupPointSearchRequestSchema = { safeParse: () => { calls.push("search-request"); return { success: true, data: { carrierKind: "sample", query: "place" } }; } };
    for (const handler of [createPickupPointValidationHandler(port, schemas, responder), createPickupPointSearchHandler(searchPort, schemas, responder)]) {
      const res = response();
      await handler({ method: "POST", body: request } as never, res as never);
      expect(res.status).toHaveBeenCalledWith(502);
    }
    expect(calls.splice(0)).toEqual(["validation-request", "validate", "validation-response", "search-request", "search", "search-response"]);
  });

  it("accepts substituted allowlists and rejects planted provider and carrier values", async () => {
    const responder = createBffResponder();
    const accepted = <T>(data: T) => ({ safeParse: (_input: unknown) => ({ success: true as const, data }) });
    const kind: DeliveryKind = "parcel-locker";
    const providerKind: DeliveryProviderKind = "provider-a";
    const carrierKind: DeliveryCarrierKind = "carrier-a";
    const service: DeliveryService = "standard";
    const point: PickupPoint = { id: "POINT", provider: carrierKind, name: "Point", address: { line1: "Street", postalCode: "CODE", city: "City", country: "ZZ" } };
    const option: DeliveryOption = { id: "route", kind, deliveryKind: kind, providerKind, carrierKind, carrierCode: "STANDARD", service, serviceCode: "STANDARD", label: "Route", description: "Pickup", pickupPointRequired: true, addressRequired: false };
    const searchRequest: PickupPointSearchRequest = { carrierKind, query: "place" };
    const result: PickupPointSearchResult = { id: point.id, carrierKind, name: point.name, address: point.address, location: null, locationDescription: null, openingHours: null, distanceMeters: null, pointKind: "locker", appAssisted: false };
    const optionsData: DeliveryOptionsResponse = { contractVersion: DELIVERY_SELECTION_CONTRACT_VERSION, options: [option] };
    const validationData: PickupPointValidationResponse = { contractVersion: DELIVERY_SELECTION_CONTRACT_VERSION, valid: true, pickupPoint: point };
    const searchData: PickupPointSearchResponse = { contractVersion: PICKUP_POINT_SEARCH_CONTRACT_VERSION, carrierKind, points: [result] };
    const schemas: DeliverySelectionSchemas = {
      deliveryOptionsResponseSchema: {
        safeParse(input) {
          const data = input as DeliveryOptionsResponse;
          if (data.options.every(value => value.providerKind === providerKind && value.carrierKind === carrierKind)) {
            return { success: true, data };
          }
          return { success: false, error: { flatten: () => ({ fieldErrors: { selection: ["host allowlist"] } }) } };
        },
      },
      pickupPointValidationRequestSchema: {
        safeParse(input) {
          const data = input as PickupPointValidationRequest;
          return data.carrierKind === carrierKind ? { success: true, data }
            : { success: false, error: { flatten: () => ({ fieldErrors: { carrierKind: ["host allowlist"] } }) } };
        },
      },
      pickupPointSearchRequestSchema: {
        safeParse(input) {
          const data = input as PickupPointSearchRequest;
          return data.carrierKind === carrierKind ? { success: true, data }
            : { success: false, error: { flatten: () => ({ fieldErrors: { carrierKind: ["host allowlist"] } }) } };
        },
      },
      pickupPointValidationResponseSchema: accepted(validationData),
      pickupPointSearchResponseSchema: accepted(searchData),
    };
    const port: DeliverySelectionPort = {
      listOptions: vi.fn(async () => [option]),
      validatePickupPoint: vi.fn(async () => point),
    };
    const searchPort: PickupPointSearchPort = { searchPickupPoints: vi.fn(async () => [result]) };
    const options = createDeliveryOptionsHandler(port, schemas, responder);
    const validation = createPickupPointValidationHandler(port, schemas, responder);
    const search = createPickupPointSearchHandler(searchPort, schemas, responder);
    for (const [selected, method, body, data, version] of [
      [options, "GET", undefined, optionsData, DELIVERY_SELECTION_CONTRACT_VERSION],
      [validation, "POST", { pointId: point.id, carrierKind }, validationData, DELIVERY_SELECTION_CONTRACT_VERSION],
      [search, "POST", searchRequest, searchData, PICKUP_POINT_SEARCH_CONTRACT_VERSION],
    ] as const) {
      const res = response();
      await selected({ method, body } as never, res as never);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true, data, meta: { contractVersion: version } });
    }
    // The reference provider enum includes this neutral value; the substituted host refuses it.
    for (const plant of [{ providerKind: "manual" }, { carrierKind: "carrier-b" }]) {
      vi.mocked(port.listOptions).mockResolvedValueOnce([{ ...option, ...plant }]);
      const res = response();
      await options({ method: "GET" } as never, res as never);
      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.json).toHaveBeenCalledWith({ ok: false, error: { code: "INVALID_RESPONSE", message: "Delivery options returned invalid response" } });
    }
    for (const handler of [validation, search]) {
      const res = response();
      await handler({ method: "POST", body: { pointId: point.id, carrierKind: "carrier-b" } } as never, res as never);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ ok: false, error: {
        code: "BAD_REQUEST",
        message: handler === validation ? "Invalid pickup point validation request" : "Invalid pickup point search request",
        details: { fieldErrors: { carrierKind: ["host allowlist"] } },
      } });
    }
    expect(port.validatePickupPoint).toHaveBeenCalledTimes(1);
    expect(searchPort.searchPickupPoints).toHaveBeenCalledTimes(1);
  });

  it("preserves authoritative contact refusal, legacy priority and summary normalization", () => {
    const legacy = { kind: "courier", providerKind: " Legacy ", service: " service " };
    const blocked = resolveDeliverySelectionEvidence({
      shippingAddressSnapshot: { deliveryContact: {} },
      fulfillmentMetadata: { selectedDelivery: legacy },
    });
    expect(blocked).toEqual({ selection: null, providerKind: null, source: "shippingDeliveryContact" });
    expect(summarizeDeliverySelection(blocked.selection)).toBeNull();
    const evidence = resolveDeliverySelectionEvidence({ fulfillmentMetadata: { selectedDelivery: legacy }, orderMetadata: { selectedDelivery: { kind: "parcel-locker" } } });
    expect(evidence).toEqual({ selection: legacy, providerKind: "legacy", source: "fulfillmentMetadata" });
    expect(summarizeDeliverySelection(evidence.selection, evidence.source)).toEqual({ deliveryKind: "courier", providerKind: "Legacy", carrierKind: null, carrierCode: null, serviceCode: "service", pickupPoint: null, source: "fulfillmentMetadata" });
    expect(summarizeDeliverySelection({ kind: "parcel-locker", pickupPoint: { pointId: " POINT ", name: " Point ", address: { line1: " Street ", postalCode: " CODE ", city: " City ", country: " ZZ " } } })).toEqual({ deliveryKind: "parcel-locker", providerKind: null, carrierKind: null, carrierCode: null, serviceCode: null, pickupPoint: { id: "POINT", name: "Point", address: { line1: "Street", postalCode: "CODE", city: "City", country: "ZZ" } } });
  });
});
