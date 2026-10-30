import { describe, expect, it, vi } from "vitest";
import { normalizedChannelOrderSchema, channelIngestStatusRank, isInsufficientStockError } from "../../src/channels/index.js";
import type { ChannelIngestLedger, ChannelIngestChannelRecord, ChannelIngestStatus } from "../../src/channels/index.js";
import { runChannelOrderIngest, admitChannelOrder, NoopChannelSettlementNotAllowedError, createChannelWebhookPort,
  classifyQuarantineReason, quarantineVocabulary } from "../../src/channels/server/index.js";
import type { ChannelOrderIngestSagaDeps } from "../../src/channels/server/index.js";
import { orderFixture, purchaseFixture } from "./fixtures.js";
import { prepareChannelPurchasedRows } from "../../src/channels/server/index.js";

function harness() {
  const effects: string[] = [];
  const ledger: ChannelIngestLedger = { id: "ledger:201", status: "received", orderId: null, clientId: null,
    shippingAddressId: null, paymentIntentId: null, externalOrderRevision: "revision:8", conflict: null, eventReplayed: false, replayed: false };
  const channel: ChannelIngestChannelRecord = { id: "channel:203", connectionId: "connection:211", slug: "synthetic-surface", status: "active",
    currency: "EUR", connectorProviderKind: "synthetic_source", settlementProviderKind: "collected_sale", buyerCommsOwner: "channel",
    deliverySelection: { providerKind: "  STOCK_SOURCE  ", reference: "delivery:223" } };
  const deps: ChannelOrderIngestSagaDeps = {
    acceptedCurrencies: ["EUR"], noopSettlementForbidden: false, channels: { readChannelBySlug: vi.fn(async () => { effects.push("channel"); return channel; }) },
    store: {
      recordInboundEvent: vi.fn(async () => { effects.push("event"); return { ...ledger }; }),
      upsertBuyer: vi.fn(async () => { effects.push("buyer"); ledger.clientId = "customer:227"; ledger.shippingAddressId = "address:229";
        return { clientId: ledger.clientId, shippingAddressId: ledger.shippingAddressId, clientCreated: true, replayed: false }; }),
      createChannelOrder: vi.fn(async () => { effects.push("order"); ledger.orderId = "order:233"; return { orderId: ledger.orderId, orderRef: "local:239", replayed: false }; }),
      advanceLedger: vi.fn(async input => { effects.push(input.toStatus); ledger.status = input.toStatus;
        if (input.paymentIntentId) ledger.paymentIntentId = input.paymentIntentId; return { ...ledger }; }),
      quarantine: vi.fn(async input => { effects.push("quarantine"); return { id: "quarantine:241", reason: input.reason, status: "open", vocabulary: input.vocabulary }; }),
    },
    orderItems: { readOrderItems: vi.fn(async () => { effects.push("items"); return [{ orderItemId: "item:251", skuId: "sku:257", quantity: 3 }]; }) },
    reservations: { reserveChannelOrderItems: vi.fn(async () => { effects.push("reserve"); return { reservedItemCount: 1 }; }) },
    payments: {
      createIntent: vi.fn(async () => { effects.push("intent"); return { paymentIntentId: "intent:263" }; }),
      recordAttempt: vi.fn(async () => { effects.push("attempt"); return { paymentAttemptId: "attempt:269" }; }),
      ingestSettlementEvent: vi.fn(async () => { effects.push("settlement"); return { paymentEventId: "settlement:271" }; }),
      applySucceeded: vi.fn(async () => { effects.push("apply"); return { orderId: "order:233" }; }),
    },
  };
  return { deps, ledger, channel, effects };
}

