import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as channels from "../../src/channels/index.js";
import * as contracts from "../../src/channels/contracts/index.js";
import type { NormalizedChannelOrder, ChannelPurchaseCapture, ChannelScope, ChannelPurchasedExpandedLine } from "../../src/channels/contracts/index.js";
import { expandChannelBundleLines } from "../../src/channels/index.js";
import { orderFixture } from "./fixtures.js";

describe("R1 package boundary and bundle helper witness", () => {
  it("keeps the contracts entry runtime empty and schema types structurally faithful", () => {
    expect(Object.keys(contracts)).toEqual([]);
    expectTypeOf<ReturnType<typeof channels.normalizedChannelOrderSchema.parse>>().toEqualTypeOf<NormalizedChannelOrder>();
    expectTypeOf<ReturnType<typeof channels.channelPurchaseCaptureSchema.parse>>().toEqualTypeOf<ChannelPurchaseCapture>();
    expectTypeOf<ReturnType<typeof channels.channelScopeSchema.parse>>().toEqualTypeOf<ChannelScope>();
    expectTypeOf<ReturnType<typeof channels.channelPurchasedExpandedLineSchema.parse>>().toEqualTypeOf<ChannelPurchasedExpandedLine>();
  });
  it("bundles the browser entry without Node, database, server or browser-BFF-client dependencies", async () => {
    const result = await build({ entryPoints: [fileURLToPath(new URL("../../src/channels/index.ts", import.meta.url))],
      bundle: true, platform: "browser", format: "esm", write: false, metafile: true, logLevel: "silent" });
    const inputs = Object.keys(result.metafile!.inputs).join("\n");
    expect(inputs).not.toMatch(/channels\/server|\/bff\/|\/http\/|\/data\/|node_modules\/pg\//);
    expect(result.outputFiles[0].text).not.toMatch(/process\.env|channel_ingest_rails_unbound/);
    expect(channels).not.toHaveProperty("createChannelWebhookHandler");
    expect(channels).not.toHaveProperty("createManagedChannelIngestPayments");
  });
  it("passes SKU lines through exactly and preserves omitted expansion semantics", () => {
    const order = orderFixture(); expect(expandChannelBundleLines(order, [])).toEqual({ ok: true, expanded: false, lines: [{
      externalLineRef: "line:19", externalOfferRef: "offer:53", skuCode: "PART-A", quantity: 3, unitGrossMinor: 3,
      lineGrossMinor: 9, lineDiscountMinor: 4, vatRateBps: 1900, bundleCode: null, bundleQty: null,
    }] });
  });
  it("uses channel-final totals, weights only current components and preserves shipping/payment input", () => {
    const order = orderFixture(); order.lines[0].sellable = { kind: "bundle", externalOfferRef: "offer:53", bundleCode: "SYNTHETIC-KIT" };
    order.lines[0].quantity = 1; order.lines[0].unitGrossMinor = 9;
    const before = structuredClone(order);
    const result = expandChannelBundleLines(order, [{ bundleCode: "SYNTHETIC-KIT", components: [
      { skuCode: "PART-A", quantity: 1, referenceUnitPriceMinor: 100 }, { skuCode: "PART-B", quantity: 1, referenceUnitPriceMinor: 200 } ] }]);
    expect(result.ok).toBe(true); if (!result.ok) throw new Error("unexpected bundle refusal");
    expect(result.expanded).toBe(true);
    expect(result.lines.reduce((sum, line) => sum + line.lineGrossMinor, 0)).toBe(9);
    expect(result.lines.reduce((sum, line) => sum + line.lineDiscountMinor, 0)).toBe(4);
    expect(result.lines.map(line => [line.skuCode, line.quantity, line.bundleCode, line.bundleQty])).toEqual([
      ["PART-A", 1, "SYNTHETIC-KIT", 1], ["PART-B", 1, "SYNTHETIC-KIT", 1] ]);
    expect(order).toEqual(before);
  });
  it.each(["missing", "unpriced", "empty"])("preserves %s bundle refusal vocabulary", defect => {
    const order = orderFixture(); order.lines[0].sellable = { kind: "bundle", externalOfferRef: "offer:53", bundleCode: "SYNTHETIC-KIT" };
    const compositions = defect === "missing" ? [] : [{ bundleCode: "SYNTHETIC-KIT", components: defect === "empty" ? [] : [{ skuCode: "PART-A", quantity: 1, referenceUnitPriceMinor: null }] }];
    expect(expandChannelBundleLines(order, compositions)).toMatchObject({ ok: false, refusal: { kind: defect === "missing" ? "unmapped_sellable" : "money_mismatch", vocabulary: "SYNTHETIC-KIT" } });
  });
});
