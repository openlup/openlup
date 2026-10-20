import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import type { HttpRequest } from "@openlup/platform/http";
import { checkReadiness, type ReadinessInput } from "@openlup/core/readiness";
import { createCatalogProductTypeRegistry } from "@openlup/platform/catalog";
import { createM05CatalogBinding } from "../../../server/runtime/public-reference/m05CatalogBinding.js";
import { proveCatalogCompositionConsumer, assertConsumerIsolation } from "../../../scripts/packages/platform-cold-consumer.js";

it("selected readiness / cold-consumer refusal", async () => {
  const version = JSON.parse(readFileSync("packages/platform/package.json", "utf8")).version;
  const quote = () => { throw new Error("quote_unavailable"); }, offer = () => { throw new Error("offer_unavailable"); };
  const input: Parameters<typeof createM05CatalogBinding>[0] = {
    executor: { query: async () => { throw new Error("store_unavailable"); } }, data: { connectionString: "postgresql://synthetic.invalid/unused" },
    auth: { identity: "synthetic", run: async (_token, work) => work({ authorize: async () => ({ ok: false, code: "UNAUTHORIZED", message: "Synthetic denied" }) }) },
    stock: { getAvailability: async () => { throw new Error("stock_unavailable"); } }, registry: createCatalogProductTypeRegistry([]),
    version, catalogue: { version: "complete-catalogue", migration: "complete-catalogue" }, quote, offer, applyPromotions: quote,
  };
  const binding = createM05CatalogBinding(input);
  try {
    expect(binding.ports["@openlup/platform/catalog:read"]).toBe(binding.catalog.getSkuEnvelope);
    expect(binding.ports["@openlup/platform/catalog:draftApply"]).toBe(binding.draftStore.apply);
    expect(binding.ports["@openlup/platform/catalog:draftRead"]).toBe(binding.draftStore.get);
    expect(binding.ports["@openlup/platform/catalog:bundleRead"]).toBe(binding.bundleRead.getBundle);
    expect(binding.ports["@openlup/platform/catalog:bundleWrite"]).toBe(binding.bundleWrite.setComposition);
    expect(binding.ports["@openlup/platform/catalog:stock"]).toBe(input.stock.getAvailability);
    expect(binding.ports["@openlup/platform/catalog:authorize"]).toBe(input.auth.run);
    expect(binding.ports["@openlup/platform/pricing:authority"]).toBe(binding.priceAuthority.resolvePrice);
    expect(binding.ports["@openlup/platform/pricing:quote"]).toBe(quote);
    expect(binding.ports["@openlup/platform/pricing:offer"]).toBe(offer);
    expect(binding.ports["@openlup/platform/promotions:apply"]).toBe(input.applyPromotions);
    for (const contribution of binding.contributions) for (const route of contribution.routes) expect(binding.routes[`@openlup/platform/catalog:${route.id}`]).toBe(binding.handlers[route.id]);
    expect(binding.capabilities).toEqual({ read: true, draft: true, publicationRead: false, publish: false, lifecycleWrite: false });
    expect(binding.unsupported).toEqual(["publicationRead", "publish", "lifecycleWrite", "nativeAcquisitionAcceptance", "nativePromotionAdminWrite", "nativePromotionCodeCandidateResolution"]);
    const observed: ReadinessInput = {
      candidate: { artifact: "synthetic", configuration: "synthetic", environment: "synthetic", database: "synthetic", schema: "complete-catalogue" }, inventoryComplete: true,
      loadedPackages: [{ name: "@openlup/core", version, kind: "kernel" }, { name: "@openlup/platform", version, kind: "rail", modules: ["catalog", "pricing", "promotions"] }],
      contributions: binding.contributions, vocabulary: [], exemptions: [], bindings: { ports: binding.ports, routes: binding.routes, triggers: {}, env: {} },
      schemaProbe: { observe: async requirement => ({ database: "synthetic", version: "complete-catalogue", objects: requirement.objects.map(object => ({ object, present: true })) }) },
    };
    expect((await checkReadiness(observed)).state).toBe("ready");
    for (const missing of ["read", "draftApply", "draftRead", "bundleRead", "bundleWrite", "stock", "authorize"]) {
      const ports = { ...binding.ports }; delete ports[`@openlup/platform/catalog:${missing}`];
      expect((await checkReadiness({ ...observed, bindings: { ...observed.bindings, ports } })).issues).toContainEqual(expect.objectContaining({ code: "OPENLUP_E_PORT_MISSING", subject: missing }));
    }
    for (const state of [false, null] as const) expect((await checkReadiness({ ...observed, schemaProbe: { observe: async requirement => ({ database: "synthetic", version: "complete-catalogue", objects: requirement.objects.map((object, i) => ({ object, present: i === 0 ? state : true })) }) } })).state).toBe(state === null ? "unknown" : "unsatisfied");
    expect((await checkReadiness({ ...observed, schemaProbe: { observe: async () => ({ database: "synthetic", version: "complete-catalogue", objects: [] }) } })).state).not.toBe("ready");
    expect((await checkReadiness({ ...observed, inventoryComplete: false })).state).toBe("unknown");
    expect((await checkReadiness({ ...observed, candidate: { ...observed.candidate, database: "other" } })).state).toBe("unknown");
    expect((await checkReadiness({ ...observed, schemaProbe: { observe: async requirement => ({ database: "synthetic", version: null, objects: requirement.objects.map(object => ({ object, present: true })) }) } })).state).toBe("unknown");
    expect(() => createM05CatalogBinding({ ...input, executor: null as unknown as typeof input.executor })).toThrow("m05_catalog_store_required");
    expect(() => createM05CatalogBinding({ ...input, stock: null as unknown as typeof input.stock })).toThrow("m05_catalog_stock_required");
    await expect(binding.catalog.getSkuEnvelope({ kind: "sku_code", skuCode: "ABSENT" })).rejects.toThrow("store_unavailable");
    expect(await binding.drafts.execute({}, { headers: {} } as HttpRequest)).toMatchObject({ outcome: "unauthorized" });
    await expect(input.stock.getAvailability({ items: [] })).rejects.toThrow("stock_unavailable");
  } finally { await binding.close(); }

  // The same SDK-absent scenario used by release tooling, now exercised against packed artifacts.
  const scratch = mkdtempSync(join(tmpdir(), "m05-packed-"));
  const npm = (args: string[], cwd: string) => execFileSync("npm", args, { cwd, stdio: "pipe", timeout: 120_000 }).toString();
  try {
    const tarballs: string[] = [];
    for (const name of ["core", "platform"]) {
      const packed = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], resolve(`packages/${name}`)));
      tarballs.push(join(scratch, packed[0].filename));
    }
    const packed = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], resolve("node_modules/zod")));
    tarballs.push(join(scratch, packed[0].filename));
    const consumer = join(scratch, "consumer"); mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), '{"type":"module","private":true}');
    npm(["install", "--ignore-scripts", "--legacy-peer-deps", "--omit=optional", "--no-audit", "--no-fund", ...tarballs], consumer);
    assertConsumerIsolation(consumer, process.cwd());
    proveCatalogCompositionConsumer(consumer);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 180_000);
