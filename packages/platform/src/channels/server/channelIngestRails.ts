import { InventoryPersistenceError } from "../../inventory/index.js";
import type { ChannelIngestPaymentControlPort, ChannelIngestOrderItemReadPort, ChannelIngestReservationPort } from "../channelIngestStorePort.js";

export interface ChannelRailsError { code?: string; message?: string; details?: string; hint?: string }
export interface ChannelRailsResult { data: unknown; error: ChannelRailsError | null }
export interface ChannelRailsRpc { rpc(name: string, args: Record<string, unknown>): PromiseLike<ChannelRailsResult> }
export interface ChannelRailsQuery extends PromiseLike<ChannelRailsResult> {
  select(columns: string): ChannelRailsQuery;
  eq(column: string, value: unknown): ChannelRailsQuery;
  order(column: string, options?: { ascending?: boolean }): ChannelRailsQuery;
}
export interface ManagedChannelRailsClient extends ChannelRailsRpc { from(table: string): ChannelRailsQuery }

/** Only the existing payment owner's operations needed by channel ingest are injected. */
export interface ChannelPaymentOwnerPort {
  createIntent(input: { idempotencyKey: string; targetKind: "one_time_order"; orderId: string;
    subscriptionId: null; subscriptionCycleId: null; amountMinor: number; currency: string;
    metadata: Record<string, unknown> }): Promise<{ paymentIntentId: string }>;
  applyResult(input: { idempotencyKey: string; orderId: string; paymentIntentId: string;
    paymentEventId: string; resultStatus: "succeeded"; occurredAt: string }): Promise<{ orderId: string }>;
}
function railFailure(name: string, error: ChannelRailsError): Error & { code?: string } {
  // Only this stock RPC participates in admission; raw SQLSTATE elsewhere has no semantic authority.
  if (name === "channel_reserve_order_items" && error.code === "55P03") {
    return new InventoryPersistenceError("Inventory admission temporarily unavailable", { code: "55P03",
      reason: error.message === "inventory_admission_busy" ? "inventory_admission_busy" : "inventory_lock_unavailable" });
  }
  const detail = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  const logicalName = name === "channel_reserve_order_items" ? "inventory_reserve_order_items" : name;
  const failure = new Error(`${logicalName}_failed: ${detail || error.code || "unknown"}`) as Error & { code?: string };
  failure.code = error.code;
  return failure;
}
function object(value: unknown, key: string, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(`channel_rails_response_invalid: ${path}`);
  const nested = (value as Record<string, unknown>)[key];
  if (!nested || typeof nested !== "object") throw new Error(`channel_rails_response_invalid: ${path}`);
  return nested as Record<string, unknown>;
}
function string(value: Record<string, unknown>, key: string, path: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.length === 0) throw new Error(`channel_rails_response_invalid: ${path}`);
  return raw;
}
export function createManagedChannelIngestOrderItemRead(client: ManagedChannelRailsClient): ChannelIngestOrderItemReadPort {
  return { async readOrderItems(orderId) {
    const { data, error } = await client.from("commerce_order_items").select("id, sku_id, quantity")
      .eq("order_id", orderId).order("allocation_ordinal", { ascending: true });
    if (error) throw railFailure("commerce_order_items_read", error);
    return (Array.isArray(data) ? data : []).map((row: unknown, index: number) => {
      if (!row || typeof row !== "object") throw new Error(`channel_rails_response_invalid: orderItems[${index}]`);
      const record = row as Record<string, unknown>;
      if (typeof record.sku_id !== "string" || !record.sku_id) throw new Error(`channel_rails_order_item_without_sku: ${orderId}`);
      return { orderItemId: string(record, "id", `orderItems[${index}].id`), skuId: record.sku_id, quantity: Number(record.quantity) };
    });
  } };
}
export function createManagedChannelIngestReservations(client: ChannelRailsRpc): ChannelIngestReservationPort {
  return { async reserveChannelOrderItems(input) {
    const { data, error } = await client.rpc("channel_reserve_order_items", {
      p_idempotency_key: input.idempotencyKey, p_order_id: input.orderId,
      p_items: input.items.map(item => ({ orderItemId: item.orderItemId, skuId: item.skuId, quantity: item.quantity })),
      p_metadata: input.metadata ?? {}, p_provider_kind: input.providerKind,
    });
    if (error) throw railFailure("channel_reserve_order_items", error);
    const reservations = (data as Record<string, unknown> | null)?.reservations;
    return { reservedItemCount: Array.isArray(reservations) ? reservations.length : 0 };
  } };
}
/** Open settlement provider text reaches the existing SQL owner directly, never the execution-brand union. */
export function createManagedChannelIngestPayments(client: ChannelRailsRpc, control: ChannelPaymentOwnerPort): ChannelIngestPaymentControlPort {
  return {
    async createIntent(input) {
      const result = await control.createIntent({ ...input, targetKind: "one_time_order", subscriptionId: null, subscriptionCycleId: null });
      return { paymentIntentId: result.paymentIntentId };
    },
    async recordAttempt(input) {
      const { data, error } = await client.rpc("commerce_payment_control_record_attempt", {
        p_idempotency_key: input.idempotencyKey, p_payment_intent_id: input.paymentIntentId,
        p_provider: input.provider, p_provider_attempt_id: input.providerAttemptId, p_provider_session_id: null,
        p_attempt_status: "processing", p_next_action_kind: null, p_request_payload: input.requestPayload, p_response_payload: input.responsePayload,
      });
      if (error) throw railFailure("commerce_payment_control_record_attempt", error);
      return { paymentAttemptId: string(object(data, "paymentAttempt", "recordAttempt"), "id", "recordAttempt.id") };
    },
    async ingestSettlementEvent(input) {
      const { data, error } = await client.rpc("commerce_payment_control_ingest_event", {
        p_provider: input.provider, p_provider_event_id: input.providerEventId, p_event_type: "payment.succeeded",
        p_provider_payment_id: input.providerPaymentId, p_payment_intent_id: input.paymentIntentId, p_payment_attempt_id: null,
        p_amount_cents: input.amountMinor, p_currency: input.currency, p_signature_verified: true, p_payload: input.payload,
      });
      if (error) throw railFailure("commerce_payment_control_ingest_event", error);
      return { paymentEventId: string(object(data, "paymentEvent", "ingestSettlementEvent"), "id", "ingestSettlementEvent.id") };
    },
    async applySucceeded(input) {
      const result = await control.applyResult({ ...input, resultStatus: "succeeded" });
      return { orderId: result.orderId };
    },
  };
}
export class ChannelIngestCapabilityUnavailableError extends Error {
  constructor(readonly capability: string) { super(`channel_ingest_capability_unavailable: ${capability}`); this.name = "ChannelIngestCapabilityUnavailableError"; }
}
export function createPortableChannelIngestReservations(): ChannelIngestReservationPort {
  return { async reserveChannelOrderItems() { throw new ChannelIngestCapabilityUnavailableError("inventory_reserve_order_items"); } };
}
export function createPortableChannelIngestPayments(): ChannelIngestPaymentControlPort {
  return {
    async createIntent() { throw new ChannelIngestCapabilityUnavailableError("commerce_payment_control_create_intent"); },
    async recordAttempt() { throw new ChannelIngestCapabilityUnavailableError("commerce_payment_control_record_attempt"); },
    async ingestSettlementEvent() { throw new ChannelIngestCapabilityUnavailableError("commerce_payment_control_ingest_event"); },
    async applySucceeded() { throw new ChannelIngestCapabilityUnavailableError("commerce_payment_control_apply_result"); },
  };
}
