import { describe, expect, it, vi } from "vitest";
import { createBffResponder } from "@openlup/platform/bff";
import {
  createAddressCanonPostalCodeHandler, createAddressCanonLocalitiesHandler, createAddressCanonStreetsHandler,
  createCustomerAddressesHandler, canonicalAddressKey, readAddresses, readOrdererProfiles,
  addressUsedByActiveSubscription, addressRow, findCanonicalAddressId, clearDefaultAddress,
  type AddressCanonLookupPort, type AddressCanonLookupDeps, type AddressLookupSchemas,
  type CustomerAddressBookPort, type CustomerAddressMutationPort, type CustomerAddressesDeps,
  type CustomerAddressSchemas, type CustomerAddressReadStore,
} from "@openlup/platform/shipping";
import type {
  CanonicalAddressInput, AddressCanonSource, AddressCanonLocalityCandidate, AddressCanonStreet,
  AddressCanonPostalCodeLookupRequest, AddressCanonLocalitiesLookupRequest, AddressCanonStreetsLookupRequest,
  AddressCanonPostalCodeLookupResponse, AddressCanonLocalitiesLookupResponse, AddressCanonStreetsLookupResponse,
  CustomerAddressKind, CustomerAddress, CustomerOrdererProfile, CustomerAddressesRequest, CustomerAddressesResponse,
  CustomerAddressUpsertRequest, CustomerAddressDeleteRequest,
} from "@openlup/platform/shipping/contracts";

function response() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res);
  return res;
}
const accepted = <T>(data: T) => ({ safeParse: (_input: unknown) => ({ success: true as const, data }) });
const rejected = { safeParse: (_input: unknown) => ({ success: false as const, error: { flatten: () => ({ host: ["refused"] }) } }) };
const responder = createBffResponder();
const kind: CustomerAddressKind = "shipping";
const input: CustomerAddressUpsertRequest = { idempotencyKey: "address-request", kind, line1: "Street 1", city: "City", postalCode: "host-code", country: "host-region" };
const book: CustomerAddressesResponse = { contractVersion: "customer.addresses.v1", ordererProfiles: [], addresses: [] };
const emptyRequest: CustomerAddressesRequest = {};
const deletion: CustomerAddressDeleteRequest = { idempotencyKey: "delete-request", addressId: "address" };
function customerSchemas(): CustomerAddressSchemas {
  return {
    customerAddressesRequestSchema: accepted(emptyRequest), customerAddressesResponseSchema: accepted(book),
    customerAddressUpsertRequestSchema: accepted(input), customerAddressDeleteRequestSchema: accepted(deletion),
    isMutationConflict: (error): error is Error => error instanceof Error && error.name === "host-conflict",
  };
}
function lookupFixture() {
  const source: AddressCanonSource = { sourceKind: "host-source", status: "active", displayName: "Source", officialUrl: "https://source.invalid", sourceRevision: null, sourceUpdatedAt: null };
  const candidate: AddressCanonLocalityCandidate = { localityId: "locality", countryCode: "host-region", name: "City", tercCode: "area", simcCode: "place", municipalityName: null, municipalityTercCode: null, countyName: null, voivodeshipName: null, sources: [source], postalCode: "host-code", confidence: "exact", resolutionLevel: "postal_code" };
  const street: AddressCanonStreet = { streetId: "street", localityId: candidate.localityId, name: "Street", ulicCode: null, sources: [source] };
  const postal: AddressCanonPostalCodeLookupRequest = { postalCode: "host-code", limit: 10 };
  const localities: AddressCanonLocalitiesLookupRequest = { q: "City", limit: 10 };
  const streets: AddressCanonStreetsLookupRequest = { localityId: candidate.localityId, q: "Street", limit: 20 };
  const postalResponse: AddressCanonPostalCodeLookupResponse = { contractVersion: "address.canon.v1", query: { postalCode: postal.postalCode }, resolutionLevel: "postal_code", candidates: [candidate], sources: [source] };
  const localitiesResponse: AddressCanonLocalitiesLookupResponse = { contractVersion: "address.canon.v1", query: { q: localities.q }, resolutionLevel: "locality", candidates: [candidate], sources: [source] };
  const streetsResponse: AddressCanonStreetsLookupResponse = { contractVersion: "address.canon.v1", query: { localityId: streets.localityId, q: streets.q! }, resolutionLevel: "street", streets: [street], sources: [source] };
  const port: AddressCanonLookupPort = { lookupPostalCode: vi.fn(async () => postalResponse), searchLocalities: vi.fn(async () => localitiesResponse), listStreets: vi.fn(async () => streetsResponse) };
  const deps: AddressCanonLookupDeps = { lookupPort: port };
  const schemas: AddressLookupSchemas = {
    addressCanonPostalCodeLookupRequestSchema: accepted(postal), addressCanonPostalCodeLookupResponseSchema: accepted(postalResponse),
    addressCanonLocalitiesLookupRequestSchema: accepted(localities), addressCanonLocalitiesLookupResponseSchema: accepted(localitiesResponse),
    addressCanonStreetsLookupRequestSchema: accepted(streets), addressCanonStreetsLookupResponseSchema: accepted(streetsResponse),
  };
  return { port, deps, schemas, postalResponse, localitiesResponse, streetsResponse };
}

