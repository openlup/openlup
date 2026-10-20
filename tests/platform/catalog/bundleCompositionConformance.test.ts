import { expect, it, vi } from "vitest";
import { createAdminBundleActivateHandler, createAdminBundleCreateDraftHandler, createAdminBundleSetCompositionHandler } from "../../../server/domains/bundle/adminBundleHandler.js";
import type { AdminBundleWritePort } from "../../../server/domains/bundle/adminBundleWritePort.js";
import type { BundleCatalogReadPort, ActiveBundleComposition } from "../../../server/domains/bundle/bundleCatalogReadPort.js";
import { createBundleAvailabilityService, createUnknownOfferAvailabilityPort } from "../../../server/domains/bundle/bundleAvailabilityService.js";
import { toSellableBundle } from "../../../server/domains/bundle/sellableBundleHandler.js";

type Handler = ReturnType<typeof createAdminBundleActivateHandler>;
function response() {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as Parameters<Handler>[1];
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
async function call(handler: Handler, body: unknown) {
  const res = response();
  await handler({ method: "POST", body, query: {}, headers: {} } as Parameters<Handler>[0], res);
  return vi.mocked(res.json).mock.calls.at(-1)?.[0];
}
function port(): AdminBundleWritePort {
  const result = { idempotent: false, dryRun: false, code: "fixed-set", bundleId: "bundle-id" };
  return { loadCompositionConstraint: vi.fn(async () => null), ...Object.fromEntries(
    ["upsertDraft", "updateDraft", "setComposition", "setTargetPrice", "archive", "restore", "cloneDraft", "activate", "deactivate"].map((key) => [key, vi.fn(async () => result)]),
  ) } as unknown as AdminBundleWritePort;
}
function deps(writePort: AdminBundleWritePort, machine = true) {
  return { writePort, mutationsEnabled: true, activationEnabled: true,
    authorizeAdmin: async () => ({ ok: true as const, userId: "actor-id", role: "admin" as const, isMachineActor: machine }) };
}
const components = [
  { sku: "UNIT-A", quantity: 2, isAddon: false, sortOrder: 0 },
  { sku: "UNIT-B", quantity: 1, isAddon: true, sortOrder: 1 },
];

it("captures ordered composition, batches stock and allocates 2,001 exactly", async () => {
  const write = port();
  let captured = components.slice(0, 0);
  vi.mocked(write.setComposition).mockImplementation(async (_actor, input) => {
    captured = input.components;
    return { idempotent: false, dryRun: false, code: input.code, componentCount: captured.length };
  });
  expect(await call(createAdminBundleSetCompositionHandler(deps(write)), { mode: "commit", code: "fixed-set", components })).toMatchObject({ ok: true });
  expect(captured).toEqual(components);
  const composition: ActiveBundleComposition = { code: "fixed-set", title: "Fixed set", fulfillmentMode: "virtual", currency: "XXX", targetPriceMinor: 2001, mode: "one_time",
    components: captured.map((entry, i) => ({ ...entry, title: entry.sku, productSlug: `unit-${i}`, variantId: `variant-${i}`, referenceUnitPriceMinor: i === 0 ? 1000 : 500 })) };
  const read = { listActiveBundleCompositions: vi.fn(async () => [composition, { ...composition, code: "other-set" }]) } as unknown as BundleCatalogReadPort;
  const unknown = createUnknownOfferAvailabilityPort();
  const stock = { getAvailability: vi.fn(unknown.getAvailability) };
  const rows = await createBundleAvailabilityService({ bundleCatalogReadPort: read, offerAvailabilityPort: stock }).describeActiveBundles();
  expect(stock.getAvailability).toHaveBeenCalledOnce();
  expect(stock.getAvailability.mock.calls[0][0].items.map((item) => item.sku)).toEqual(["UNIT-A", "UNIT-B"]);
  expect(rows[0].availability.sellableNow).toBeNull();
  expect(rows[0].components.map((entry) => entry.sellableNow)).toEqual([null, null]);
  const bundle = toSellableBundle(rows[0].composition, rows[0].availability)!;
  expect(bundle.price).toEqual({ amountMinor: 2001, currency: "XXX" });
  expect(bundle.components.map((line) => line.lineSubtotalMinor)).toEqual([801, 800, 400]);
  expect(bundle.components.reduce((sum, line) => sum + line.lineSubtotalMinor, 0)).toBe(2001);
  for (const line of bundle.components) expect(line.effectiveUnitPriceMinor * line.quantity).toBe(line.lineSubtotalMinor);
});

it("refuses duplicate and add-on-only composition before writing", async () => {
  const write = port();
  for (const invalid of [[components[0], components[0]], [{ ...components[0], isAddon: true }]]) {
    expect(await call(createAdminBundleSetCompositionHandler(deps(write)), { mode: "commit", code: "fixed-set", components: invalid })).toMatchObject({ ok: false });
  }
  expect(write.setComposition).not.toHaveBeenCalled();
});

it("allows a machine virtual draft and refuses unsupported fulfillment before writing", async () => {
  const write = port();
  for (const fulfillmentMode of ["virtual", "kitted"]) {
    expect(await call(createAdminBundleCreateDraftHandler(deps(write)), { mode: "commit", bundle: { code: "fixed-set", title: "Fixed set", fulfillmentMode } })).toMatchObject({ ok: fulfillmentMode === "virtual" });
  }
  expect(write.upsertDraft).toHaveBeenCalledOnce();
});

it("refuses machine activation and lets the enabled human test actor reach the port", async () => {
  const write = port();
  expect(await call(createAdminBundleActivateHandler(deps(write)), { mode: "commit", code: "fixed-set" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  expect(write.activate).not.toHaveBeenCalled();
  expect(await call(createAdminBundleActivateHandler(deps(write, false)), { mode: "commit", code: "fixed-set" })).toMatchObject({ ok: true });
  expect(write.activate).toHaveBeenCalledOnce();
});
