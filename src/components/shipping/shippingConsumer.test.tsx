import { checkReadiness, createSchemaProbe } from "@openlup/core/readiness";
import { createPostgresShippingRateTransactionLane } from "../../../server/adapters/postgres/dataGateway.js";
import { createPostgresShippingRateDataPort } from "../../../server/adapters/postgres/commerceSettings.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { z } from "zod";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { DeliveryMethodCard } from "./DeliveryMethodCard";
import { ShippingFieldsCard } from "./ShippingFieldsCard";
import { ShippingRateCard } from "../admin/ShippingRateCard";
import { createPostgresMigrationRunner } from "../../../server/adapters/postgres/migrationRunner.js";
import { createStaticDeliverySelectionPort } from "../../../server/domains/shipping/staticDeliverySelectionPort.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../../../tests/helpers/postgresContainer.js";
import { deliveryOptionsResponseSchema, pickupPointValidationRequestSchema, pickupPointValidationResponseSchema, pickupPointAddressSchema } from "@/domains/shipping/deliverySelectionContracts";
import { pickupPointSearchRequestSchema, pickupPointSearchResponseSchema } from "@/domains/shipping/pickupPointSearchContracts";
import { customerAddressesRequestSchema, customerAddressesResponseSchema } from "@/domains/customers/contracts";
import { customerAddressDeleteRequestSchema, customerAddressUpsertRequestSchema } from "@/domains/customers/selfServiceContracts";
import { addressCanonPostalCodeLookupRequestSchema, addressCanonPostalCodeLookupResponseSchema } from "@/domains/address-canon/contracts";
import { adminSetShippingRateRequestSchema, adminSetShippingRateResponseSchema, adminShippingRateResponseSchema } from "@/domains/commerce/adminPromotionsContracts";