describe("address public conformance", () => {
  it("preserves lookup methods, query plumbing, defaults and failure envelopes", async () => {
    const f = lookupFixture();
    const queries: unknown[] = [];
    for (const name of ["addressCanonPostalCodeLookupRequestSchema", "addressCanonLocalitiesLookupRequestSchema", "addressCanonStreetsLookupRequestSchema"] as const) {
      const schema = f.schemas[name];
      f.schemas[name] = { safeParse(value) { queries.push(value); return schema.safeParse(value); } } as typeof schema;
    }
    const handlers = [createAddressCanonPostalCodeHandler(f.deps, f.schemas, responder), createAddressCanonLocalitiesHandler(f.deps, f.schemas, responder), createAddressCanonStreetsHandler(f.deps, f.schemas, responder)];
    for (const handler of handlers) {
      const res = response(); await handler({ method: "POST" } as never, res as never);
      expect(res.status).toHaveBeenCalledWith(405);
      expect(res.setHeader).toHaveBeenCalledWith("Allow", "GET");
    }
    expect(queries).toEqual([]);
    for (const [index, handler] of handlers.entries()) {
      const res = response();
      await handler({ method: "GET", query: { postalCode: ["raw", "ignored"], q: [" Street ", "ignored"], localityId: "locality" } } as never, res as never);
      expect(res.json).toHaveBeenCalledWith({ ok: true, data: [f.postalResponse, f.localitiesResponse, f.streetsResponse][index] });
    }
    expect(queries).toEqual([{ postalCode: "raw", limit: 10 }, { q: " Street ", limit: 10 }, { localityId: "locality", q: "Street", limit: 20 }]);
    const invalid = response();
    await createAddressCanonPostalCodeHandler(f.deps, { ...f.schemas, addressCanonPostalCodeLookupRequestSchema: rejected }, responder)({ method: "GET", query: { limit: "bad" } } as never, invalid as never);
    expect(invalid.json).toHaveBeenCalledWith({ ok: false, error: { code: "BAD_REQUEST", message: "Invalid address canon postal-code request", details: { host: ["refused"] } } });
    const badOutput = response();
    await createAddressCanonLocalitiesHandler(f.deps, { ...f.schemas, addressCanonLocalitiesLookupResponseSchema: rejected }, responder)({ method: "GET" } as never, badOutput as never);
    expect(badOutput.json).toHaveBeenCalledWith({ ok: false, error: { code: "INVALID_RESPONSE", message: "Address canon localities lookup failed validation" } });
    vi.mocked(f.port.listStreets).mockRejectedValueOnce(new Error("offline"));
    const offline = response(); await handlers[2]({ method: "GET" } as never, offline as never);
    expect(offline.json).toHaveBeenCalledWith({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "Address canon streets lookup failed" } });
  });

  it("substitutes host formats and source policy and refuses a planted value before effects", async () => {
    const f = lookupFixture();
    f.schemas.addressCanonPostalCodeLookupRequestSchema = {
      safeParse(value) {
        return (value as { postalCode?: string }).postalCode === "host-code"
          ? { success: true, data: { postalCode: "host-code", limit: 10 } } : rejected.safeParse(value);
      },
    };
    f.schemas.addressCanonPostalCodeLookupResponseSchema = {
      safeParse(value) {
        const data = value as AddressCanonPostalCodeLookupResponse;
        return data.sources.every(source => source.sourceKind === "host-source") ? { success: true, data } : rejected.safeParse(value);
      },
    };
    const handler = createAddressCanonPostalCodeHandler(f.deps, f.schemas, responder);
    const ok = response(); await handler({ method: "GET", query: { postalCode: "host-code" } } as never, ok as never);
    expect(ok.status).toHaveBeenCalledWith(200);
    const plant = response(); await handler({ method: "GET", query: { postalCode: "planted-code" } } as never, plant as never);
    expect(plant.status).toHaveBeenCalledWith(400);
    expect(f.port.lookupPostalCode).toHaveBeenCalledTimes(1);
    vi.mocked(f.port.lookupPostalCode).mockResolvedValueOnce({ ...f.postalResponse, sources: [{ ...f.postalResponse.sources[0], sourceKind: "planted-source" }] });
    const badSource = response(); await handler({ method: "GET", query: { postalCode: "host-code" } } as never, badSource as never);
    expect(badSource.status).toHaveBeenCalledWith(502);
    const schemas = customerSchemas();
    schemas.customerAddressUpsertRequestSchema = { safeParse(value) {
      const data = value as CustomerAddressUpsertRequest;
      return data.country === input.country && data.postalCode === input.postalCode && data.taxId === "host-tax" ? { success: true, data } : rejected.safeParse(value);
    } };
    const upsertAddress = vi.fn(async () => book);
    const customer = createCustomerAddressesHandler({ addressBookPort: { getAddressBook: async () => book }, addressMutationPort: { upsertAddress, deleteAddress: async () => book }, authenticateUser: async () => ({ ok: true, userId: "session" }) }, schemas, responder);
    for (const [body, status] of [[{ ...input, taxId: "host-tax" }, 200], [{ ...input, country: "planted-region", taxId: "host-tax" }, 400], [{ ...input, postalCode: "planted-code", taxId: "host-tax" }, 400], [{ ...input, taxId: "planted-tax" }, 400]] as const) {
      const res = response(); await customer({ method: "POST", body } as never, res as never); expect(res.status).toHaveBeenCalledWith(status);
    }
    expect(upsertAddress).toHaveBeenCalledExactlyOnceWith("session", { ...input, taxId: "host-tax" });
  });

  it("keeps authenticated identity, ownership refusal and mutation dispatch order", async () => {
    const addressBookPort: CustomerAddressBookPort = { getAddressBook: vi.fn(async () => book) };
    const addressMutationPort: CustomerAddressMutationPort = { upsertAddress: vi.fn(async () => book), deleteAddress: vi.fn(async () => book) };
    const authenticateUser = vi.fn(async () => ({ ok: true as const, userId: "session" }));
    const deps: CustomerAddressesDeps = { addressBookPort, addressMutationPort, authenticateUser };
    const handler = createCustomerAddressesHandler(deps, customerSchemas(), responder);
    const method = response(); await handler({ method: "PUT" } as never, method as never);
    expect(authenticateUser).not.toHaveBeenCalled();
    for (const verb of ["GET", "POST", "PATCH", "DELETE"]) {
      const res = response(); await handler({ method: verb, body: { userId: "planted-owner" } } as never, res as never);
      expect(res.json).toHaveBeenCalledWith({ ok: true, data: book });
    }
    expect(addressBookPort.getAddressBook).toHaveBeenCalledExactlyOnceWith("session");
    expect(addressMutationPort.upsertAddress).toHaveBeenNthCalledWith(1, "session", input);
    expect(addressMutationPort.upsertAddress).toHaveBeenNthCalledWith(2, "session", input);
    expect(addressMutationPort.deleteAddress).toHaveBeenCalledExactlyOnceWith("session", deletion);
    vi.mocked(addressBookPort.getAddressBook).mockResolvedValueOnce(null);
    const denied = response(); await handler({ method: "GET" } as never, denied as never);
    expect(denied.json).toHaveBeenCalledWith({ ok: false, error: { code: "FORBIDDEN", message: "No customer account linked to this session" } });
  });

  it("preserves authentication, request, missing-writer, conflict and response fault modes", async () => {
    const deps: CustomerAddressesDeps = { addressBookPort: { getAddressBook: async () => book }, authenticateUser: async () => ({ ok: true, userId: "session" }) };
    const schemas = customerSchemas();
    const invoke = async (d: CustomerAddressesDeps, s: CustomerAddressSchemas, method: string, expected: unknown) => {
      const res = response(); await createCustomerAddressesHandler(d, s, responder)({ method } as never, res as never); expect(res.json).toHaveBeenCalledWith({ ok: false, error: expected });
    };
    await invoke({ ...deps, authenticateUser: async () => { throw new Error("offline"); } }, schemas, "GET", { code: "UPSTREAM_UNAVAILABLE", message: "Customer authentication failed" });
    await invoke({ ...deps, authenticateUser: async () => ({ ok: false, code: "UNAUTHORIZED", message: "session required" }) }, schemas, "GET", { code: "UNAUTHORIZED", message: "session required" });
    await invoke(deps, { ...schemas, customerAddressesRequestSchema: rejected }, "GET", { code: "BAD_REQUEST", message: "Invalid customer addresses request", details: { host: ["refused"] } });
    await invoke(deps, schemas, "POST", { code: "UPSTREAM_UNAVAILABLE", message: "Customer addresses request failed" });
    const conflict = new Error("address in use"); conflict.name = "host-conflict";
    const mutation: CustomerAddressMutationPort = { upsertAddress: async () => { throw conflict; }, deleteAddress: async () => { throw conflict; } };
    await invoke({ ...deps, addressMutationPort: mutation }, schemas, "PATCH", { code: "CONFLICT", message: "address in use" });
    await invoke({ ...deps, addressMutationPort: mutation }, { ...schemas, customerAddressDeleteRequestSchema: rejected }, "DELETE", { code: "BAD_REQUEST", message: "Invalid customer address delete request", details: { host: ["refused"] } });
    await invoke({ ...deps, addressMutationPort: mutation }, { ...schemas, customerAddressUpsertRequestSchema: rejected }, "POST", { code: "BAD_REQUEST", message: "Invalid customer address upsert request", details: { host: ["refused"] } });
    await invoke(deps, { ...schemas, customerAddressesResponseSchema: rejected }, "GET", { code: "INVALID_RESPONSE", message: "Customer addresses returned invalid response" });
  });

  it("preserves canonical fallback, row coercions, active-use and default-store calls", async () => {
    const canon: CanonicalAddressInput = { line1: "  STREET  1 ", city: " CITY ", postalCode: " a-b c ", kind: "unknown" };
    expect(canonicalAddressKey(canon, "host-default")).toBe("|shipping|host-default|ABC|city|street 1|");
    expect(canonicalAddressKey({ ...canon, country: " EXPLICIT " }, "other-default")).toBe("|shipping|explicit|ABC|city|street 1|");
    const key = vi.fn((value: CanonicalAddressInput) => canonicalAddressKey(value, "host-default"));
    const store: CustomerAddressReadStore = {
      readAddresses: vi.fn(async () => [{ id: "address", kind, line1: "Street 1", country: "host-region", is_default: 1, label: 42 }]),
      readOrdererProfiles: vi.fn(async () => [{ id: "profile", full_name: "Buyer", company_verification_level: "invalid", is_default: 0 }, { company_verification_level: "unknown" }]),
      addressUsedByActiveSubscription: vi.fn(async () => true), findCanonicalAddressId: vi.fn(async () => "address"), clearDefaultAddress: vi.fn(async () => {}),
    };
    const addresses: CustomerAddress[] = await readAddresses(store, "client");
    expect(addresses[0]).toEqual({ addressId: "address", kind, label: null, recipientName: null, contactPhone: null, companyName: null, taxId: null, line1: "Street 1", line2: null, city: "", postalCode: "", country: "host-region", isDefault: true, deliveryNotes: null, courierInstructions: null, lastUsedAt: null, createdAt: "", updatedAt: "" });
    const profiles: CustomerOrdererProfile[] = await readOrdererProfiles(store, "client");
    expect(profiles[0]).toEqual({ profileId: "profile", label: null, fullName: "Buyer", email: "", phone: null, companyName: null, taxId: null, companyVerificationLevel: "invalid", companyIdentitySource: null, companyIdentityEvidenceHash: null, isDefault: false, createdAt: "", updatedAt: "" });
    expect(profiles[1].companyVerificationLevel).toBeNull();
    expect(await addressUsedByActiveSubscription(store, "client", "address")).toBe(true);
    expect(store.addressUsedByActiveSubscription).toHaveBeenCalledExactlyOnceWith("client", "address");
    const row = addressRow("client", { ...input, country: undefined }, key);
    expect(row).toEqual({ client_id: "client", kind, label: null, recipient_name: null, contact_phone: null, company_name: null, tax_id: null, line1: "Street 1", line2: null, city: "City", postal_code: "host-code", country: undefined, is_default: false, delivery_notes: null, courier_instructions: null, canonical_key: "client|shipping|host-default|HOSTCODE|city|street 1|", source: "customer_account", updated_at: expect.any(String) });
    expect(await findCanonicalAddressId(store, "client", { ...input, country: undefined }, key)).toBe("address");
    expect(store.findCanonicalAddressId).toHaveBeenCalledExactlyOnceWith("client", row.canonical_key);
    await clearDefaultAddress(store, "client", kind);
    expect(store.clearDefaultAddress).toHaveBeenCalledExactlyOnceWith("client", kind, expect.any(String));
  });
});
