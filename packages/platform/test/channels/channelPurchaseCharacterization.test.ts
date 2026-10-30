import { allocateBundleTargetPrice } from "@openlup/core/pricing";
import { describe, expect, it, vi } from "vitest";
import { allocateChannelMoney, channelComponentMoneyRows, normalizedChannelOrderSchema, channelPurchaseCaptureSchema,
  channelPurchaseCaptureReadSchema, channelPullPageSchema, channelPullCursorReceiptSchema, channelPurchasedExpandedLineSchema,
  channelOrderIngestedPayloadSchema } from "../../src/channels/index.js";
import { resolveChannelPurchasedBundles, prepareChannelPurchasedRows, bindChannelPurchasedRows, consumeChannelPurchasedCapture,
  recoverChannelPurchasedOrders, acknowledgeChannelPurchasedOutcome, ChannelControlError } from "../../src/channels/server/index.js";
import { digest, id, orderFixture, purchaseFixture } from "./fixtures.js";

function resolution(f = purchaseFixture()) {
  return resolveChannelPurchasedBundles({ order: f.capture.normalized, products: f.capture.products,
    observed: { scope: f.capture.scope, namespace: f.capture.namespace }, contexts: [f.context] });
}
describe("R1 exact retained purchase witness", () => {
  it("allocates quantity three, final five, discount four into exact integer groups", () => {
    const result = allocateChannelMoney({ finalMinor: 5, discountMinor: 4, purchasedSets: 3,
      components: [{ skuId: id(107), skuCode: "PART-A", quantityPerSet: 1, weightMinor: 1 }] });
    expect(result.normalizationFactor).toBe(2);
    expect(result.rawComponents).toEqual([{ skuId: id(107), skuCode: "PART-A", quantityPerSet: 1, weightMinor: 1 }]);
    expect(result.groups.map(row => [row.quantity, row.lineGrossMinor, row.lineDiscountMinor])).toEqual([[1, 4, 2], [1, 3, 1], [1, 2, 1]]);
    expect(result.groups.map(row => [row.unitFinalMinor, row.unitDiscountMinor, row.groupIndex])).toEqual([[2, 2, 0], [2, 1, 1], [1, 1, 2]]);
  });
  it.each([[0, 0], [0, 8], [7, 0], [43, 29]])("conserves final %s and discount %s across exact component groups", (finalMinor, discountMinor) => {
    const components = [{ skuId: id(401), skuCode: "PART-B", quantityPerSet: 2, weightMinor: 7 }, { skuId: id(409), skuCode: "PART-A", quantityPerSet: 3, weightMinor: 2 }];
    const result = allocateChannelMoney({ finalMinor, discountMinor, purchasedSets: 2, components });
    expect(allocateChannelMoney({ finalMinor, discountMinor, purchasedSets: 2, components: [...components].reverse() })).toEqual(result);
    expect(result.groups.reduce((sum, row) => sum + row.lineFinalMinor, 0)).toBe(finalMinor);
    expect(result.groups.reduce((sum, row) => sum + row.lineDiscountMinor, 0)).toBe(discountMinor);
    expect(result.groups.reduce((sum, row) => sum + row.lineGrossMinor, 0)).toBe(finalMinor + discountMinor);
    expect(result.groups.filter(row => row.skuCode === "PART-A").reduce((sum, row) => sum + row.quantity, 0)).toBe(6);
    expect(result.groups.filter(row => row.skuCode === "PART-B").reduce((sum, row) => sum + row.quantity, 0)).toBe(4);
  });
  it.each(["negative", "fraction", "sets", "weight", "duplicate", "unsafe-gross", "unsafe-product", "empty"])("refuses invalid %s money without rounding or a retail cap", defect => {
    const input = { finalMinor: 5, discountMinor: 4, purchasedSets: 3, components: [{ skuId: id(107), skuCode: "PART-A", quantityPerSet: 1, weightMinor: 1 }] };
    if (defect === "negative") input.discountMinor = -1;
    if (defect === "fraction") input.finalMinor = 1.2;
    if (defect === "sets") input.purchasedSets = 0;
    if (defect === "weight") input.components[0].weightMinor = 0;
    if (defect === "duplicate") input.components.push({ ...input.components[0] });
    if (defect === "unsafe-gross") input.finalMinor = Number.MAX_SAFE_INTEGER;
    if (defect === "unsafe-product") input.components[0].quantityPerSet = Number.MAX_SAFE_INTEGER;
    if (defect === "empty") input.components = [];
    expect(() => allocateChannelMoney(input)).toThrow(RangeError);
  });
  it("preserves independently allocated per-SKU final/discount, lexical ties and isolated raw provenance", () => {
    const components = [{ skuId: id(451), skuCode: "PART-B", quantityPerSet: 3, weightMinor: 2 }, { skuId: id(453), skuCode: "PART-A", quantityPerSet: 1, weightMinor: 1 }];
    const result = allocateChannelMoney({ finalMinor: 1001, discountMinor: 1199, purchasedSets: 2, components });
    expect(result.normalizationFactor).toBe(86);
    const weights = result.rawComponents.map(c => ({ sku: c.skuCode, quantity: c.quantityPerSet * 2, unitPriceMinor: c.weightMinor * 86 }));
    for (const [targetPriceMinor, field] of [[1001, "lineFinalMinor"], [1199, "lineDiscountMinor"]] as const) {
      const expected = allocateBundleTargetPrice({ components: weights, targetPriceMinor, minimumUnitPayableMinor: 0 });
      if (!expected.ok) throw new Error("supported target refused");
      for (const c of expected.components) expect(result.groups.filter(row => row.skuCode === c.sku).reduce((sum,row) => sum + row[field],0)).toBe(c.targetSubtotalMinor);
    }
    components[0].weightMinor = 99; expect(result.rawComponents.find(c => c.skuCode === "PART-B")?.weightMinor).toBe(2);
    const zero = allocateChannelMoney({ finalMinor: 1, discountMinor: 2, purchasedSets: 1, components: [{ ...components[1], quantityPerSet: 3 }] });
    expect(zero.groups.map(row => [row.quantity,row.unitFinalMinor,row.unitDiscountMinor])).toEqual([[1,1,1],[1,0,1],[1,0,0]]);
    const tied = allocateChannelMoney({ finalMinor: 5, discountMinor: 2, purchasedSets: 1, components: ["C","A","B"].map((skuCode,i) => ({ skuId:id(460+i),skuCode,quantityPerSet:1,weightMinor:1 })) });
    expect(tied.groups.find(row=>row.skuCode==="A")?.lineDiscountMinor).toBe(1);
  });
  it.each(["duplicate-sku", "duplicate-id", "raw-total", "scaled-total"])("refuses the distinct %s boundary", defect => {
    const c = { skuId:id(470),skuCode:"PART-A",quantityPerSet:1,weightMinor:1 };
    const input = { finalMinor:12,discountMinor:2,purchasedSets:1,components:[c] };
    if (defect === "duplicate-sku") input.components.push({ ...c,skuId:id(471) });
    if (defect === "duplicate-id") input.components.push({ ...c,skuCode:"PART-B" });
    if (defect === "raw-total") input.components = [{...c,weightMinor:Number.MAX_SAFE_INTEGER},{...c,skuId:id(471),skuCode:"PART-B"}];
    if (defect === "scaled-total") { input.finalMinor=Number.MAX_SAFE_INTEGER;input.discountMinor=0;input.components=[{...c,quantityPerSet:2,weightMinor:4_000_000_000_000_000}]; }
    expect(()=>allocateChannelMoney(input)).toThrow(RangeError);
  });
  it("preserves six physical components per purchased set and refuses missing retained qualification/basis/mapping", () => {
    const f=purchaseFixture(); f.context.bundle.components[0].quantity=6; f.context.firstQualification.offer.products[0].quantity=6;f.capture.products[0].products[0].quantityPerSet=6;
    const resolved=resolution(f);if(!resolved.ok)throw new Error(resolved.reason);
    expect(resolved.rows.reduce((sum,row)=>sum+row.line.quantity,0)).toBe(18);
    f.context.firstQualification.basis=[];expect(resolution(f).ok).toBe(false);
    const absent=purchaseFixture();Object.assign(absent.context,{firstQualification:null});expect(resolution(absent).ok).toBe(false);
    const changed=purchaseFixture();changed.context.firstQualification.mapping[0].externalProductRef="other:product";expect(resolution(changed).ok).toBe(false);
  });
  it("rejects invalid partitions and preserves the maximum safe money boundary", () => {
    expect(() => channelComponentMoneyRows({ skuId: id(107), skuCode: "PART-A", quantity: 3 }, [], [])).toThrow("channel_money_partition_invalid");
    const result = allocateChannelMoney({ finalMinor: Number.MAX_SAFE_INTEGER, discountMinor: 0, purchasedSets: 1,
      components: [{ skuId: id(107), skuCode: "PART-A", quantityPerSet: 1, weightMinor: 1 }] });
    expect(result.groups[0].lineGrossMinor).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("uses first locked BOM and exact historical IDs, money, Unicode/nulls, never today's commercial facts", () => {
    const f = purchaseFixture(), before = structuredClone(f), result = resolution(f);
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.reason);
    expect(result.rows.map(row => [row.line.quantity, row.line.lineGrossMinor, row.line.lineDiscountMinor])).toEqual([[1, 4, 2], [1, 3, 1], [1, 2, 1]]);
    result.rows.forEach((row, index) => expect(row.provenance).toEqual({ skuId: id(107), groupIndex: index, listingId: id(103), bundleDigest: digest,
      firstApprovalId: id(105), firstQualificationId: id(106), weightMinor: 1, normalizationFactor: 2 }));
    expect(f).toEqual(before);
    f.context.listing.state = "draft"; f.context.listing.manualStop = true; f.context.listing.version = 900; f.context.listing.approvalId = id(419);
    f.context.scope.connectionVersion = 901; f.context.scope.registryVersion = 902;
    f.context.firstQualification.offer.sellingState = "ENDED";
    // The stored qualification is already expired at purchase time in this synthetic history.
    expect(resolution(f)).toEqual(result);
  });
  it.each(["application", "surface", "seller", "environment", "channel", "currency", "slug"])("refuses conflicting %s authority instead of guessing retained ownership", defect => {
    const f = purchaseFixture(); f.capture.scope = { ...f.capture.scope }; f.capture.namespace = { ...f.capture.namespace };
    if (defect === "application") f.capture.namespace.applicationRef = "different:application";
    if (defect === "surface") f.capture.namespace.channelExternalRef = "different:surface";
    if (defect === "seller") f.capture.scope.sellerRef = "different:seller";
    if (defect === "environment") f.capture.scope.environmentRef = "different:environment";
    if (defect === "channel") f.capture.scope.channelId = id(421);
    if (defect === "currency") f.capture.scope.currency = "USD";
    if (defect === "slug") f.capture.normalized.channelSlug = "another-surface";
    expect(resolution(f)).toEqual({ ok: false, reason: "retained_binding_conflict" });
  });
  it.each(["digest", "lock", "first-approval", "first-qualification", "policy", "price", "addon", "pre-approval"])("refuses broken historical %s", defect => {
    const f = purchaseFixture();
    if (defect === "digest") f.context.bundle.compositionDigest = "e".repeat(64);
    if (defect === "lock") f.context.bundle.lockedAt = null;
    if (defect === "first-approval") f.context.firstApproval.firstBasisApprovalId = id(431);
    if (defect === "first-qualification") f.context.firstApproval.qualificationId = id(433);
    if (defect === "policy") f.context.firstApproval.policyRef = "different:policy";
    if (defect === "price") f.context.firstApproval.requestedPrice.grossMinor = 19;
    if (defect === "addon") f.context.bundle.components[0].isAddon = true;
    if (defect === "pre-approval") f.capture.products[0].purchasedAt = "2026-02-09T10:00:00Z";
    expect(resolution(f)).toEqual({ ok: false, reason: "retained_binding_conflict" });
  });
  it.each(["quantity", "product", "duplicate", "offer", "time", "unpaid"])("refuses conflicting purchased %s", defect => {
    const f = purchaseFixture();
    if (defect === "quantity") f.capture.products[0].products = [{ externalProductRef: "product:59", quantityPerSet: 2 }];
    if (defect === "product") f.capture.products[0].products = [{ externalProductRef: "product:other", quantityPerSet: 1 }];
    if (defect === "duplicate") f.capture.products.push(structuredClone(f.capture.products[0]));
    if (defect === "offer") f.capture.products[0].externalOfferRef = "offer:other";
    if (defect === "time") f.capture.products[0].purchasedAt = "yesterday";
    if (defect === "unpaid") f.capture.normalized.payment.state = "pending";
    expect(resolution(f).ok).toBe(false);
  });
  it("refuses absent or ambiguous retained listing contexts", () => {
    const f = purchaseFixture(), input = { order: f.capture.normalized, products: f.capture.products, observed: { scope: f.capture.scope, namespace: f.capture.namespace } };
    expect(resolveChannelPurchasedBundles({ ...input, contexts: [] })).toEqual({ ok: false, reason: "retained_binding_missing" });
    expect(resolveChannelPurchasedBundles({ ...input, contexts: [f.context, structuredClone(f.context)] })).toEqual({ ok: false, reason: "retained_binding_missing" });
  });
  it("pins exact rows once and leaves the already pinned capture unchanged without a current facts lookup", () => {
    const f = purchaseFixture(), rows = prepareChannelPurchasedRows({ capture: f.capture, contexts: [f.context] });
    const bound = bindChannelPurchasedRows({ capture: f.capture, contexts: [f.context] });
    expect(bound.retainedRows).toEqual(rows);
    expect(bindChannelPurchasedRows({ capture: bound, contexts: [] })).toEqual(bound);
    expect(() => prepareChannelPurchasedRows({ capture: f.capture, contexts: [] })).toThrow(ChannelControlError);
  });
  it("consumes an accepted alias using original rows, event/payment identity and ledger without another write", async () => {
    const f = purchaseFixture(), original = bindChannelPurchasedRows({ capture: f.capture, contexts: [f.context] });
    const alias = structuredClone(f.capture); alias.providerEventId = "alias:439"; alias.normalized.providerEventId = "alias:439";
    const contexts = vi.fn(), record = vi.fn(), ingest = vi.fn(async () => "consumed"), unresolved = vi.fn();
    expect(await consumeChannelPurchasedCapture({ capture: alias, accepted: async () => "ledger:443", contexts, record,
      original: async ledgerId => { expect(ledgerId).toBe("ledger:443"); return original; }, ingest, unresolved })).toBe("consumed");
    expect(contexts).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled(); expect(unresolved).not.toHaveBeenCalled();
    expect(ingest).toHaveBeenCalledWith(original, "ledger:443");
  });
  it("records unresolved source before reporting it and never guesses physical rows", async () => {
    const f = purchaseFixture(), effects: string[] = [];
    const outcome = await consumeChannelPurchasedCapture({ capture: f.capture, accepted: async () => null, contexts: async () => [],
      record: async capture => { effects.push("capture"); expect(capture.retainedRows).toBeUndefined(); return "ledger:449"; },
      original: async () => { effects.push("original"); return f.capture; }, ingest: async () => { throw new Error("must not ingest"); },
      unresolved: async (_, ledger) => { effects.push("unresolved"); return ledger; } });
    expect(outcome).toBe("ledger:449"); expect(effects).toEqual(["capture", "original", "unresolved"]);
  });
  it("preserves non-conflict owner errors as retryable before recording a new capture", async () => {
    const f = purchaseFixture(), error = new Error("owner_busy"), record = vi.fn();
    await expect(consumeChannelPurchasedCapture({ capture: f.capture, accepted: async () => null, contexts: async () => { throw error; },
      record, original: async () => f.capture, ingest: vi.fn(), unresolved: vi.fn() })).rejects.toBe(error);
    expect(record).not.toHaveBeenCalled();
  });
  it("recovers independent captures despite one unavailable result and completes only after actual ACK", async () => {
    const f = purchaseFixture(), captures = [f.capture, { ...f.capture, captureId: id(457) }], recover = vi.fn()
      .mockRejectedValueOnce(new Error("busy")).mockResolvedValueOnce({ kind: "replayed", ledgerId: "ledger:461", orderId: "order:463" });
    expect(await recoverChannelPurchasedOrders({ signal: new AbortController().signal, list: async () => captures, recover })).toEqual([
      { unavailable: true }, { outcome: { kind: "replayed", ledgerId: "ledger:461", orderId: "order:463" } }]);
    const acknowledge = vi.fn().mockResolvedValueOnce({ acknowledged: false }).mockResolvedValueOnce({ acknowledged: true }), complete = vi.fn();
    const input = { capture: f.capture, outcome: { kind: "replayed" as const, ledgerId: "ledger:461", orderId: "order:463" }, acknowledge, complete };
    expect(await acknowledgeChannelPurchasedOutcome(input)).toBe(false); expect(complete).not.toHaveBeenCalled();
    expect(await acknowledgeChannelPurchasedOutcome(input)).toBe(true); expect(complete).toHaveBeenCalledWith("ledger:461");
    expect(acknowledge).toHaveBeenCalledWith({ externalOrderRef: "sale:47", localOrderRef: "order:463" });
  });
});

describe("R1 source/page and privacy contracts", () => {
  it("roundtrips exact source Unicode/nulls and read canonical text/digest", () => {
    const { capture } = purchaseFixture();
    expect(channelPurchaseCaptureSchema.parse(capture)).toEqual(capture);
    const canonicalText = '{"text":"χ","nullable":null,"space":"  "}\n';
    expect(channelPurchaseCaptureReadSchema.parse({ ledgerId: id(467), canonicalText, inputDigest: digest })).toEqual({ ledgerId: id(467), canonicalText, inputDigest: digest });
  });
  it.each(["event", "revision", "currency", "product-line", "empty-retained", "extra"])("rejects conflicting capture %s", defect => {
    const { capture } = purchaseFixture();
    if (defect === "event") capture.providerEventId = "wrong:event";
    if (defect === "revision") capture.externalOrderRevision = null;
    if (defect === "currency") capture.scope.currency = "USD";
    if (defect === "product-line") capture.products[0].externalLineRef = "wrong:line";
    if (defect === "empty-retained") capture.retainedRows = [];
    if (defect === "extra") Object.assign(capture, { buyerCopy: capture.normalized.buyer });
    expect(channelPurchaseCaptureSchema.safeParse(capture).success).toBe(false);
  });
  it("validates page progress from observed events and refuses fabricated cursor/generation receipts", () => {
    const f = purchaseFixture(), page = { schemaVersion: "channel.pull-page.v1" as const, pagePacketId: id(479), scope: f.capture.scope,
      namespace: f.capture.namespace, execution: f.capture.execution, expected: { cursor: "event:old", watermark: "2026-02-11T10:00:00Z", generation: 7 },
      request: { from: "event:old", limit: 3 }, events: [{ providerEventId: "event:next", externalOrderRef: "sale:47", externalOrderRevision: null,
        occurredAt: "2026-02-12T07:12:00Z", rawSourceDigest: digest, disposition: "purchase" as const, captureRef: f.capture.captureId }],
      observedHead: { providerEventId: "event:head", occurredAt: "2026-02-12T07:19:00Z" }, observedAt: "2026-02-12T07:20:00Z",
      next: { cursor: "event:next", watermark: "2026-02-12T07:12:00Z", generation: 8 } };
    expect(channelPullPageSchema.parse(page)).toEqual(page);
    expect(channelPullPageSchema.safeParse({ ...page, next: { ...page.next, cursor: "fabricated" } }).success).toBe(false);
    expect(channelPullPageSchema.safeParse({ ...page, next: { ...page.next, watermark: page.observedHead.occurredAt } }).success).toBe(false);
    expect(channelPullPageSchema.safeParse({ ...page, events: [...page.events, ...page.events] }).success).toBe(false);
    expect(channelPullCursorReceiptSchema.safeParse({ pagePacketId: page.pagePacketId, before: page.expected, after: { ...page.next, generation: 99 } }).success).toBe(false);
    const empty = { ...page, events: [], next: { ...page.expected, generation: 8 } };
    expect(channelPullPageSchema.parse(empty)).toEqual(empty);
  });
  it("rejects item/header money lies and inexact retained item products", () => {
    const order = orderFixture(); order.lines[0].lineGrossMinor = 8;
    expect(normalizedChannelOrderSchema.safeParse(order).success).toBe(false);
    const f = purchaseFixture(), row = prepareChannelPurchasedRows({ capture: f.capture, contexts: [f.context] })[0];
    expect(channelPurchasedExpandedLineSchema.safeParse({ ...row, quantity: 2 }).success).toBe(false);
  });
  it("generic ingested outbox permits only identifiers and time, rejecting nested buyer/address copies", () => {
    const payload = { contract_version: "channel.order.ingested.v1", order_id: id(487), channel_slug: "synthetic-surface",
      external_order_ref: "sale:47", ingested_at: "2026-02-12T07:30:00Z" };
    expect(channelOrderIngestedPayloadSchema.parse(payload)).toEqual(payload);
    expect(channelOrderIngestedPayloadSchema.safeParse({ ...payload, normalized: { buyer: orderFixture().buyer } }).success).toBe(false);
  });
});
