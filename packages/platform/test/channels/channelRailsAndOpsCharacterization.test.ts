import { describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../src/http/index.js";
import { createBffResponder } from "../../src/bff/index.js";
import { createAdminChannelOpsHandler, createManagedChannelIngestPayments, createManagedChannelIngestReservations,
  createManagedChannelIngestOrderItemRead, createPortableChannelIngestPayments, createPortableChannelIngestReservations,
  ChannelIngestCapabilityUnavailableError } from "../../src/channels/server/index.js";
import type { AdminChannelOpsHandlerDeps, ChannelPaymentOwnerPort, ManagedChannelRailsClient, ChannelRailsResult } from "../../src/channels/server/index.js";

function opsHarness() {
  const req = { method: "GET", query: { orderId: "  order:601  " } } as unknown as HttpRequest;
  const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as HttpResponse;
  const deps: AdminChannelOpsHandlerDeps = { enabled: true, authorizeAdmin: vi.fn(async () => ({ ok: true, userId: "actor:607" })),
    readPort: { readOrderChannel: vi.fn(async () => ({ channelId: "channel:613", slug: "synthetic-surface", displayName: "Synthetic surface", status: "disabled" })),
      readOrderIngest: vi.fn(async () => ({ ledgerId: "ledger:617", status: "blocked_stock", externalOrderRef: "sale:47", externalOrderRevision: null, lastError: "stock_busy", updatedAt: "2026-02-12T07:31:00Z" })),
      countOpenQuarantine: vi.fn(async () => 3) } };
  return { req, res, deps, run: () => createAdminChannelOpsHandler(deps)(req, res), body: () => vi.mocked(res.json).mock.calls.at(-1)?.[0] };
}
describe("R1 operator read witness", () => {
  it.each(["method", "flag", "authority", "order"])("refuses missing %s before any read", async boundary => {
    const h = opsHarness();
    if (boundary === "method") h.req.method = "POST";
    if (boundary === "flag") h.deps.enabled = false;
    if (boundary === "authority") vi.mocked(h.deps.authorizeAdmin).mockResolvedValue({ ok: false });
    if (boundary === "order") h.req.query = {};
    await h.run(); expect(h.deps.readPort.readOrderChannel).not.toHaveBeenCalled();
    expect(h.res.status).toHaveBeenCalledWith(boundary === "flag" ? 503 : boundary === "authority" ? 403 : 400);
    if (boundary === "method" || boundary === "flag") expect(h.deps.authorizeAdmin).not.toHaveBeenCalled();
  });
  it("answers a non-channel order without querying a ledger or quarantine count", async () => {
    const h = opsHarness(); vi.mocked(h.deps.readPort.readOrderChannel).mockResolvedValue(null); await h.run();
    expect(h.body()).toEqual({ ok: true, data: { contractVersion: "channels.ops.v1", orderId: "order:601", channel: null, ingest: null, openQuarantineCount: 0 } });
    expect(h.deps.readPort.readOrderIngest).not.toHaveBeenCalled(); expect(h.deps.readPort.countOpenQuarantine).not.toHaveBeenCalled();
  });
  it("returns the validated ledger and channel drawer count under host request-reference binding", async () => {
    const h = opsHarness(); h.deps.responder = createBffResponder({ responseRequestId: () => "request:619" }); await h.run();
    expect(h.body()).toEqual({ ok: true, data: { contractVersion: "channels.ops.v1", orderId: "order:601",
      channel: { slug: "synthetic-surface", displayName: "Synthetic surface", status: "disabled" },
      ingest: { ledgerId: "ledger:617", status: "blocked_stock", externalOrderRef: "sale:47", externalOrderRevision: null, lastError: "stock_busy", updatedAt: "2026-02-12T07:31:00Z" }, openQuarantineCount: 3 } });
    expect(h.res.setHeader).toHaveBeenCalledWith("x-request-id", "request:619");
    expect(h.deps.readPort.readOrderIngest).toHaveBeenCalledWith("order:601");
    expect(h.deps.readPort.countOpenQuarantine).toHaveBeenCalledWith("channel:613");
  });
  it("reports a channel order with no ledger and carries the halted run's original error", async () => {
    const h = opsHarness(); vi.mocked(h.deps.readPort.readOrderIngest).mockResolvedValueOnce(null); await h.run();
    expect(h.body()).toMatchObject({ data: { channel: { slug: "synthetic-surface" }, ingest: null, openQuarantineCount: 3 } });
    await h.run(); expect(h.body()).toMatchObject({ data: { ingest: { status: "blocked_stock", lastError: "stock_busy" } } });
  });
  it("refuses an invalid owner result rather than returning malformed panel facts", async () => {
    const h = opsHarness(); vi.mocked(h.deps.readPort.countOpenQuarantine).mockResolvedValue(-1); await h.run();
    expect(h.res.status).toHaveBeenCalledWith(503); expect(h.body()).toEqual({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "Invalid channel operations response" } });
  });
});

