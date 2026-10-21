import { createPostgresShippingRateDataPort } from "../../adapters/postgres/commerceSettings.js";
import { createPostgresShippingRateTransactionLane, type PostgresDataGatewayEnv, type PostgresDataGatewayOptions } from "../../adapters/postgres/dataGateway.js";
import { SHIPPING_MIGRATIONS, createShippingBindings, type ShippingBindingDependencies, type ShippingBindings } from "@openlup/platform/shipping";
import { createShippingContribution } from "@openlup/platform/composition";
import type { RequiredSchema } from "@openlup/core/readiness";
import { bffResponder } from "../../_lib/bff/response.js";
import { customerAddressesRequestSchema, customerAddressesResponseSchema } from "../../../src/domains/customers/contracts.js";
import { customerAddressDeleteRequestSchema, customerAddressUpsertRequestSchema } from "../../../src/domains/customers/selfServiceContracts.js";
import { CustomerSelfServiceMutationConflictError } from "../../domains/customers/customerSelfServiceErrors.js";
import { adminSetShippingRateRequestSchema, adminSetShippingRateResponseSchema, adminShippingRateResponseSchema } from "../../../src/domains/commerce/adminPromotionsContracts.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import { resolveAdmin } from "../../domains/commerce/adminPromotionsHandler.js";
import { deliveryOptionsResponseSchema, pickupPointValidationRequestSchema, pickupPointValidationResponseSchema } from "../../../src/domains/shipping/deliverySelectionContracts.js";
import { pickupPointSearchRequestSchema, pickupPointSearchResponseSchema } from "../../../src/domains/shipping/pickupPointSearchContracts.js";

/** Inert reference composition; the caller selects adapters, authority and routes. */
export function createM06ShippingReferenceBinding(input: {
  nativeRate?: { env: PostgresDataGatewayEnv; options?: PostgresDataGatewayOptions };
  store: Omit<ShippingBindingDependencies, "responder" | "selection" | "addresses" | "rate">;
  selection?: Pick<NonNullable<ShippingBindingDependencies["selection"]>, "port" | "searchPort">;
  addresses?: Pick<NonNullable<ShippingBindingDependencies["addresses"]>, "authenticateUser" | "requireWrites">;
  rate?: Pick<NonNullable<ShippingBindingDependencies["rate"]>, "authorizeAdmin">;
  version: string;
  requiredSchema: RequiredSchema;
}) {
  const transactions = input.nativeRate && input.store.dataKind === "postgres"
    ? createPostgresShippingRateTransactionLane(input.nativeRate.env, input.nativeRate.options) : null;
  const requiredSchema = input.store.dataKind === "postgres" && input.rate
    ? { version: SHIPPING_MIGRATIONS[1].id, migration: SHIPPING_MIGRATIONS[1].catalogPath,
      objects: [{ kind: "table" as const, name: "public.commerce_settings" },
        { kind: "column" as const, name: "public.commerce_settings.value_minor" },
        { kind: "column" as const, name: "public.commerce_settings.updated_at" }] }
    : input.requiredSchema;
  const bindings: ShippingBindings = createShippingBindings({ ...input.store,
    nativeStore: transactions ? { ...input.store.nativeStore, shippingRateDataPort: createPostgresShippingRateDataPort(transactions) } : input.store.nativeStore,
    responder: bffResponder,
    selection: input.selection ? { ...input.selection, schemas: { deliveryOptionsResponseSchema, pickupPointValidationRequestSchema,
      pickupPointValidationResponseSchema, pickupPointSearchRequestSchema, pickupPointSearchResponseSchema } } : undefined,
    addresses: input.addresses ? { ...input.addresses, schemas: { customerAddressesRequestSchema, customerAddressesResponseSchema,
      customerAddressDeleteRequestSchema, customerAddressUpsertRequestSchema,
      isMutationConflict: (error): error is Error => error instanceof CustomerSelfServiceMutationConflictError } } : undefined,
    rate: input.rate ? { ...input.rate, resolveAdmin, schemas: { contractVersion: COMMERCE_CONTRACT_VERSION,
      adminSetShippingRateRequestSchema, adminSetShippingRateResponseSchema, adminShippingRateResponseSchema } } : undefined,
  });
  const contribution = createShippingContribution({ version: input.version, requiredSchema,
    shipping: {
      ...(input.selection ? { options: bindings.handlers.options, search: bindings.handlers.search, validate: bindings.handlers.validate } : {}),
      ...(input.addresses ? { addresses: bindings.handlers.addresses,
        ...(input.addresses.requireWrites ? { addressWrites: bindings.store.addressMutationPort?.upsertAddress ?? null } : {}) } : {}),
      ...(input.rate ? { rate: bindings.handlers.rate } : {}),
    }, routes: [],
  });
  return { ...bindings, ...contribution, close: async () => { await transactions?.close(); } };
}
