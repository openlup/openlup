import {
  type OrderPaidFulfillmentPort,
  type OrderPaidFulfillmentResult,
} from "../../domains/commerce/outboxOrderPaidFulfillmentPorts.js";
import {
  preflightSplitShipmentGuard,
  type OrderPaidFulfillmentSupabaseClient,
} from "../supabase/orderPaidFulfillmentPort.js";

export const ORDER_PAID_OMNIPACK_DISPATCH_KEY_PREFIX = "order-paid-omnipack-dispatch";

const PROVIDER_KIND = "omnipack";
const MAX_REASON_LENGTH = 300;

interface OrderPaidRpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export interface OmnipackOrderPaidFulfillmentInput {
  client: OrderPaidFulfillmentSupabaseClient;
}

const FATAL_MARKER = /commerce_fulfillment_(?:invalid_input|order_not_found|order_not_fulfillable|missing_client|missing_shipping_address|shipping_address_not_found|payment_not_succeeded|active_hold|subscription_cycle_not_paid|missing_order_items|missing_catalog_sku|missing_inventory_reservation|not_found|label_invalid_status|handoff_requires_label|tracking_ref_conflict)/;
const FATAL_CODES = new Set(["22023", "23505", "23503", "23514", "22P02", "invalid_rpc_contract"]);
const RETRYABLE_CODE_PREFIXES = ["08", "40", "57", "53"];

// Canonical fulfillment statuses that already carry a provider label/handoff.
// A replayed order-paid event preserves that stronger local evidence.
const LABELLED_STATUSES = new Set(["label_created", "handed_over", "in_transit", "delivered"]);

export function createOmnipackOrderPaidFulfillmentPort(
  input: OmnipackOrderPaidFulfillmentInput,
): OrderPaidFulfillmentPort {
  return {
    async ensureFulfilledFromPaidOrder({ orderUuid, signal }): Promise<OrderPaidFulfillmentResult> {
      if (signal.aborted) return aborted();

      const guard = await preflightSplitShipmentGuard(input.client, {
        orderUuid,
        keyPrefix: ORDER_PAID_OMNIPACK_DISPATCH_KEY_PREFIX,
        metadataSource: ORDER_PAID_OMNIPACK_DISPATCH_KEY_PREFIX,
      });
      if ("kind" in guard) return guard;
      if (signal.aborted) return aborted();

      const create = await input.client.rpc("commerce_fulfillment_create_order", {
        p_idempotency_key: `${ORDER_PAID_OMNIPACK_DISPATCH_KEY_PREFIX}:${orderUuid}:create`,
        p_order_id: orderUuid,
        p_actor_user_id: null,
        p_metadata: {
          source: ORDER_PAID_OMNIPACK_DISPATCH_KEY_PREFIX,
          providerKind: PROVIDER_KIND,
          fulfillmentBoundary: "outbox-local-obligation",
        },
      });
      if (create.error) {
        const classified = classifyError(create.error);
        return classified.retryable
          ? { kind: "retryable", reason: classified.reason }
          : { kind: "fatal", reason: classified.reason };
      }

      const fulfillmentOrderId = readFulfillmentOrderId(create.data);
      if (!fulfillmentOrderId) return { kind: "retryable", reason: "omnipack_fulfillment_create_missing_id" };
      const createdStatus = readStatus(create.data) ?? "created";
      if (signal.aborted) return aborted();

      if (LABELLED_STATUSES.has(createdStatus)) {
        return {
          kind: "completed",
          detail: { fulfillmentOrderId, providerKind: PROVIDER_KIND, status: createdStatus, replayed: true },
        };
      }

      return {
        kind: "completed",
        detail: {
          fulfillmentOrderId,
          providerKind: PROVIDER_KIND,
          status: createdStatus,
          outcome: "local_fulfillment_obligation_recorded",
        },
      };
    },
  };
}

function aborted(): OrderPaidFulfillmentResult {
  return { kind: "retryable", reason: "outbox_handler_timeout" };
}

function readFulfillmentOrderId(data: unknown): string | null {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const id = (data as { fulfillmentOrderId?: unknown }).fulfillmentOrderId;
    return typeof id === "string" ? id : null;
  }
  return null;
}

function readStatus(data: unknown): string | null {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const status = (data as { status?: unknown }).status;
    return typeof status === "string" ? status : null;
  }
  return null;
}

function classifyError(error: OrderPaidRpcError): { retryable: boolean; reason: string } {
  const code = error.code ?? "";
  const text = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  if (RETRYABLE_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))) {
    return { retryable: true, reason: truncate(text || `sqlstate_${code}`) };
  }
  if (FATAL_CODES.has(code) || FATAL_MARKER.test(text)) {
    return { retryable: false, reason: truncate(text || `sqlstate_${code}` || "fulfillment_rejected") };
  }
  return { retryable: true, reason: truncate(text || `sqlstate_${code}` || "fulfillment_rpc_failed") };
}

function truncate(value: string): string {
  return value.length <= MAX_REASON_LENGTH ? value : `${value.slice(0, MAX_REASON_LENGTH)}...`;
}
