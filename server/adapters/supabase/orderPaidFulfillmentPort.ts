import type {
  OrderPaidFulfillmentPort,
  OrderPaidFulfillmentResult,
} from "../../domains/commerce/outboxOrderPaidFulfillmentPorts.js";

export const ORDER_PAID_DISPATCH_PROVIDER_KIND = "hidden_preview_fulfillment";
export const ORDER_PAID_DISPATCH_KEY_PREFIX = "order-paid-dispatch";
export const ORDER_PAID_DISPATCH_SPLIT_REVIEW_SUFFIX = "split-review";

interface OrderPaidRpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export interface OrderPaidFulfillmentSupabaseClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: OrderPaidRpcError | null }>;
}

const MAX_REASON_LENGTH = 300;
const FATAL_MARKER = /commerce_fulfillment_(?:invalid_input|order_not_found|order_not_fulfillable|missing_client|missing_shipping_address|shipping_address_not_found|payment_not_succeeded|active_hold|subscription_cycle_not_paid|missing_order_items|missing_catalog_sku|missing_inventory_reservation|not_found|label_invalid_status|handoff_requires_label|tracking_ref_conflict)/;
const FATAL_CODES = new Set(["22023", "23505", "23503", "23514", "22P02"]);
const RETRYABLE_CODE_PREFIXES = ["08", "40", "57", "53"];
const RETRYABLE_MARKER = /commerce_fulfillment_order_not_found/;

function truncate(value: string): string {
  return value.length <= MAX_REASON_LENGTH ? value : `${value.slice(0, MAX_REASON_LENGTH)}…`;
}

function classifyError(error: OrderPaidRpcError): { retryable: boolean; reason: string } {
  const code = error.code ?? "";
  const text = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  if (RETRYABLE_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))) {
    return { retryable: true, reason: truncate(text || `sqlstate_${code}`) };
  }
  if (RETRYABLE_MARKER.test(text)) {
    return { retryable: true, reason: truncate(text || "commerce_fulfillment_order_not_found") };
  }
  if (FATAL_CODES.has(code) || FATAL_MARKER.test(text)) {
    return { retryable: false, reason: truncate(text || `sqlstate_${code}` || "fulfillment_rejected") };
  }
  return { retryable: true, reason: truncate(text || `sqlstate_${code}` || "fulfillment_rpc_failed") };
}

function readStatus(data: unknown): string | null {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const status = (data as { status?: unknown }).status;
    return typeof status === "string" ? status : null;
  }
  return null;
}

function readFulfillmentOrderId(data: unknown): string | null {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const id = (data as { fulfillmentOrderId?: unknown }).fulfillmentOrderId;
    return typeof id === "string" ? id : null;
  }
  return null;
}

const HANDED_OVER_STATUSES = new Set(["handed_over", "in_transit", "delivered"]);
const LABELLED_STATUSES = new Set(["label_created", ...HANDED_OVER_STATUSES]);

// Must run before create/label. Multi-location orders are routed to a durable
// manual-review hold without leaving an orphan fulfillment row or label.
export async function preflightSplitShipmentGuard(
  client: OrderPaidFulfillmentSupabaseClient,
  input: { orderUuid: string; keyPrefix: string; metadataSource: string },
): Promise<{ ok: true } | OrderPaidFulfillmentResult> {
  const preflight = await client.rpc("commerce_fulfillment_preflight_split_shipment", {
    p_idempotency_key: `${input.keyPrefix}:${input.orderUuid}:${ORDER_PAID_DISPATCH_SPLIT_REVIEW_SUFFIX}`,
    p_order_id: input.orderUuid,
    p_metadata: { source: input.metadataSource },
  });
  if (preflight.error) {
    const classified = classifyError(preflight.error);
    return classified.retryable
      ? { kind: "retryable", reason: classified.reason }
      : { kind: "fatal", reason: classified.reason };
  }
  const data = preflight.data && typeof preflight.data === "object" && !Array.isArray(preflight.data)
    ? (preflight.data as { splitRequired?: unknown; locationCount?: unknown; holdId?: unknown })
    : null;
  if (data?.splitRequired === true) {
    return {
      kind: "manual_review",
      reason: "split_shipment_unsupported",
      detail: {
        locationCount: typeof data.locationCount === "number" ? data.locationCount : null,
        holdId: typeof data.holdId === "string" ? data.holdId : null,
      },
    };
  }
  return { ok: true };
}