describe("R1 normalized ingest preservation witness", () => {
  it("keeps Unicode/nulls, declared delivery, original keys and paid instant through the complete effect order", async () => {
    const h = harness(), order = orderFixture();
    expect(normalizedChannelOrderSchema.parse(order)).toEqual(order);
    expect(await runChannelOrderIngest(h.deps, order)).toEqual({ kind: "settled", ledgerId: "ledger:201", orderId: "order:233", paymentIntentId: "intent:263" });
    expect(h.effects).toEqual(["channel", "event", "buyer", "order", "items", "reserve", "reserved", "intent", "attempt", "settlement", "apply", "settled", "done"]);
    expect(h.deps.store.recordInboundEvent).toHaveBeenCalledWith({ channelId: "channel:203", externalOrderRef: "sale:47",
      externalOrderRevision: "revision:8", providerEventId: "delivery:903", normalized: order });
    expect(h.deps.store.upsertBuyer).toHaveBeenCalledWith({ ledgerId: "ledger:201", buyer: order.buyer, shipTo: order.shipTo });
    expect(h.deps.store.createChannelOrder).toHaveBeenCalledWith({ idempotencyKey: "ch:channel:203:ord:sale:47:order", ledgerId: "ledger:201", expandedLines: undefined });
    expect(h.deps.reservations.reserveChannelOrderItems).toHaveBeenCalledWith({ idempotencyKey: "ch:channel:203:ord:sale:47:inventory", orderId: "order:233",
      items: [{ orderItemId: "item:251", skuId: "sku:257", quantity: 3 }], metadata: { source: "channels.ingest.v0", channelSlug: "synthetic-surface" }, providerKind: "stock_source" });
    expect(h.deps.payments.createIntent).toHaveBeenCalledWith({ idempotencyKey: "ch:channel:203:ord:sale:47:payment-intent", orderId: "order:233", amountMinor: 10, currency: "EUR",
      metadata: { source: "channels.ingest.v0", channelSlug: "synthetic-surface", externalOrderRef: "sale:47" } });
    expect(h.deps.payments.recordAttempt).toHaveBeenCalledWith({ idempotencyKey: "ch:channel:203:ord:sale:47:payment-attempt", paymentIntentId: "intent:263", provider: "collected_sale",
      providerAttemptId: "collection:78", requestPayload: { source: "channels.ingest.v0", externalOrderRef: "sale:47" }, responsePayload: { providerCall: false, collectedBy: "channel" } });
    expect(h.deps.payments.ingestSettlementEvent).toHaveBeenCalledWith({ provider: "collected_sale", providerEventId: "collection:78:settlement", providerPaymentId: "collection:78",
      paymentIntentId: "intent:263", amountMinor: 10, currency: "EUR", payload: { source: "channels.ingest.v0", externalOrderRef: "sale:47" } });
    expect(h.deps.payments.applySucceeded).toHaveBeenCalledWith({ idempotencyKey: "ch:channel:203:ord:sale:47:payment-result", orderId: "order:233",
      paymentIntentId: "intent:263", paymentEventId: "settlement:271", occurredAt: "2026-02-12T08:13:17+01:00" });
  });
  it("stops before money on shortage and retries the same obligation", async () => {
    const h = harness(); vi.mocked(h.deps.reservations.reserveChannelOrderItems).mockRejectedValueOnce(new Error("inventory_reservation_insufficient_available_stock"));
    expect(await runChannelOrderIngest(h.deps, orderFixture())).toEqual({ kind: "blocked_stock", ledgerId: "ledger:201", orderId: "order:233", detail: "inventory_reservation_insufficient_available_stock" });
    expect(h.deps.payments.createIntent).not.toHaveBeenCalled();
    expect(h.effects).toEqual(["channel", "event", "buyer", "order", "items", "blocked_stock"]);
    await runChannelOrderIngest(h.deps, orderFixture());
    expect(vi.mocked(h.deps.store.createChannelOrder).mock.calls.map(([input]) => input.idempotencyKey)).toEqual(["ch:channel:203:ord:sale:47:order", "ch:channel:203:ord:sale:47:order"]);
    expect(h.deps.payments.applySucceeded).toHaveBeenCalledTimes(1);
  });
  it.each(["reservation", "order", "payment"])("preserves transient %s failure as retryable, without a quarantine", async stage => {
    const h = harness(), failure = new Error("temporary_busy");
    if (stage === "reservation") vi.mocked(h.deps.reservations.reserveChannelOrderItems).mockRejectedValueOnce(failure);
    if (stage === "order") vi.mocked(h.deps.store.createChannelOrder).mockRejectedValueOnce(failure);
    if (stage === "payment") vi.mocked(h.deps.payments.recordAttempt).mockRejectedValueOnce(failure);
    await expect(runChannelOrderIngest(h.deps, orderFixture())).rejects.toBe(failure);
    expect(h.deps.store.quarantine).not.toHaveBeenCalled();
    expect((await runChannelOrderIngest(h.deps, orderFixture())).kind).toBe("settled");
  });
  it("preserves a busy reservation's ledger/order and retries identical full arguments once", async () => {
    const h = harness(), failure = Object.assign(new Error("Inventory admission temporarily unavailable"), { code: "55P03" });
    vi.mocked(h.deps.reservations.reserveChannelOrderItems).mockRejectedValueOnce(failure);
    await expect(runChannelOrderIngest(h.deps, orderFixture())).rejects.toBe(failure);
    expect(h.ledger).toMatchObject({ id: "ledger:201", orderId: "order:233" });
    expect(h.deps.payments.createIntent).not.toHaveBeenCalled();
    expect(h.deps.store.quarantine).not.toHaveBeenCalled();
    expect((await runChannelOrderIngest(h.deps, orderFixture())).kind).toBe("settled");
    const calls = vi.mocked(h.deps.reservations.reserveChannelOrderItems).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
    expect(h.deps.payments.ingestSettlementEvent).toHaveBeenCalledTimes(1);
  });
  it("preserves one identity and effect through fresh execution, exact replay and normalized redelivery", async () => {
    const h = harness(), first = orderFixture();
    const settled = await runChannelOrderIngest(h.deps, first);
    expect(settled).toMatchObject({ kind: "settled", ledgerId: "ledger:201", orderId: "order:233" });
    expect(await runChannelOrderIngest(h.deps, first)).toEqual({ kind: "replayed", ledgerId: "ledger:201", orderId: "order:233" });
    expect(await runChannelOrderIngest(h.deps, { ...first, providerEventId: "redelivery:281" })).toEqual({ kind: "replayed", ledgerId: "ledger:201", orderId: "order:233" });
    expect(h.deps.store.recordInboundEvent).toHaveBeenCalledTimes(3);
    for (const effect of [h.deps.store.upsertBuyer, h.deps.store.createChannelOrder, h.deps.reservations.reserveChannelOrderItems,
      h.deps.payments.createIntent, h.deps.payments.ingestSettlementEvent, h.deps.payments.applySucceeded]) expect(effect).toHaveBeenCalledTimes(1);
    expect(h.ledger).toMatchObject({ id: "ledger:201", orderId: "order:233", clientId: "customer:227", paymentIntentId: "intent:263", status: "done" });
  });
  it("replays done before buyer, inventory or payment effects", async () => {
    const h = harness(); h.ledger.status = "done"; h.ledger.orderId = "original:277";
    expect(await runChannelOrderIngest(h.deps, orderFixture())).toEqual({ kind: "replayed", ledgerId: "ledger:201", orderId: "original:277" });
    expect(h.effects).toEqual(["channel", "event"]);
  });
  it("files revision conflict with original evidence and creates no order", async () => {
    const h = harness(); h.ledger.conflict = "revision_conflict"; h.ledger.externalOrderRevision = "revision:old";
    expect(await runChannelOrderIngest(h.deps, orderFixture())).toEqual({ kind: "quarantined", ledgerId: "ledger:201", reason: "revision_conflict", detail: "recorded revision:old, delivered revision:8" });
    expect(h.deps.store.quarantine).toHaveBeenCalledWith({ channelId: "channel:203", connectionId: "connection:211", providerEventId: "delivery:903", externalOrderRef: "sale:47",
      vocabulary: "revision:8", reason: "revision_conflict", payload: { recordedRevision: "revision:old", deliveredRevision: "revision:8", ledgerStatus: "received" } });
    expect(h.effects).toEqual(["channel", "event", "quarantine"]);
  });
  it.each(["channel_order_unmapped_sellable", "channel_order_money_equation_mismatch", "channel_order_vat_unresolvable"])("halts named %s and retains the wire vocabulary", async raised => {
    const h = harness(); vi.mocked(h.deps.store.createChannelOrder).mockRejectedValue(new Error(raised));
    const outcome = await runChannelOrderIngest(h.deps, orderFixture());
    expect(outcome.kind).toBe("quarantined"); expect(h.ledger.status).toBe("quarantined");
    expect(h.deps.reservations.reserveChannelOrderItems).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.store.quarantine).mock.calls[0][0].payload).toEqual({ detail: raised, totals: orderFixture().totals });
  });
  it("quarantines missing bundle binding before creating an order", async () => {
    const h = harness(), { capture } = purchaseFixture();
    expect(await runChannelOrderIngest(h.deps, capture.normalized)).toEqual({ kind: "quarantined", ledgerId: "ledger:201", reason: "unmapped_sellable", detail: "no bundle catalogue is bound on this deployment" });
    expect(h.deps.store.createChannelOrder).not.toHaveBeenCalled();
  });
  it("uses exact retained rows despite disabled current channel and keeps paid debt settled until ACK", async () => {
    const h = harness(), f = purchaseFixture(); h.channel.status = "disabled";
    h.deps.purchasedRows = prepareChannelPurchasedRows({ capture: f.capture, contexts: [f.context] });
    await runChannelOrderIngest(h.deps, f.capture.normalized);
    expect(h.ledger.status).toBe("settled");
    expect(vi.mocked(h.deps.store.createChannelOrder).mock.calls[0][0].expandedLines).toEqual(h.deps.purchasedRows);
    h.effects.length = 0;
    expect((await runChannelOrderIngest(h.deps, f.capture.normalized)).kind).toBe("replayed");
    expect(h.effects).toEqual(["channel", "event"]);
  });
});