describe("R1 borrowed owner mappings", () => {
  it("delegates intent/result to the existing owner and preserves open settlement-provider RPC parameters", async () => {
    const rpc = vi.fn(async (name: string): Promise<ChannelRailsResult> => ({ error: null,
      data: name.endsWith("record_attempt") ? { paymentAttempt: { id: "attempt:631" } } : { paymentEvent: { id: "event:641" } } }));
    const control: ChannelPaymentOwnerPort = { createIntent: vi.fn(async () => ({ paymentIntentId: "intent:643" })), applyResult: vi.fn(async () => ({ orderId: "order:647" })) };
    const payments = createManagedChannelIngestPayments({ rpc }, control);
    const intent = { idempotencyKey: "intent-key", orderId: "order:647", amountMinor: 10, currency: "EUR", metadata: { source: "channels.ingest.v0" } };
    expect(await payments.createIntent(intent)).toEqual({ paymentIntentId: "intent:643" });
    expect(control.createIntent).toHaveBeenCalledWith({ ...intent, targetKind: "one_time_order", subscriptionId: null, subscriptionCycleId: null });
    await payments.recordAttempt({ idempotencyKey: "attempt-key", paymentIntentId: "intent:643", provider: "collected_sale", providerAttemptId: "collection:78", requestPayload: { a: 1 }, responsePayload: { providerCall: false } });
    await payments.ingestSettlementEvent({ provider: "collected_sale", providerEventId: "collection:78:settlement", providerPaymentId: "collection:78", paymentIntentId: "intent:643", amountMinor: 10, currency: "EUR", payload: { b: 2 } });
    expect(rpc.mock.calls).toEqual([
      ["commerce_payment_control_record_attempt", { p_idempotency_key: "attempt-key", p_payment_intent_id: "intent:643", p_provider: "collected_sale", p_provider_attempt_id: "collection:78",
        p_provider_session_id: null, p_attempt_status: "processing", p_next_action_kind: null, p_request_payload: { a: 1 }, p_response_payload: { providerCall: false } }],
      ["commerce_payment_control_ingest_event", { p_provider: "collected_sale", p_provider_event_id: "collection:78:settlement", p_event_type: "payment.succeeded", p_provider_payment_id: "collection:78",
        p_payment_intent_id: "intent:643", p_payment_attempt_id: null, p_amount_cents: 10, p_currency: "EUR", p_signature_verified: true, p_payload: { b: 2 } }],
    ]);
    const result = { idempotencyKey: "result-key", orderId: "order:647", paymentIntentId: "intent:643", paymentEventId: "event:641", occurredAt: "2026-02-12T08:13:17+01:00" };
    expect(await payments.applySucceeded(result)).toEqual({ orderId: "order:647" });
    expect(control.applyResult).toHaveBeenCalledWith({ ...result, resultStatus: "succeeded" });
  });
  it("preserves the paid-debt reservation kind, provider and stock refusal evidence", async () => {
    const rpc = vi.fn(async (): Promise<ChannelRailsResult> => ({ data: { reservations: [{ id: "hold:653" }] }, error: null }));
    const reservation = createManagedChannelIngestReservations({ rpc });
    const input = { idempotencyKey: "inventory-key", orderId: "order:659", items: [{ orderItemId: "item:661", skuId: "sku:673", quantity: 3 }], providerKind: "stock_source" };
    expect(await reservation.reserveChannelOrderItems(input)).toEqual({ reservedItemCount: 1 });
    expect(rpc).toHaveBeenCalledWith("channel_reserve_order_items", { p_idempotency_key: "inventory-key", p_order_id: "order:659",
      p_items: input.items, p_metadata: {}, p_provider_kind: "stock_source" });
    rpc.mockResolvedValueOnce({ data: null, error: { code: "23514", details: "provider_insufficient_available_stock" } });
    await expect(reservation.reserveChannelOrderItems(input)).rejects.toMatchObject({ code: "23514", message: "inventory_reserve_order_items_failed: provider_insufficient_available_stock" });
  });
  it.each(["inventory_admission_busy", "other stock lock"])("preserves retryable 55P03 %s as the existing inventory error", async message => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "55P03", message } }));
    const reservations = createManagedChannelIngestReservations({ rpc });
    await expect(reservations.reserveChannelOrderItems({ idempotencyKey: "key", orderId: "order", items: [], providerKind: null })).rejects.toMatchObject({
      name: "InventoryPersistenceError", message: "Inventory admission temporarily unavailable",
      details: { code: "55P03", reason: message === "inventory_admission_busy" ? "inventory_admission_busy" : "inventory_lock_unavailable" },
    });
    const payments = createManagedChannelIngestPayments({ rpc }, { createIntent: vi.fn(), applyResult: vi.fn() });
    await expect(payments.recordAttempt({ idempotencyKey: "key", paymentIntentId: "intent", provider: "collected_sale", providerAttemptId: "ref", requestPayload: {}, responsePayload: {} }))
      .rejects.toMatchObject({ name: "Error", code: "55P03" });
  });
  it("reads actual persisted order items by allocation ordinal and refuses a missing SKU", async () => {
    let result: ChannelRailsResult = { data: [{ id: "item:677", sku_id: "sku:683", quantity: 3 }], error: null };
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
      then(resolve: (value: ChannelRailsResult) => unknown) { return Promise.resolve(result).then(resolve); } };
    const client = { from: vi.fn(() => query), rpc: vi.fn() } as unknown as ManagedChannelRailsClient;
    const read = createManagedChannelIngestOrderItemRead(client);
    expect(await read.readOrderItems("order:691")).toEqual([{ orderItemId: "item:677", skuId: "sku:683", quantity: 3 }]);
    expect(client.from).toHaveBeenCalledWith("commerce_order_items"); expect(query.eq).toHaveBeenCalledWith("order_id", "order:691");
    expect(query.order).toHaveBeenCalledWith("allocation_ordinal", { ascending: true });
    result = { data: [{ id: "item:677", sku_id: null, quantity: 3 }], error: null };
    await expect(read.readOrderItems("order:691")).rejects.toThrow("channel_rails_order_item_without_sku: order:691");
  });
  it("refuses fabricated attempt/event responses instead of minting identifiers", async () => {
    const payments = createManagedChannelIngestPayments({ rpc: async () => ({ data: {}, error: null }) }, { createIntent: vi.fn(), applyResult: vi.fn() });
    await expect(payments.recordAttempt({ idempotencyKey: "key", paymentIntentId: "intent", provider: "collected_sale", providerAttemptId: "ref", requestPayload: {}, responsePayload: {} })).rejects.toThrow("channel_rails_response_invalid: recordAttempt");
  });
  it("portable physical and payment calls refuse by capability name", async () => {
    const payments = createPortableChannelIngestPayments();
    await expect(createPortableChannelIngestReservations().reserveChannelOrderItems({ idempotencyKey: "key", orderId: "order", items: [], providerKind: null })).rejects.toBeInstanceOf(ChannelIngestCapabilityUnavailableError);
    await expect(payments.createIntent({ idempotencyKey: "key", orderId: "order", amountMinor: 1, currency: "EUR", metadata: {} })).rejects.toMatchObject({ capability: "commerce_payment_control_create_intent" });
    await expect(payments.recordAttempt({ idempotencyKey: "key", paymentIntentId: "intent", provider: "collected_sale", providerAttemptId: "ref", requestPayload: {}, responsePayload: {} })).rejects.toMatchObject({ capability: "commerce_payment_control_record_attempt" });
    await expect(payments.ingestSettlementEvent({ provider: "collected_sale", providerEventId: "event", providerPaymentId: "ref", paymentIntentId: "intent", amountMinor: 1, currency: "EUR", payload: {} })).rejects.toMatchObject({ capability: "commerce_payment_control_ingest_event" });
    await expect(payments.applySucceeded({ idempotencyKey: "key", orderId: "order", paymentIntentId: "intent", paymentEventId: "event", occurredAt: "2026-02-12T07:00:00Z" })).rejects.toMatchObject({ capability: "commerce_payment_control_apply_result" });
  });
});
