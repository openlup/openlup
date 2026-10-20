import { expect, expectTypeOf, it, vi } from "vitest";
import { rolldown } from "rolldown";
import * as catalog from "@openlup/platform/catalog";
import type * as dto from "@openlup/platform/catalog/contracts";
import * as writeSchemas from "../../../src/domains/bundle/adminBundleContracts.js";
import * as lifecycleSchemas from "../../../src/domains/bundle/adminBundleLifecycleContracts.js";
import * as readSchemas from "../../../src/domains/bundle/adminBundleReadContracts.js";
import * as feedSchemas from "../../../src/domains/bundle/sellableBundleContracts.js";
import { bundleSpec } from "../../../src/domains/bundle/bundleSpec.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import { assertActivateNotMachineActor } from "../../../src/lib/agent-domain/lifecycleRules.js";
import { offerAvailabilityStatusFor, offerAvailabilityReasonCode } from "../../../src/domains/commerce/ports.js";
import { deriveBundleAvailability } from "../../../src/domains/bundle/availability.js";
import { evaluateBundleWriteRules } from "../../../src/domains/bundle/bundleRules.js";
import { BundleCatalogReadError } from "../../../server/domains/bundle/bundleCatalogReadPort.js";
import { BundleRpcError } from "../../../server/domains/bundle/adminBundleWritePort.js";
import { DomainRpcError } from "../../../server/_lib/admin-domain/rpcErrors.js";
import { createAdminMutationHandler, createAdminParameterizedReadHandler } from "../../../server/_lib/admin-domain/handlers.js";
import { createAdminBundleGetHandler } from "../../../server/domains/bundle/adminBundleReadHandler.js";
import { createSellableBundleHandler } from "../../../server/domains/bundle/sellableBundleHandler.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../../server/_lib/bff/response.js";