export function createSupabaseOrderPaidFulfillmentPort(
  client: OrderPaidFulfillmentSupabaseClient,
): OrderPaidFulfillmentPort {
  return {
    async ensureFulfilledFromPaidOrder({ orderUuid, signal }): Promise<OrderPaidFulfillmentResult> {
      const key = (suffix: string): string => `${ORDER_PAID_DISPATCH_KEY_PREFIX}:${orderUuid}:${suffix}`;
      const abort = (): OrderPaidFulfillmentResult => ({ kind: "retryable", reason: "outbox_handler_timeout" });
      if (signal.aborted) return abort();

      const guard = await preflightSplitShipmentGuard(client, {
        orderUuid,
        keyPrefix: ORDER_PAID_DISPATCH_KEY_PREFIX,
        metadataSource: ORDER_PAID_DISPATCH_KEY_PREFIX,
      });
      if ("kind" in guard) return guard;
      if (signal.aborted) return abort();

      const create = await client.rpc("commerce_fulfillment_create_order", {
        p_idempotency_key: key("create"),
        p_order_id: orderUuid,
        p_actor_user_id: null,
        p_metadata: { source: ORDER_PAID_DISPATCH_KEY_PREFIX },
      });
      if (create.error) {
        const classified = classifyError(create.error);
        return classified.retryable
          ? { kind: "retryable", reason: classified.reason }
          : { kind: "fatal", reason: classified.reason };
      }
      const fulfillmentOrderId = readFulfillmentOrderId(create.data);
      if (!fulfillmentOrderId) return { kind: "fatal", reason: "fulfillment_create_missing_id" };
      let status = readStatus(create.data) ?? "created";
      if (signal.aborted) return abort();

      if (!LABELLED_STATUSES.has(status)) {
        const attempt = await client.rpc("commerce_fulfillment_record_provider_attempt", {
          p_idempotency_key: key("attempt"),
          p_fulfillment_order_id: fulfillmentOrderId,
          p_provider_kind: ORDER_PAID_DISPATCH_PROVIDER_KIND,
          p_status: "succeeded",
          p_request_payload: { source: ORDER_PAID_DISPATCH_KEY_PREFIX },
          p_response_payload: { simulated: true },
          p_error: null,
          p_actor_user_id: null,
          p_metadata: { source: ORDER_PAID_DISPATCH_KEY_PREFIX },
        });
        if (attempt.error) {
          const classified = classifyError(attempt.error);
          return classified.retryable
            ? { kind: "retryable", reason: classified.reason }
            : { kind: "fatal", reason: classified.reason };
        }
        if (signal.aborted) return abort();

        const label = await client.rpc("commerce_fulfillment_record_label_created", {
          p_idempotency_key: key("label"),
          p_fulfillment_order_id: fulfillmentOrderId,
          p_provider_kind: ORDER_PAID_DISPATCH_PROVIDER_KIND,
          p_provider_tracking_id: `${ORDER_PAID_DISPATCH_KEY_PREFIX}:${orderUuid}`,
          p_label_url: null,
          p_delivery_estimate_days: 2,
          p_raw_provider_payload: { simulated: true },
          p_actor_user_id: null,
          p_metadata: { source: ORDER_PAID_DISPATCH_KEY_PREFIX },
        });
        if (label.error) {
          const classified = classifyError(label.error);
          return classified.retryable
            ? { kind: "retryable", reason: classified.reason }
            : { kind: "fatal", reason: classified.reason };
        }
        status = readStatus(label.data) ?? "label_created";
        if (signal.aborted) return abort();
      }

      const handoff = await client.rpc("commerce_fulfillment_mark_handed_over", {
        p_idempotency_key: key("handoff"),
        p_fulfillment_order_id: fulfillmentOrderId,
        p_actor_user_id: null,
        p_metadata: { source: ORDER_PAID_DISPATCH_KEY_PREFIX },
      });
      if (handoff.error) {
        const classified = classifyError(handoff.error);
        return classified.retryable
          ? { kind: "retryable", reason: classified.reason }
          : { kind: "fatal", reason: classified.reason };
      }
      status = readStatus(handoff.data) ?? status;
      if (!HANDED_OVER_STATUSES.has(status)) {
        return { kind: "fatal", reason: truncate(`fulfillment_handoff_unexpected_status:${status}`) };
      }
      return { kind: "completed", detail: { fulfillmentOrderId, status } };
    },
  };
}
