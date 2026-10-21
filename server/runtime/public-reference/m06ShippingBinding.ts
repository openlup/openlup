import { createPostgresShippingRateDataPort } from "../../adapters/postgres/commerceSettings.js";
import { createPostgresShippingRateTransactionLane, type PostgresDataGatewayEnv, type PostgresDataGatewayOptions } from "../../adapters/postgres/dataGateway.js";
import { SHIPPING_MIGRATIONS, createShippingBindings, type ShippingBindingDependencies, type ShippingBindings } from "@openlup/platform/shipping";
import { createShippingContribution } from "@openlup/platform/composition";
import { createSchemaProbe, schemaObjectKey, type RequiredSchema, type SqlExecutor } from "@openlup/core/readiness";
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
  const seed = SHIPPING_MIGRATIONS[1];
  const seedSchema: RequiredSchema = { version: seed.id, migration: seed.catalogPath,
    objects: [{ kind: "table", name: "public.commerce_settings" },
      { kind: "column", name: "public.commerce_settings.value_minor" },
      { kind: "column", name: "public.commerce_settings.updated_at" }] };
  const requiredSchema = input.store.dataKind === "postgres" && input.rate
    ? { ...input.requiredSchema, objects: [...new Map([...input.requiredSchema.objects, ...seedSchema.objects]
      .map(object => [schemaObjectKey(object), object])).values()] }
    : input.requiredSchema;
  // Observe the seed's ledger identity, never the current tail or a candidate label.
  const observeNativeRateSchema = async () => transactions ? transactions.run(async gateway => {
    const executor = gateway as SqlExecutor;
    return createSchemaProbe(executor, async () => {
      const { rows } = await executor.query(
        "SELECT current_database() AS database, EXISTS (SELECT 1 FROM public.platform_schema_migrations WHERE position = $1 AND catalog_path = $2 AND sha256 = $3) AS applied",
        [seed.position, seed.catalogPath, seed.sha256],
      );
      return { database: String(rows[0]?.database ?? ""), version: rows[0]?.applied === true ? seed.id : null };
    }).observe(seedSchema);
  }) : null;
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
  return { ...bindings, ...contribution, observeNativeRateSchema, close: async () => { await transactions?.close(); } };
}
