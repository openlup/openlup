import type { ReadinessReport, SchemaObservation } from "@openlup/core/readiness";
import type { BffResponder } from "../bff/index.js";
import type { CustomerAddressBookPort, CustomerAddressMutationPort, CustomerAddressesDeps } from "./addressPorts.js";
import type { CustomerAddressSchemas } from "./addressSchemas.js";
import type { DeliverySelectionPort } from "./deliverySelectionPort.js";
import type { DeliverySelectionSchemas } from "./handlerSchemas.js";
import type { PickupPointSearchPort } from "./pickupPointSearchPort.js";
import type { AdminShippingRateHandlerDeps, ShippingRateDataPort, ShippingRateHandlerSchemas } from "./shippingRatePorts.js";
import { createCustomerAddressesHandler } from "./customerAddressesHandler.js";
import { createAdminShippingRateHandler } from "./adminShippingRateHandler.js";
import { createDeliveryOptionsHandler, createPickupPointSearchHandler, createPickupPointValidationHandler } from "./deliverySelectionHandler.js";

type Store = {
  addressBookPort?: CustomerAddressBookPort;
  addressMutationPort?: CustomerAddressMutationPort;
  shippingRateDataPort?: ShippingRateDataPort;
};
export interface ShippingBindingDependencies {
  dataKind: string;
  createManagedStore?: () => Store | null;
  /** Core report for the selected shipping contribution, observed by the host. */
  nativeRateReadiness?: ReadinessReport;
  /** Same-database Core observation of the applied shipping seed and required objects. */
  nativeRateSchema?: SchemaObservation;
  nativeStore?: Omit<Store, "addressMutationPort"> | null;
  responder: BffResponder;
  selection?: { port: DeliverySelectionPort; searchPort: PickupPointSearchPort; schemas: DeliverySelectionSchemas };
  addresses?: { schemas: CustomerAddressSchemas; authenticateUser: CustomerAddressesDeps["authenticateUser"]; requireWrites: boolean };
  rate?: { schemas: ShippingRateHandlerSchemas; authorizeAdmin: AdminShippingRateHandlerDeps["authorizeAdmin"]; resolveAdmin: AdminShippingRateHandlerDeps["resolveAdmin"] };
}
export interface ShippingBindings {
  store: Store;
  handlers: {
    options: ReturnType<typeof createDeliveryOptionsHandler> | null;
    search: ReturnType<typeof createPickupPointSearchHandler> | null;
    validate: ReturnType<typeof createPickupPointValidationHandler> | null;
    addresses: ReturnType<typeof createCustomerAddressesHandler> | null;
    rate: ReturnType<typeof createAdminShippingRateHandler> | null;
  };
  readiness: { ready: boolean; reason: string | null };
  unsupported: { addressWrites: string | null; flatRateSave: string | null };
}

/** Explicit selected stores and host validation; importing this module activates nothing. */
export function createShippingBindings(deps: ShippingBindingDependencies): ShippingBindings {
  const native = deps.dataKind === "postgres";
  const addressWrites = native ? "shipping_native_address_writes_unsupported" : null;
  const nativeRateReady = typeof deps.nativeStore?.shippingRateDataPort?.getShippingFlatMinor === "function"
    && typeof deps.nativeStore?.shippingRateDataPort?.setShippingFlatMinor === "function"
    && typeof deps.nativeStore?.shippingRateDataPort?.recordPromotionAudit === "function"
    && deps.nativeRateReadiness?.state === "ready"
    && typeof deps.nativeRateReadiness.candidate?.database === "string"
    && deps.nativeRateReadiness.candidate.database.length > 0
    && deps.nativeRateSchema?.database === deps.nativeRateReadiness.candidate.database
    && deps.nativeRateSchema.version === "20261021200000_shipping_flat_rate_seed"
    && ["public.commerce_settings", "public.commerce_settings.value_minor", "public.commerce_settings.updated_at"].every(name =>
      deps.nativeRateSchema?.objects?.some(entry => entry.present === true && entry.object?.name === name
        && entry.object.kind === (name === "public.commerce_settings" ? "table" : "column")));
  const flatRateSave = native && !nativeRateReady ? "shipping_native_flat_rate_save_unsupported" : null;
  const refused = (reason: string): ShippingBindings => ({
    store: {}, handlers: { options: null, search: null, validate: null, addresses: null, rate: null },
    readiness: { ready: false, reason }, unsupported: { addressWrites, flatRateSave },
  });
  if (!native && deps.dataKind !== "supabase") return refused("shipping_store_incompatible");
  if (native && deps.addresses?.requireWrites) return refused(addressWrites!);
  if (native && deps.rate && flatRateSave) return refused(flatRateSave);
  const selected: Store | null | undefined = native ? deps.nativeStore : deps.createManagedStore?.();
  if ((deps.addresses || deps.rate) && !selected) return refused("shipping_store_required");
  // Native address mutations remain unavailable even if an untyped host plants a writer.
  const store: Store = { addressBookPort: selected?.addressBookPort, shippingRateDataPort: selected?.shippingRateDataPort,
    addressMutationPort: native ? undefined : selected?.addressMutationPort };
  if (deps.addresses && (typeof store.addressBookPort?.getAddressBook !== "function"
    || typeof deps.addresses.authenticateUser !== "function"
    || (deps.addresses.requireWrites && ![store.addressMutationPort?.upsertAddress, store.addressMutationPort?.deleteAddress].every(fn => typeof fn === "function")))) return refused("shipping_address_store_incompatible");
  if (deps.rate && (![store.shippingRateDataPort?.getShippingFlatMinor, store.shippingRateDataPort?.setShippingFlatMinor,
    store.shippingRateDataPort?.recordPromotionAudit, deps.rate.authorizeAdmin, deps.rate.resolveAdmin].every(fn => typeof fn === "function"))) return refused("shipping_rate_store_incompatible");
  if (deps.selection && ![deps.selection.port?.listOptions, deps.selection.port?.validatePickupPoint, deps.selection.searchPort?.searchPickupPoints].every(fn => typeof fn === "function")) return refused("shipping_selection_incompatible");
  return {
    store,
    handlers: {
      options: deps.selection ? createDeliveryOptionsHandler(deps.selection.port, deps.selection.schemas, deps.responder) : null,
      search: deps.selection ? createPickupPointSearchHandler(deps.selection.searchPort, deps.selection.schemas, deps.responder) : null,
      validate: deps.selection ? createPickupPointValidationHandler(deps.selection.port, deps.selection.schemas, deps.responder) : null,
      addresses: deps.addresses ? createCustomerAddressesHandler({ addressBookPort: store.addressBookPort!, addressMutationPort: store.addressMutationPort,
        authenticateUser: deps.addresses.authenticateUser }, deps.addresses.schemas, deps.responder) : null,
      rate: deps.rate ? createAdminShippingRateHandler({ dataPort: store.shippingRateDataPort!, authorizeAdmin: deps.rate.authorizeAdmin,
        resolveAdmin: deps.rate.resolveAdmin }, deps.rate.schemas, deps.responder) : null,
    }, readiness: { ready: true, reason: null }, unsupported: { addressWrites, flatRateSave },
  };
}
