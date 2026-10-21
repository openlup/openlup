import { expect, it, vi } from "vitest";
import { createAdminBundleGetHandler, createAdminBundlePreviewPriceHandler, type AdminBundleReadHandlerDeps } from "../../../server/domains/bundle/adminBundleReadHandler.js";
import type { BundleDetail, BundleTargetPriceRow } from "@openlup/platform/catalog";
import { getBundleResponseSchema } from "../../../src/domains/bundle/adminBundleReadContracts.js";

const price: BundleTargetPriceRow = { mode: "one_time", targetPriceMinor: 1800, currency: "XXX", amountKind: "gross", active: true, validFrom: "2026-03-01T00:00:00Z", validTo: null };
function detail(delta: Partial<BundleDetail> = {}): BundleDetail {
  return { code: "parity-set", title: "Synthetic collection", status: "active", fulfillmentMode: "virtual", componentCount: 1, hasActiveTargetPrice: true,
    updatedAt: "2026-03-02T00:00:00Z", compositionConstraint: null, metadata: {},
    components: [{ sku: "PART-P", title: "Part", productSlug: "synthetic-part", variantId: "internal-part", quantity: 2, isAddon: false, sortOrder: 0, referenceUnitPriceMinor: 1200 }],
    prices: [{ ...price, targetPriceMinor: 2300 }], resolvedTargetPrice: price, resolvedCurrency: "XXX", resolvedPriceListId: "selected-list", ...delta };
}
function deps(bundle: BundleDetail | null, effective = true): AdminBundleReadHandlerDeps {
  return { readsEnabled: true, authorizeAdmin: async () => ({ ok: true, userId: "synthetic-actor", role: "owner", isMachineActor: false }) as never,
    readPort: { getBundle: vi.fn(async () => bundle), listBundles: async () => ({ bundles: [], total: 0 }), listActiveBundleCompositions: async () => [], listBundleHistory: async () => ({ events: [], total: 0 }) },
    ...(effective ? { effectiveTarget: (value: BundleDetail) => value.resolvedTargetPrice ?? null } : {}) };
}
async function invoke(dependencies: AdminBundleReadHandlerDeps, query: Record<string, unknown> = {}, get = false) {
  const handler = (get ? createAdminBundleGetHandler : createAdminBundlePreviewPriceHandler)(dependencies);
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res);
  await handler({ method: "GET", query: { code: "parity-set", ...query }, headers: {} } as never, res as never);
  return { status: res.status.mock.calls.at(-1)?.[0], body: res.json.mock.calls.at(-1)?.[0] };
}
it("previews the authoritative target and carries it through the actual detail schema", async () => {
  const dependencies = deps(detail());
  expect(await invoke(dependencies)).toMatchObject({ status: 200, body: { data: { preview: { targetPriceMinor: 1800, referenceTotalMinor: 2400, mode: "one_time" } } } });
  const response = await invoke(dependencies, {}, true);
  expect(response.body.data.bundle.resolvedTargetPrice).toEqual(price);
  expect(response.body.data.bundle.components[0]).not.toHaveProperty("variantId");
  expect(getBundleResponseSchema.safeParse(response.body.data).success).toBe(true);
  delete response.body.data.bundle.resolvedTargetPrice;
  expect(getBundleResponseSchema.safeParse(response.body.data).success).toBe(true);
});
it("refuses an authoritative null without searching active history", async () => {
  expect(await invoke(deps(detail({ resolvedTargetPrice: null })))).toMatchObject({ status: 404, body: { error: { details: { reason: "no_active_target_price" } } } });
});
it("preserves omitted-hook outputs and mode matching even with a resolved target present", async () => {
  const selected = detail();
  const old = detail(); delete old.resolvedTargetPrice;
  const first = await invoke(deps(selected, false));
  expect(first).toEqual(await invoke(deps(old, false)));
  expect(first.body.data.preview).toMatchObject({ targetPriceMinor: 2300, mode: "one_time" });
  expect(await invoke(deps(selected, false), { mode: "subscription" })).toMatchObject({ status: 404 });
  expect((await invoke(deps(detail({ prices: [] }), false), { targetPriceMinor: 1700 })).body.data.preview.mode).toBe("any");
});
it("uses one_time only as the opt-in default mode and honors explicit target and mode", async () => {
  const dependencies = deps(detail({ resolvedTargetPrice: null }));
  expect((await invoke(dependencies, { targetPriceMinor: 1700 })).body.data.preview).toMatchObject({ targetPriceMinor: 1700, mode: "one_time" });
  expect((await invoke(dependencies, { targetPriceMinor: 1700, mode: "subscription" })).body.data.preview.mode).toBe("subscription");
  expect(dependencies.readPort.getBundle).toHaveBeenLastCalledWith({ code: "parity-set", currency: undefined, mode: "subscription" });
});
it("retains bundle, list, composition, anchor and allocation refusal precedence", async () => {
  for (const [bundle, status, reason] of [
    [null, 404, "bundle_not_found"],
    [detail({ resolvedPriceListId: null, components: [] }), 404, "no_active_price_list"],
    [detail({ components: [] }), 409, "min_components"],
    [detail({ components: [{ ...detail().components[0], referenceUnitPriceMinor: null }], resolvedTargetPrice: null }), 409, "component_unpriced:PART-P"],
    [detail({ resolvedTargetPrice: { ...price, targetPriceMinor: 9900 } }), 409, "TARGET_ABOVE_COMPONENT_SUM"],
  ] as const) expect(await invoke(deps(bundle))).toMatchObject({ status, body: { error: { details: { reason } } } });
});
