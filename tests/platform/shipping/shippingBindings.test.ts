import { expect, it, vi } from "vitest";
import { checkReadiness, type ReadinessInput } from "@openlup/core/readiness";
import { createShippingBindings } from "@openlup/platform/shipping";
import { bffResponder } from "../../../server/_lib/bff/response.js";
import { createM06ShippingReferenceBinding } from "../../../server/runtime/public-reference/m06ShippingBinding.js";
import { createStaticDeliverySelectionPort } from "../../../server/domains/shipping/staticDeliverySelectionPort.js";
import { createDictionaryDeliverySelectionPort } from "../../../server/domains/shipping/dictionaryDeliverySelectionPort.js";
import { pickupPointAddressSchema } from "../../../src/domains/shipping/deliverySelectionContracts.js";
import { CustomerSelfServiceMutationConflictError } from "../../../server/domains/customers/customerSelfServiceErrors.js";

const schema = { version: "complete", migration: "complete", objects: [] };
function response() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res); return res;
}
const emptyBook = { contractVersion: "customer.addresses.v1" as const, ordererProfiles: [], addresses: [] };

it("composes selected sources, own-session address authority and flat-rate authorization without fallback writes", async () => {
  const read = vi.fn(async () => emptyBook), upsert = vi.fn(async () => emptyBook), remove = vi.fn(async () => emptyBook);
  const rate = { getShippingFlatMinor: vi.fn(async () => 500), setShippingFlatMinor: vi.fn(async () => undefined), recordPromotionAudit: vi.fn(async () => { throw new Error("offline"); }) };
  const managed = vi.fn(() => ({ addressBookPort: { getAddressBook: read }, addressMutationPort: { upsertAddress: upsert, deleteAddress: remove }, shippingRateDataPort: rate }));
  let allowed = true, customerAllowed = true;
  const binding = createM06ShippingReferenceBinding({ store: { dataKind: "supabase", createManagedStore: managed }, version: "0.17.0", requiredSchema: schema,
    selection: { port: createStaticDeliverySelectionPort(), searchPort: { searchPickupPoints: async () => [] } },
    addresses: { authenticateUser: async () => customerAllowed ? { ok: true, userId: "session-owner" } : { ok: false, code: "UNAUTHORIZED", message: "denied" }, requireWrites: true },
    rate: { authorizeAdmin: async () => allowed ? { ok: true, userId: "operator", role: "admin", isMachineActor: false } : { ok: false, code: "FORBIDDEN", message: "denied" } },
  });
  expect(binding.readiness.ready).toBe(true); expect(managed).toHaveBeenCalledOnce();
  const get = response(); await binding.handlers.addresses!({ method: "GET", query: { userId: "planted" } } as never, get as never);
  // A planted owner query cannot redirect the authenticated identity (the host validator may reject it).
  const own = response(); await binding.handlers.addresses!({ method: "GET", query: {} } as never, own as never);
  expect(read).toHaveBeenCalledExactlyOnceWith("session-owner");
  const conflict = response(); remove.mockRejectedValueOnce(new CustomerSelfServiceMutationConflictError("in use"));
  await binding.handlers.addresses!({ method: "DELETE", body: { addressId: "a1000000-0000-4000-8000-000000000001", idempotencyKey: "remove-address" } } as never, conflict as never);
  expect(conflict.status).toHaveBeenCalledWith(409);
  const manual = response();
  await binding.handlers.addresses!({ method: "POST", body: { idempotencyKey: "manual-address", kind: "shipping", line1: "Example 1", city: "Example City", postalCode: "00001", country: pickupPointAddressSchema.shape.country.value, isDefault: true } } as never, manual as never);
  expect(manual.status).toHaveBeenCalledWith(200);
  expect(upsert).toHaveBeenCalledWith("session-owner", expect.objectContaining({ postalCode: "00-001", isDefault: true }));
  customerAllowed = false; const deniedCustomer = response();
  await binding.handlers.addresses!({ method: "POST", body: {} } as never, deniedCustomer as never);
  expect(deniedCustomer.status).toHaveBeenCalledWith(401); expect(upsert).toHaveBeenCalledOnce();
  const saved = response(); await binding.handlers.rate!({ method: "POST", body: { shippingFlatMinor: 700 } } as never, saved as never);
  expect(saved.status).toHaveBeenCalledWith(200); expect(rate.recordPromotionAudit).toHaveBeenCalledWith(expect.objectContaining({ actorId: "operator", newValue: { shippingFlatMinor: 700 } }));
  allowed = false; const denied = response(); await binding.handlers.rate!({ method: "POST", body: { shippingFlatMinor: 800 } } as never, denied as never);
  expect(denied.status).toHaveBeenCalledWith(403); expect(rate.setShippingFlatMinor).toHaveBeenCalledExactlyOnceWith(700);
  const options = response(); await binding.handlers.options!({ method: "GET" } as never, options as never);
  expect(options.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ options: await createStaticDeliverySelectionPort().listOptions() }) }));
  const dictionary = createM06ShippingReferenceBinding({ store: { dataKind: "supabase" }, version: "0.17.0", requiredSchema: schema,
    selection: { port: createDictionaryDeliverySelectionPort({ dictionary: { carriers: [], pickupPoints: {} }, enabledCarriers: new Set() }), searchPort: { searchPickupPoints: async () => [] } } });
  const empty = response(); await dictionary.handlers.options!({ method: "GET" } as never, empty as never);
  expect(empty.status).toHaveBeenCalledWith(502);
  expect(empty.json).toHaveBeenCalledWith({ ok: false, error: { code: "INVALID_RESPONSE", message: "Delivery options returned invalid response" } });
});