it("binds the existing kit, spec, errors, versions and schemas while browser closures stay isolated", async () => {
  expectTypeOf<dto.CreateBundleDraftRequest>().toEqualTypeOf<writeSchemas.CreateBundleDraftRequest>();
  expectTypeOf<dto.CreateBundleDraftResponse>().toEqualTypeOf<writeSchemas.CreateBundleDraftResponse>();
  expectTypeOf<dto.UpdateBundleDraftRequest>().toEqualTypeOf<writeSchemas.UpdateBundleDraftRequest>();
  expectTypeOf<dto.UpdateBundleDraftResponse>().toEqualTypeOf<writeSchemas.UpdateBundleDraftResponse>();
  expectTypeOf<dto.BundleComponent>().toEqualTypeOf<writeSchemas.BundleComponent>();
  expectTypeOf<dto.SetBundleCompositionRequest>().toEqualTypeOf<writeSchemas.SetBundleCompositionRequest>();
  expectTypeOf<dto.SetBundleCompositionResponse>().toEqualTypeOf<writeSchemas.SetBundleCompositionResponse>();
  expectTypeOf<dto.SetBundleTargetPriceRequest>().toEqualTypeOf<writeSchemas.SetBundleTargetPriceRequest>();
  expectTypeOf<dto.SetBundleTargetPriceResponse>().toEqualTypeOf<writeSchemas.SetBundleTargetPriceResponse>();
  expectTypeOf<dto.ArchiveBundleRequest>().toEqualTypeOf<lifecycleSchemas.ArchiveBundleRequest>();
  expectTypeOf<dto.ArchiveBundleResponse>().toEqualTypeOf<lifecycleSchemas.ArchiveBundleResponse>();
  expectTypeOf<dto.RestoreBundleRequest>().toEqualTypeOf<lifecycleSchemas.RestoreBundleRequest>();
  expectTypeOf<dto.RestoreBundleResponse>().toEqualTypeOf<lifecycleSchemas.RestoreBundleResponse>();
  expectTypeOf<dto.CloneBundleDraftRequest>().toEqualTypeOf<lifecycleSchemas.CloneBundleDraftRequest>();
  expectTypeOf<dto.CloneBundleDraftResponse>().toEqualTypeOf<lifecycleSchemas.CloneBundleDraftResponse>();
  expectTypeOf<dto.ActivateBundleRequest>().toEqualTypeOf<lifecycleSchemas.ActivateBundleRequest>();
  expectTypeOf<dto.ActivateBundleResponse>().toEqualTypeOf<lifecycleSchemas.ActivateBundleResponse>();
  expectTypeOf<dto.DeactivateBundleRequest>().toEqualTypeOf<lifecycleSchemas.DeactivateBundleRequest>();
  expectTypeOf<dto.DeactivateBundleResponse>().toEqualTypeOf<lifecycleSchemas.DeactivateBundleResponse>();
  expectTypeOf<dto.ListBundlesRequest>().toEqualTypeOf<readSchemas.ListBundlesRequest>();
  expectTypeOf<dto.ListBundlesResponse>().toEqualTypeOf<readSchemas.ListBundlesResponse>();
  expectTypeOf<dto.BundleSummaryView>().toEqualTypeOf<readSchemas.BundleSummaryView>();
  expectTypeOf<dto.GetBundleRequest>().toEqualTypeOf<readSchemas.GetBundleRequest>();
  expectTypeOf<dto.GetBundleResponse>().toEqualTypeOf<readSchemas.GetBundleResponse>();
  expectTypeOf<dto.BundleDetailView>().toEqualTypeOf<readSchemas.BundleDetailView>();
  expectTypeOf<dto.BundleAvailabilityView>().toEqualTypeOf<readSchemas.BundleAvailabilityView>();
  expectTypeOf<dto.BundleHistoryRequest>().toEqualTypeOf<readSchemas.BundleHistoryRequest>();
  expectTypeOf<dto.BundleHistoryResponse>().toEqualTypeOf<readSchemas.BundleHistoryResponse>();
  expectTypeOf<dto.PreviewBundlePriceRequest>().toEqualTypeOf<readSchemas.PreviewBundlePriceRequest>();
  expectTypeOf<dto.PreviewBundlePriceResponse>().toEqualTypeOf<readSchemas.PreviewBundlePriceResponse>();
  expectTypeOf<dto.BundlePricePreview>().toEqualTypeOf<readSchemas.BundlePricePreview>();
  expectTypeOf<dto.SellableBundle>().toEqualTypeOf<feedSchemas.SellableBundle>();
  expectTypeOf<dto.SellableBundleComponent>().toEqualTypeOf<feedSchemas.SellableBundleComponent>();
  expectTypeOf<dto.SellableBundleAvailability>().toEqualTypeOf<feedSchemas.SellableBundleAvailability>();
  expectTypeOf<dto.SellableBundleListResponse>().toEqualTypeOf<feedSchemas.SellableBundleListResponse>();
  expect(BundleCatalogReadError).toBe(catalog.BundleCatalogReadError);
  expect(new BundleRpcError("P0002", "missing")).toBeInstanceOf(DomainRpcError);
  const rules = catalog.createBundleWriteRules({ assertActivateNotMachineActor });
  for (const actorKind of ["human", "machine"] as const) {
    for (const operation of ["create", "activate", "deactivate"]) {
      expect(rules.evaluateBundleWriteRules({ operation, actorKind })).toEqual(evaluateBundleWriteRules({ operation, actorKind }));
    }
  }
  const availability = catalog.createBundleAvailability({ offerAvailabilityStatusFor, offerAvailabilityReasonCode });
  for (const sellableNow of [null, 0, 2, 20]) {
    const input = { components: [{ sku: "UNIT-A", quantity: 2, isAddon: false, sellableNow }] };
    expect(availability.deriveBundleAvailability(input)).toEqual(deriveBundleAvailability(input));
  }
  const mutations: unknown[] = [], reads: unknown[] = [];
  const mutationKit: typeof createAdminMutationHandler = (options) => {
    mutations.push(options);
    return createAdminMutationHandler(options);
  };
  const readKit: typeof createAdminParameterizedReadHandler = (options) => {
    reads.push(options);
    return createAdminParameterizedReadHandler(options);
  };
  const write = catalog.createAdminBundleHandlers({ bundleSpec, BundleRpcError, COMMERCE_CONTRACT_VERSION, createAdminMutationHandler: mutationKit });
  const read = catalog.createAdminBundleReadHandlers({ bundleSpec, BundleRpcError, COMMERCE_CONTRACT_VERSION, createAdminParameterizedReadHandler: readKit, ...readSchemas });
  const authorizeAdmin = async () => ({ ok: true as const, userId: "actor-id", role: "admin" as const, isMachineActor: false });
  for (const factory of Object.values(write)) factory({ writePort: {} as catalog.AdminBundleWritePort, authorizeAdmin, mutationsEnabled: true, activationEnabled: true });
  for (const factory of Object.values(read)) factory({ readPort: {} as catalog.BundleCatalogReadPort, authorizeAdmin, readsEnabled: true });
  expect(mutations).toHaveLength(9);
  for (const options of mutations as { mutation: unknown; toResponse(value: unknown): unknown }[]) {
    expect(Object.values(bundleSpec.mutations)).toContain(options.mutation);
    expect(options.toResponse({ dryRun: false, idempotent: false })).toMatchObject({ contractVersion: COMMERCE_CONTRACT_VERSION });
  }
  expect((reads as { query: unknown }[]).map((options) => options.query)).toEqual(Object.values(bundleSpec.queries!));
  expect((reads as { responseSchema: unknown }[]).map((options) => options.responseSchema)).toEqual([
    readSchemas.listBundlesResponseSchema, readSchemas.getBundleResponseSchema, readSchemas.bundleHistoryResponseSchema, readSchemas.previewBundlePriceResponseSchema,
  ]);
  const readPort = { getBundle: vi.fn(async () => null) } as unknown as catalog.BundleCatalogReadPort;
  const handler = createAdminBundleGetHandler({ readPort, authorizeAdmin, readsEnabled: true });
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() } as unknown as Parameters<typeof handler>[1];
  vi.mocked(res.status).mockReturnValue(res);
  await handler({ method: "GET", query: { code: "fixed-set" }, headers: {} } as unknown as Parameters<typeof handler>[0], res);
  expect(res.status).toHaveBeenCalledWith(404);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "NOT_FOUND" }) }));
  const feedBundle = {
    code: "fixed-set", title: "Fixed set", fulfillmentMode: "virtual", currency: "XXX", targetPriceMinor: 2001, mode: "one_time",
    components: [{ sku: "UNIT-A", title: "Unit A", productSlug: "unit-a", variantId: "variant-a", quantity: 2, isAddon: false, sortOrder: 0, referenceUnitPriceMinor: 1500 }],
  };
  const described = { composition: feedBundle, components: feedBundle.components.map(component => ({ ...component, sellableNow: null })), availability: { status: "unknown" as const, sellableNow: null, limitingSku: "UNIT-A", reasonCode: "BUNDLE_COMPONENT_STOCK_UNKNOWN" } };
  const service = { describeActiveBundles: async () => [described], describeCompositions: async () => [described] };
  const schema = vi.spyOn(feedSchemas.sellableBundleListResponseSchema, "safeParse");
  const boundFeed = catalog.createSellableBundleHandlers({ responder: { sendBffError, sendBffSuccess, sendMethodNotAllowed }, sellableBundleListResponseSchema: feedSchemas.sellableBundleListResponseSchema, SELLABLE_BUNDLE_CONTRACT_VERSION: feedSchemas.SELLABLE_BUNDLE_CONTRACT_VERSION });
  try {
    for (const factory of [createSellableBundleHandler, boundFeed.createSellableBundleHandler]) {
      await factory({ availabilityService: service, enabled: true })({ method: "GET" } as Parameters<typeof handler>[0], res);
    }
    expect(schema).toHaveBeenCalledTimes(2);
    expect(schema).toHaveBeenLastCalledWith({ contractVersion: feedSchemas.SELLABLE_BUNDLE_CONTRACT_VERSION, bundles: [catalog.toSellableBundle(feedBundle, described.availability)] });
    expect(feedSchemas.sellableBundleListResponseSchema.parse((vi.mocked(res.json).mock.calls.at(-1)![0] as { data: unknown }).data).bundles).toHaveLength(1);
    expect(vi.mocked(res.json).mock.calls.at(-1)).toEqual(vi.mocked(res.json).mock.calls.at(-2));
  } finally { schema.mockRestore(); }
  const browser = await rolldown({ input: ["src/domains/bundle/adminBundleClient.ts", "src/domains/bundle/sellableBundleClient.ts"], platform: "browser" });
  try {
    const { output } = await browser.generate({ format: "es", dir: "browser-closure", minify: true });
    const inputs = [...new Set(output.flatMap((chunk) => chunk.type === "chunk" ? Object.keys(chunk.modules) : []))].map((path) => path.replaceAll("\\", "/"));
    const packageInputs = inputs.filter((path) => /(?:packages\/platform\/|@openlup\/platform\/)/.test(path));
    expect(packageInputs.length).toBeGreaterThan(0);
    expect(packageInputs.filter((path) => /\/catalog\//.test(path) && !/\/catalog\/contracts\//.test(path))).toEqual([]);
    expect(packageInputs.some((path) => /\/(data|http|bff)\//.test(path))).toBe(false);
    for (const name of ["adminBundleContracts", "adminBundleLifecycleContracts", "adminBundleReadContracts", "sellableBundleContracts"])
      expect(inputs.some((path) => path.endsWith(`/src/domains/bundle/${name}.ts`))).toBe(true);
  } finally { await browser.close(); }
});