const clients = vi.hoisted(() => ({ getAdminShippingRate: vi.fn(), setAdminShippingRate: vi.fn(), searchPickupPoints: vi.fn() }));
vi.mock("@/domains/commerce/adminPromotionsClient", () => clients);
vi.mock("@/domains/shipping/deliverySelectionClient", () => clients);
let shipping: typeof import("@openlup/platform/shipping"), inventory: typeof import("@openlup/platform/inventory"), composition: typeof import("@openlup/platform/composition"), bff: typeof import("@openlup/platform/bff");
let rateLane: ReturnType<typeof createPostgresShippingRateTransactionLane>;
let scratch: string, container: PostgresContainer | undefined, pool: Pool;
const country = pickupPointAddressSchema.shape.country.value;
const clientId = "f6000000-0000-4000-8000-000000000001", addressId = "f6000000-0000-4000-8000-000000000002";
const npm = (args: string[], cwd: string) => execFileSync("npm", args, { cwd, stdio: "pipe", timeout: 120_000 }).toString();
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "shipping-consumer-"));
  const tarballs = ["packages/core", "packages/platform", "node_modules/zod"].map(directory => {
    const packed = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], resolve(directory)));
    return join(scratch, packed[0].filename);
  });
  const consumer = join(scratch, "consumer"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), '{"type":"module","private":true}');
  npm(["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--omit=optional", "--no-audit", "--no-fund", ...tarballs], consumer);
  const installed = createRequire(join(consumer, "package.json")).resolve;
  for (const entry of ["@openlup/core/readiness", "@openlup/platform/shipping"]) expect(realpathSync(installed(entry)).startsWith(`${realpathSync(consumer)}/node_modules/`)).toBe(true);
  // Only installed public export entries are loaded; none of these modules use source aliases.
  shipping = await import(pathToFileURL(installed("@openlup/platform/shipping")).href);
  inventory = await import(pathToFileURL(installed("@openlup/platform/inventory")).href);
  composition = await import(pathToFileURL(installed("@openlup/platform/composition")).href);
  bff = await import(pathToFileURL(installed("@openlup/platform/bff")).href);
  if (!await dockerAvailable()) throw new Error("Final installed consumer requires Docker PostgreSQL");
  container = await runPostgresContainer({ name: `shipping-consumer-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Final installed PostgreSQL unavailable");
  pool = new Pool({ connectionString: container.connectionString });
  rateLane = createPostgresShippingRateTransactionLane({ connectionString: container.connectionString });
  await createPostgresMigrationRunner({ connectionString: container.connectionString }, { poolFactory: () => pool }).apply();
  await pool.query(`INSERT INTO public.clients(id,email) VALUES ($1,'installed@example.invalid');
    INSERT INTO public.catalog_products(id,slug,name) VALUES ('f6000000-0000-4000-8000-000000000003','installed-final','Fixture');
    INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES ('f6000000-0000-4000-8000-000000000004','f6000000-0000-4000-8000-000000000003','FINAL','Fixture');
    INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
    VALUES ('fixture','FINAL',9,9,0,'sellable',now(),now()+interval '1 hour','fixture','final-stock',repeat('a',64))`.replace("$1", `'${clientId}'`));
}, postgresSetupTimeoutMs);
afterEach(() => { cleanup(); vi.clearAllMocks(); });
afterAll(async () => { await rateLane?.close(); await closePostgres(container, pool); if (scratch) rmSync(scratch, { recursive: true, force: true }); }, postgresTeardownTimeoutMs);
async function invoke(handler: NonNullable<ReturnType<typeof shipping.createShippingBindings>["handlers"]["rate"]>, method: string, body?: unknown) {
  let status = 0, payload: { ok: boolean; data?: unknown } | undefined;
  const response = { status(value: number) { status = value; return this; }, json(value: typeof payload) { payload = value; return this; }, setHeader() {} };
  await handler({ method, body } as never, response as never);
  if (status !== 200 || !payload?.ok) throw new Error(`handler_${status}`);
  return payload.data;
}
const selectionSchemas = { deliveryOptionsResponseSchema, pickupPointValidationRequestSchema, pickupPointValidationResponseSchema, pickupPointSearchRequestSchema, pickupPointSearchResponseSchema };

it("reads both installed modules from selected stores and roundtrips picker and flat-rate UI without a map", async () => {
  const stock = inventory.createInventoryBindings({ dataKind: "postgres", executor: pool, provider: { stockMasterProvider: "fixture", providerSchema: z.literal("fixture") } });
  expect(await stock.readPort!.listStock({ page: 1, pageSize: 10, includeZero: true })).toMatchObject({ stock: [{ sku: "FINAL", availableNow: 9 }] });
  const source = createStaticDeliverySelectionPort(), options = await source.listOptions(), locker = options.find(option => option.pickupPointRequired)!;
  const point = (await source.validatePickupPoint({ pointId: "WAW01A", carrierKind: locker.carrierKind }))!;
  const nativePort = createPostgresShippingRateDataPort(rateLane);
  const audit = vi.fn(nativePort.recordPromotionAudit);
  await nativePort.setShippingFlatMinor(500);
  const migration = shipping.SHIPPING_MIGRATIONS[1];
  const requiredSchema = { version: migration.id, migration: migration.catalogPath,
    objects: [{ kind: "table" as const, name: "public.commerce_settings" },
      { kind: "column" as const, name: "public.commerce_settings.value_minor" },
      { kind: "column" as const, name: "public.commerce_settings.updated_at" }] };
  const schemaProbe = createSchemaProbe(pool, async () => ({ database: "synthetic", version:
    (await pool.query("SELECT 1 FROM public.platform_schema_migrations WHERE position=$1 AND catalog_path=$2 AND sha256=$3",
      [migration.position, migration.catalogPath, migration.sha256])).rowCount === 1 ? migration.id : null }));
  const nativeRateSchema = await schemaProbe.observe(requiredSchema);
  const report = await checkReadiness({
    candidate: { artifact: "installed", configuration: "shipping", environment: "disposable", database: "synthetic", schema: migration.id }, inventoryComplete: true,
    loadedPackages: [{ name: "@openlup/core", version: "0.18.0", kind: "kernel" }, { name: "@openlup/platform", version: "0.18.0", kind: "rail" }],
    contributions: [{ manifest: { name: "@openlup/platform", version: "0.18.0", kind: "rail", emits: [], handles: [], schedules: [], routes: [], env: [], requiredPorts: [], requiredSchema }, handlers: [], schedules: [], routes: [] }],
    vocabulary: [], exemptions: [], bindings: { ports: {}, routes: {}, triggers: {}, env: {} },
    schemaProbe,
  });
  expect(report.state).toBe("ready");
  const binding = shipping.createShippingBindings({ dataKind: "postgres", responder: bff.createBffResponder(),
    nativeRateReadiness: report, nativeRateSchema, nativeStore: { shippingRateDataPort: { ...nativePort, recordPromotionAudit: audit } }, selection: { port: source, searchPort: { searchPickupPoints: async () => [{ id: point.id, name: point.name, address: point.address, carrierKind: locker.carrierKind, location: null, locationDescription: null, openingHours: null, distanceMeters: null, pointKind: "locker", appAssisted: false }] }, schemas: selectionSchemas as unknown as import("@openlup/platform/shipping").DeliverySelectionSchemas },
    rate: { schemas: { contractVersion: "commerce.v0", adminSetShippingRateRequestSchema, adminSetShippingRateResponseSchema, adminShippingRateResponseSchema },
      authorizeAdmin: async () => ({ ok: true, userId: "operator", role: "admin", isMachineActor: false }), resolveAdmin: async authorize => { const actor = await authorize(); return actor.ok ? actor : null; } },
  });
  expect(binding.readiness.ready).toBe(true);
  clients.getAdminShippingRate.mockImplementation(() => invoke(binding.handlers.rate!, "GET"));
  clients.setAdminShippingRate.mockImplementation((_token, body) => invoke(binding.handlers.rate!, "POST", body));
  clients.searchPickupPoints.mockImplementation(body => invoke(binding.handlers.search!, "POST", body));
  const declared = composition.createShippingContribution({ version: "0.17.0", requiredSchema: { version: "complete", migration: "complete", objects: [] }, shipping: { rate: binding.handlers.rate }, routes: [] });
  expect(declared.ports["@openlup/platform/shipping:rate"]).toBe(binding.handlers.rate);
  const selectedOptions = (await invoke(binding.handlers.options!, "GET") as { options: typeof options }).options;
  const select = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><ShippingRateCard accessToken="fixture" /><DeliveryMethodCard options={selectedOptions} selectedOption={locker} addressPostalCode="00-001" deliverySelectionEnabled onPickupPointChange={select} /></QueryClientProvider>);
  const input = await screen.findByRole("spinbutton");
  await waitFor(() => expect((input as HTMLInputElement).value).toBe("5.00"));
  fireEvent.change(input, { target: { value: "7.25" } });
  fireEvent.click(input.closest("section")!.querySelector("button")!);
  await waitFor(() => expect(audit).toHaveBeenCalled());
  expect(await nativePort.getShippingFlatMinor()).toBe(725);
  expect((await pool.query("SELECT value_minor FROM public.commerce_settings WHERE key=$1", ["shipping_flat_minor"])).rows).toEqual([{ value_minor: 725 }]);
  const native = shipping.createShippingBindings({ dataKind: "postgres", responder: bff.createBffResponder(), rate: { schemas: { contractVersion: "commerce.v0", adminSetShippingRateRequestSchema, adminSetShippingRateResponseSchema, adminShippingRateResponseSchema },
    authorizeAdmin: async () => ({ ok: true, userId: "operator", role: "admin", isMachineActor: false }), resolveAdmin: async () => null } });
  expect(native.readiness.reason).toBe("shipping_native_flat_rate_save_unsupported");
  const pointButton = await screen.findByRole("button", { name: new RegExp(point.name) }); fireEvent.click(pointButton);
  expect(select).toHaveBeenCalledWith(point);
  expect(view.container.querySelector("iframe,canvas")).toBeNull();
  client.clear();
});

it("reads an installed injected address and retains manual fields through offline and empty suggestions with explicit write refusal", async () => {
  // Captured managed-row fixture: the native catalogue has no addresses table or writer.
  const addressStore = { readAddresses: async (id: string) => id === clientId ? [{ id: addressId, kind: "shipping", line1: "Example 1", city: "Example City", postal_code: "00-001", country, is_default: true,
    created_at: "2026-10-21T00:00:00.000Z", updated_at: "2026-10-21T00:00:00.000Z" }] : [],
    readOrdererProfiles: async () => [], addressUsedByActiveSubscription: async () => false, findCanonicalAddressId: async () => null, clearDefaultAddress: async () => undefined };
  const binding = shipping.createShippingBindings({ dataKind: "postgres", responder: bff.createBffResponder(), nativeStore: { addressBookPort: {
    getAddressBook: async user => user === "session-owner" ? { contractVersion: "customer.addresses.v1", ordererProfiles: [], addresses: await shipping.readAddresses(addressStore, clientId) } : null,
  } }, addresses: { authenticateUser: async () => ({ ok: true, userId: "session-owner" }), requireWrites: false,
    schemas: { customerAddressesRequestSchema, customerAddressesResponseSchema, customerAddressDeleteRequestSchema, customerAddressUpsertRequestSchema, isMutationConflict: (_error): _error is Error => false } as unknown as import("@openlup/platform/shipping").CustomerAddressSchemas },
  });
  const book = await invoke(binding.handlers.addresses!, "GET") as { addresses: { line1: string; city: string; postalCode: string; country: string; isDefault: boolean }[] };
  expect(book.addresses).toMatchObject([{ line1: "Example 1", isDefault: true }]);
  const saved = vi.fn(async () => ({ contractVersion: "customer.addresses.v1" as const, ordererProfiles: [], addresses: book.addresses as never[] }));
  const managed = shipping.createShippingBindings({ dataKind: "supabase", responder: bff.createBffResponder(),
    createManagedStore: () => ({ addressBookPort: binding.store.addressBookPort, addressMutationPort: { upsertAddress: saved, deleteAddress: async () => null } }),
    addresses: { authenticateUser: async () => ({ ok: true, userId: "session-owner" }), requireWrites: true,
      schemas: { customerAddressesRequestSchema, customerAddressesResponseSchema, customerAddressDeleteRequestSchema, customerAddressUpsertRequestSchema, isMutationConflict: (_error): _error is Error => false } as unknown as import("@openlup/platform/shipping").CustomerAddressSchemas },
  });
  let save: Promise<unknown> | undefined;
  function Manual() {
    const address = book.addresses[0];
    const [data, setData] = useState({ street: address.line1, city: address.city, postalCode: address.postalCode, country: address.country, phone: "" });
    return <ShippingFieldsCard data={data} errors={{}} update={patch => setData(previous => ({ ...previous, ...patch }))}><button type="button" onClick={() => { save = invoke(managed.handlers.addresses!, "POST", { idempotencyKey: "manual-address", kind: "shipping", line1: data.street, city: data.city, postalCode: data.postalCode, country: data.country, isDefault: true }); }}>Save</button></ShippingFieldsCard>;
  }
  const view = render(<Manual />);
  const street = view.container.querySelector('input[autocomplete="street-address"]')!;
  fireEvent.change(street, { target: { value: "Changed 2" } });
  // Lookup transport outcomes stay distinct; neither replaces the manual destination.
  const lookup = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ contractVersion: "address.canon.v1", query: { postalCode: "00-001" }, resolutionLevel: "postal_code", candidates: [], sources: [] });
  const lookupHandler = shipping.createAddressCanonPostalCodeHandler({ lookupPort: { lookupPostalCode: lookup } as never },
    { addressCanonPostalCodeLookupRequestSchema, addressCanonPostalCodeLookupResponseSchema } as never, bff.createBffResponder());
  const outcomes: { status: number; payload?: unknown }[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = { status: 0, payload: undefined as unknown }; outcomes.push(outcome);
    const response = { status(code: number) { outcome.status = code; return this; }, json(payload: unknown) { outcome.payload = payload; return this; }, setHeader() {} };
    await lookupHandler({ method: "GET", query: { postalCode: "00-001" } } as never, response as never);
  }
  expect(outcomes.map(outcome => outcome.status)).toEqual([503, 200]);
  expect(outcomes[1].payload).toMatchObject({ data: { candidates: [] } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await save;
  expect(saved).toHaveBeenCalledWith("session-owner", expect.objectContaining({ line1: "Changed 2", postalCode: "00-001", isDefault: true }));
  expect(binding.unsupported.addressWrites).toBe("shipping_native_address_writes_unsupported");
  expect(binding.store.addressMutationPort).toBeUndefined();
});