it("refuses missing stores and native address writes in both binding and Core readiness, including a planted writer", async () => {
  const addresses = { authenticateUser: async () => ({ ok: true as const, userId: "session-owner" }), requireWrites: true };
  const reference = (store: Parameters<typeof createM06ShippingReferenceBinding>[0]["store"]) => createM06ShippingReferenceBinding({ store, addresses, version: "0.17.0", requiredSchema: schema });
  expect(reference({ dataKind: "supabase" }).readiness.reason).toBe("shipping_store_required");
  expect(reference({ dataKind: "supabase", createManagedStore: () => ({}) }).readiness.reason).toBe("shipping_address_store_incompatible");
  const managed = vi.fn(() => null), planted = vi.fn();
  const binding = reference({ dataKind: "postgres", createManagedStore: managed, nativeStore: { addressMutationPort: { upsertAddress: planted, deleteAddress: planted } } as never });
  expect(managed).not.toHaveBeenCalled(); expect(planted).not.toHaveBeenCalled();
  expect(binding.readiness).toEqual({ ready: false, reason: "shipping_native_address_writes_unsupported" });
  expect(binding.handlers.addresses).toBeNull(); expect(binding.unsupported.addressWrites).toBe("shipping_native_address_writes_unsupported");
  expect(createShippingBindings({ dataKind: "unknown", responder: bffResponder }).readiness.reason).toBe("shipping_store_incompatible");
  const input: ReadinessInput = {
    candidate: { artifact: "fixture", configuration: "fixture", environment: "fixture", database: "fixture", schema: "complete" }, inventoryComplete: true,
    loadedPackages: [{ name: "@openlup/core", version: "0.17.0", kind: "kernel" }, { name: "@openlup/platform", version: "0.17.0", kind: "rail", modules: ["shipping"] }],
    contributions: binding.contributions, vocabulary: [], exemptions: [], bindings: { ports: binding.ports, routes: {}, triggers: {}, env: {} },
    schemaProbe: { observe: async () => ({ database: "fixture", version: "complete", objects: [] }) },
  };
  const nativeRate = createM06ShippingReferenceBinding({ store: { dataKind: "postgres", createManagedStore: managed,
    nativeStore: { shippingRateDataPort: { getShippingFlatMinor: planted, setShippingFlatMinor: planted, recordPromotionAudit: planted } } },
    rate: { authorizeAdmin: async () => ({ ok: true, userId: "operator", role: "admin", isMachineActor: false }) }, version: "0.17.0", requiredSchema: schema });
  expect(nativeRate.readiness).toEqual({ ready: false, reason: "shipping_native_flat_rate_save_unsupported" });
  expect(nativeRate.unsupported.flatRateSave).toBe("shipping_native_flat_rate_save_unsupported");
  expect(nativeRate.handlers.rate).toBeNull(); expect(planted).not.toHaveBeenCalled(); expect(managed).not.toHaveBeenCalled();
  expect((await checkReadiness({ ...input, contributions: nativeRate.contributions, bindings: { ...input.bindings, ports: nativeRate.ports } })).issues)
    .toContainEqual(expect.objectContaining({ code: "OPENLUP_E_PORT_MISSING", subject: "rate" }));
  expect((await checkReadiness(input)).issues).toContainEqual(expect.objectContaining({ code: "OPENLUP_E_PORT_MISSING", subject: "addressWrites" }));
  // Extend the existing refusal case: both the native port and Core schema report are required.
  const candidate = { ...input.candidate, schema: "20261021200000_shipping_flat_rate_seed" };
  const nativeStore = { shippingRateDataPort: { getShippingFlatMinor: async () => 0,
    setShippingFlatMinor: async () => undefined, recordPromotionAudit: async () => undefined } };
  const ready = await checkReadiness({ ...input, candidate, contributions: [{
    manifest: { name: "@openlup/platform", version: "0.17.0", kind: "rail", emits: [], handles: [], schedules: [], routes: [], requiredPorts: [], env: [],
      requiredSchema: { version: candidate.schema, migration: candidate.schema, objects: [] } }, handlers: [], schedules: [], routes: [],
  }], loadedPackages: input.loadedPackages.map(({ modules: _modules, ...pkg }) => pkg),
    schemaProbe: { observe: async () => ({ database: "fixture", version: candidate.schema, objects: [] }) } });
  expect(ready.state).toBe("ready");
  const nativeRateSchema = { database: "fixture", version: candidate.schema, objects: [
    { object: { kind: "table" as const, name: "public.commerce_settings" }, present: true },
    { object: { kind: "column" as const, name: "public.commerce_settings.value_minor" }, present: true },
    { object: { kind: "column" as const, name: "public.commerce_settings.updated_at" }, present: true },
  ] };
  const base = { nativeRateSchema, dataKind: "postgres", responder: bffResponder, nativeStore };
  expect(createShippingBindings(base).unsupported.flatRateSave).toBe("shipping_native_flat_rate_save_unsupported");
  expect(createShippingBindings({ ...base, nativeRateReadiness: ready }).unsupported.flatRateSave).toBeNull();
  expect(createShippingBindings({ ...base, nativeStore: {}, nativeRateReadiness: ready }).unsupported.flatRateSave).toBe("shipping_native_flat_rate_save_unsupported");
  expect(createShippingBindings({ ...base, nativeRateReadiness: { ...ready, state: "unsatisfied" } }).unsupported.flatRateSave).toBe("shipping_native_flat_rate_save_unsupported");
  expect(createShippingBindings({ ...base, nativeRateReadiness: { ...ready, candidate: { ...candidate, schema: "later-forward" } } }).unsupported.flatRateSave).toBeNull();
  for (const unproven of [undefined, { ...nativeRateSchema, version: null }, { ...nativeRateSchema, objects: [] },
    { ...nativeRateSchema, database: "other" }, { ...nativeRateSchema, objects: nativeRateSchema.objects.map(entry => ({ ...entry, present: false })) }]) {
    expect(createShippingBindings({ ...base, nativeRateReadiness: ready, nativeRateSchema: unproven }).unsupported.flatRateSave).toBe("shipping_native_flat_rate_save_unsupported");
  }
  expect(createShippingBindings({ ...base, nativeRateReadiness: { state: "ready" } as never, rate: { schemas: {} as never, authorizeAdmin: vi.fn(), resolveAdmin: vi.fn() } }).readiness.reason).toBe("shipping_native_flat_rate_save_unsupported");

});
