import { describe, expect, it, vi } from "vitest";
import { createCustomerAddressesHandler } from "../../../server/domains/customers/customerAddressesHandler.js";
import { createAddressCanonPostalCodeHandler } from "../../../server/domains/address-canon/addressCanonLookupHandler.js";
import { buildOrderDeliveryContact } from "../../../server/domains/commerce/commerceCheckoutOrchestrationHelpers.js";
import { resolveDeliverySelectionEvidence } from "../../../src/domains/shipping/readDeliverySelectionEvidence.js";
import type { CustomerAddressesResponse } from "../../../src/domains/customers/contracts.js";

import { addressCanonLocalitySchema } from "../../../src/domains/address-canon/contracts.js";
import { OMNIPACK_DELIVERY_OPTIONS } from "../../../src/domains/shipping/deliverySelectionContracts.js";

// Read the frozen witness values from the reference contracts for the neutrality ratchet.
const COUNTRY = addressCanonLocalitySchema.shape.countryCode.value;
const PROVIDER = OMNIPACK_DELIVERY_OPTIONS[2].providerKind;

const ID = "11111111-1111-4111-8111-111111111111", AT = "2026-10-20T10:00:00.000Z";
const manual = { idempotencyKey: "address-original", kind: "shipping", recipientName: "Example Buyer", contactPhone: null,
  line1: "Example 1", city: "Warszawa", postalCode: "00001", country: "Polska", isDefault: true };
function response() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res); return res;
}
function setup() {
  let book: CustomerAddressesResponse = { contractVersion: "customer.addresses.v1", ordererProfiles: [], addresses: [] };
  const getAddressBook = vi.fn(async () => book);
  const upsertAddress = vi.fn(async (_user: string, request: Record<string, unknown>) => {
    book = { ...book, addresses: [{ addressId: ID, kind: "shipping", label: null, recipientName: "Example Buyer", contactPhone: null,
      companyName: null, taxId: null, line1: String(request.line1), line2: null, city: String(request.city),
      postalCode: String(request.postalCode), country: String(request.country), isDefault: request.isDefault === true,
      deliveryNotes: null, courierInstructions: null, lastUsedAt: null, createdAt: AT, updatedAt: AT }] };
    return book;
  });
  const handler = createCustomerAddressesHandler({ authenticateUser: async () => ({ ok: true, userId: "session-user" }),
    addressBookPort: { getAddressBook }, addressMutationPort: { upsertAddress, deleteAddress: vi.fn() } as never });
  return { handler, getAddressBook, upsertAddress };
}

describe("W7 own-session address defaults → order contact projection", () => {
  it("normalizes a manual default address and reads it back under the authenticated identity", async () => {
    const f = setup(); const saved = response(), readback = response();
    await f.handler({ method: "POST", body: manual } as never, saved as never);
    await f.handler({ method: "GET", query: {} } as never, readback as never);
    expect(f.upsertAddress).toHaveBeenCalledExactlyOnceWith("session-user", expect.objectContaining({
      postalCode: "00-001", country: COUNTRY, isDefault: true, contactPhone: null, line1: "Example 1",
    }));
    expect(f.getAddressBook).toHaveBeenCalledExactlyOnceWith("session-user");
    expect(readback.json.mock.calls).toEqual(saved.json.mock.calls);
    expect(saved.status).toHaveBeenCalledWith(200);
  });
  it("projects the complete checkout contact alongside a contrasting edited address readback", async () => {
    const f = setup();
    const selectedDelivery = { providerKind: PROVIDER, carrierCode: "DPD_COURIER_STANDARD", serviceCode: "DPD_COURIER_STANDARD" };
    const contact = buildOrderDeliveryContact({ ...manual, contactPhone: "test-contact", contactEmail: "buyer@example.invalid",
      country: COUNTRY, postalCode: "00-001", selectedDelivery });

    const res = response();
    await f.handler({ method: "PATCH", body: { ...manual, addressId: ID, line1: "Changed 2", isDefault: false } } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    const readback = response();
    await f.handler({ method: "GET", query: {} } as never, readback as never);
    expect(readback.json).toHaveBeenCalledWith({ ok: true, data: {
      contractVersion: "customer.addresses.v1", ordererProfiles: [], addresses: [{
        addressId: ID, kind: "shipping", label: null, recipientName: "Example Buyer", contactPhone: null,
        companyName: null, taxId: null, line1: "Changed 2", line2: null, city: "Warszawa",
        postalCode: "00-001", country: COUNTRY, isDefault: false, deliveryNotes: null, courierInstructions: null,
        lastUsedAt: null, createdAt: AT, updatedAt: AT,
      }],
    } });
    expect(contact).toStrictEqual({
      schemaVersion: 1, source: "checkout_submission", revision: 1, recipientName: "Example Buyer",
      contactEmail: "buyer@example.invalid", contactPhone: "test-contact", line1: "Example 1", line2: null,
      city: "Warszawa", postalCode: "00-001", country: COUNTRY,
      selectedDelivery: { providerKind: PROVIDER, carrierCode: "DPD_COURIER_STANDARD", serviceCode: "DPD_COURIER_STANDARD" },
      deliveryInstructions: null, courierInstructions: null,
    });
    // Durable freeze belongs to omnipackDispatchMappers.test.ts and the retained native contact tests.
    expect(resolveDeliverySelectionEvidence({ shippingAddressSnapshot: { deliveryContact: contact },
      addressMetadata: { selectedDelivery: { providerKind: "changed" } } })).toEqual({
      selection: selectedDelivery, providerKind: PROVIDER, source: "shippingDeliveryContact",
    });
  });
  it("distinguishes offline suggestions from no matches while manual entry still saves", async () => {
    const lookupPostalCode = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({
      contractVersion: "address.canon.v1", query: { postalCode: "00-001" }, resolutionLevel: "postal_code", sources: [], candidates: [],
    });
    const handler = createAddressCanonPostalCodeHandler({ lookupPort: { lookupPostalCode } as never });
    const offline = response(), empty = response();
    const req = { method: "GET", query: { postalCode: "00-001" } } as never;
    await handler(req, offline as never); await handler(req, empty as never);
    expect(offline.status).toHaveBeenCalledWith(503);
    expect(empty.status).toHaveBeenCalledWith(200);
    expect(empty.json).toHaveBeenCalledWith({ ok: true, data: expect.objectContaining({ candidates: [] }) });
    const f = setup(); const saved = response();
    await f.handler({ method: "POST", body: manual } as never, saved as never);
    expect(saved.status).toHaveBeenCalledWith(200);
  });
});