describe("R1 admission order and refusal names", () => {
  it.each(["missing", "inactive", "delivery", "payment", "unaccepted", "mismatch"])("refuses %s before durable effects", async defect => {
    const h = harness(), order = orderFixture();
    if (defect === "missing") vi.mocked(h.deps.channels.readChannelBySlug).mockResolvedValue(null);
    if (defect === "inactive") h.channel.status = "sunset";
    if (defect === "delivery") h.channel.deliverySelection = null;
    if (defect === "payment") order.payment.state = "pending";
    if (defect === "unaccepted") { h.channel.currency = "USD"; order.currency = "USD"; }
    if (defect === "mismatch") { order.currency = "USD"; h.deps.acceptedCurrencies = ["EUR", "USD"]; }
    const expected = { missing: "channel_not_found", inactive: "channel_not_active", delivery: "delivery_selection_undeclared",
      payment: "unsupported_payment_state", unaccepted: "currency_not_accepted", mismatch: "currency_mismatch" }[defect];
    expect(await runChannelOrderIngest(h.deps, order)).toMatchObject({ kind: "refused", refusal: expected });
    expect(h.deps.store.recordInboundEvent).not.toHaveBeenCalled();
  });
  it("admits testing and a real connector through the forbidden-simulation gate", async () => {
    const h = harness(); h.channel.status = "testing"; h.deps.noopSettlementForbidden = true;
    expect((await runChannelOrderIngest(h.deps, orderFixture())).kind).toBe("settled");
  });
  it.each(["inactive-before-delivery", "payment-before-currency", "channel-currency"])("preserves refusal precedence %s", defect => {
    const h = harness(), order = orderFixture();
    if (defect === "inactive-before-delivery") { h.channel.status = "disabled"; h.channel.deliverySelection = null; }
    if (defect === "payment-before-currency") { order.payment.state = "pending"; h.channel.currency = "USD"; }
    if (defect === "channel-currency") h.channel.currency = "USD";
    expect(admitChannelOrder({ order, channel: h.channel, acceptedCurrencies: ["EUR"], noopSettlementForbidden: true })).toMatchObject({
      refusal: defect === "inactive-before-delivery" ? "channel_not_active" : defect === "payment-before-currency" ? "unsupported_payment_state" : "currency_not_accepted",
    });
  });
  it("keeps the first applicable refusal and throws forbidden simulation only after ordinary admission", () => {
    const h = harness(), order = orderFixture(); h.channel.connectorProviderKind = "noop_channel";
    const input = { order, channel: h.channel, acceptedCurrencies: ["EUR"], noopSettlementForbidden: true };
    h.channel.deliverySelection = null; order.payment.state = "pending";
    expect(admitChannelOrder(input)).toMatchObject({ refusal: "delivery_selection_undeclared" });
    h.channel.deliverySelection = {}; order.payment.state = "paid_externally";
    expect(() => admitChannelOrder(input)).toThrow(NoopChannelSettlementNotAllowedError);
    expect(() => admitChannelOrder({ ...input, retainedPaidCapture: true })).toThrow(NoopChannelSettlementNotAllowedError);
  });
  it.each(["channels", "rails"])("names missing %s before any ledger write", async missing => {
    const h = harness();
    const port = createChannelWebhookPort({ store: h.deps.store, channels: missing === "channels" ? undefined : h.deps.channels,
      rails: undefined, acceptedCurrencies: ["EUR"], noopSettlementForbidden: false });
    await expect(port.ingestOrder(orderFixture())).rejects.toMatchObject({ reason: missing === "channels" ? "channel_read_unavailable" : "channel_ingest_rails_unbound" });
    expect(h.effects).toEqual([]);
  });
  it("keeps state ranking and structural stock/named refusal classification", () => {
    expect((["received", "buyer_ready", "order_created", "reserved", "settled", "done", "failed"] as ChannelIngestStatus[]).map(channelIngestStatusRank)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(isInsufficientStockError({ name: "CommerceRuntimeConflictError", code: "23514" })).toBe(true);
    expect(isInsufficientStockError({ message: "allocation_incomplete" })).toBe(true);
    expect(isInsufficientStockError(new Error("timeout"))).toBe(false);
    expect(classifyQuarantineReason({ details: "channel_order_line_sum_mismatch" })).toBe("money_mismatch");
    expect(classifyQuarantineReason({ message: "permission denied" })).toBe(null);
    expect(quarantineVocabulary(new Error("channel_order_unmapped_sellable"), "  wire:χ  ")).toBe("wire:χ");
  });
});
