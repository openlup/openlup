import {
  CommerceFulfillmentConflictError,
  CommerceFulfillmentPersistenceError,
  type ShipmentSpineMutationPort,
  type ShipmentSpineResult,
} from "../../../src/domains/fulfillment/commerceFulfillmentPorts.js";
import { resolveDeliverySelectionEvidence } from "../../../src/domains/shipping/contracts.js";
import type { OrderFulfillmentProviderKindReader } from "../../domains/commerce/routingOrderPaidFulfillmentPort.js";
import type { CommerceFulfillmentSupabaseClient, RpcError } from "./commerceFulfillmentPort.js";

interface OrderMetadataRow {
  metadata?: Record<string, unknown> | null;
}

interface SupabaseOrderMetadataClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): PromiseLike<{ data: OrderMetadataRow | null; error: unknown }>;
      };
    };
  };
}

// Mirrors the order-level sources in omnipackDispatchPort.readDeliverySelection
// (commerce_orders.metadata.selectedDelivery and metadata.runtimeFinalize.selectedDelivery).
export function createSupabaseOrderFulfillmentProviderKindReader(
  client: SupabaseOrderMetadataClient,
): OrderFulfillmentProviderKindReader {
  return {
    async readSelectedProviderKind(orderUuid: string): Promise<string | null> {
      const result = await client.from("commerce_orders").select("metadata").eq("id", orderUuid).maybeSingle();
      if (result.error) {
        throw result.error instanceof Error
          ? result.error
          : new Error(typeof result.error === "string" ? result.error : "order_metadata_read_failed");
      }
      return resolveDeliverySelectionEvidence({ orderMetadata: result.data?.metadata }).providerKind;
    },
  };
}

export interface SupabaseFulfillmentShipmentSpineOptions {
  providerKind: string;
}

export function createSupabaseFulfillmentShipmentSpinePort(
  client: CommerceFulfillmentSupabaseClient,
  options: SupabaseFulfillmentShipmentSpineOptions,
): ShipmentSpineMutationPort {
  const providerKind = options.providerKind.trim();
  if (!providerKind) throw new Error("fulfillment_shipment_spine_provider_kind_required");

  return {
    createShipment: (request) => callSpineMutation(client, "commerce_fulfillment_create_order", {
      p_idempotency_key: request.idempotencyKey,
      p_order_id: request.orderId,
      p_actor_user_id: null,
      p_metadata: request.metadata ?? {},
    }),
    recordLabel: (request) => callSpineMutation(client, "commerce_fulfillment_record_label_created", {
      p_idempotency_key: request.idempotencyKey,
      p_fulfillment_order_id: request.shipmentId,
      p_provider_kind: providerKind,
      p_provider_tracking_id: request.externalRef ?? null,
      p_label_url: null,
      p_delivery_estimate_days: null,
      p_raw_provider_payload: {},
      p_actor_user_id: null,
      p_metadata: request.metadata ?? {},
    }),
    handOff: (request) => callSpineMutation(client, "commerce_fulfillment_mark_handed_over", {
      p_idempotency_key: request.idempotencyKey,
      p_fulfillment_order_id: request.shipmentId,
      p_actor_user_id: null,
      p_metadata: request.metadata ?? {},
    }),
    recordTracking: (request) => callSpineMutation(client, "commerce_fulfillment_record_tracking_event", {
      p_idempotency_key: request.idempotencyKey,
      p_fulfillment_order_id: request.shipmentId,
      p_status: request.status,
      p_provider_tracking_id: request.externalRef ?? null,
      p_raw_event: request.requestedAt ? { occurredAt: request.requestedAt } : {},
      p_actor_user_id: null,
      p_metadata: request.metadata ?? {},
    }),
    cancel: (request) => callSpineMutation(client, "commerce_fulfillment_cancel_order", {
      p_idempotency_key: request.idempotencyKey,
      p_fulfillment_order_id: request.shipmentId,
      p_reason: request.reason,
      p_actor_user_id: null,
      p_metadata: request.metadata ?? {},
    }),
    async raiseException(request) {
      const before = await readShipmentState(client, request.shipmentId);
      const { data, error } = await client.rpc("commerce_fulfillment_record_provider_exception", {
        p_idempotency_key: request.idempotencyKey,
        p_order_id: before.orderId,
        p_reason: request.reason,
        p_metadata: { ...(request.metadata ?? {}), fulfillmentOrderId: request.shipmentId, providerKind },
      });
      if (error) throw mapSpineRpcError(error);
      const response = asRecord(data);
      if (response?.orderId !== before.orderId || typeof response.replayed !== "boolean") {
        throw new CommerceFulfillmentPersistenceError("Fulfillment shipment exception response invalid");
      }
      const after = await readShipmentState(client, request.shipmentId);
      return { ...after, replayed: response.replayed };
    },
  };
}

async function callSpineMutation(
  client: CommerceFulfillmentSupabaseClient,
  functionName: string,
  args: Record<string, unknown>,
): Promise<ShipmentSpineResult> {
  const { data, error } = await client.rpc(functionName, args);
  if (error) throw mapSpineRpcError(error);
  const response = asRecord(data);
  if (
    typeof response?.fulfillmentOrderId !== "string"
    || typeof response.orderId !== "string"
    || typeof response.status !== "string"
    || typeof response.replayed !== "boolean"
  ) throw new CommerceFulfillmentPersistenceError("Fulfillment shipment spine response invalid");
  return {
    shipmentId: response.fulfillmentOrderId,
    orderId: response.orderId,
    status: response.status,
    replayed: response.replayed,
  };
}

async function readShipmentState(
  client: CommerceFulfillmentSupabaseClient,
  shipmentId: string,
): Promise<Omit<ShipmentSpineResult, "replayed">> {
  const { data, error } = await client.from("commerce_fulfillment_orders")
    .select("id, order_id, status").eq("id", shipmentId).maybeSingle();
  if (error) throw mapSpineRpcError(error);
  const row = asRecord(data);
  if (typeof row?.id !== "string" || typeof row.order_id !== "string" || typeof row.status !== "string") {
    throw new CommerceFulfillmentConflictError("Fulfillment shipment not found");
  }
  return { shipmentId: row.id, orderId: row.order_id, status: row.status };
}

function mapSpineRpcError(error: RpcError): Error {
  const text = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  if (error.code === "23505" || /commerce_fulfillment_.*(?:active_hold|after_handoff|conflict|forbidden|invalid|missing|not_active|not_fulfillable|not_found|not_succeeded|requires|subscription)/.test(text)) {
    return new CommerceFulfillmentConflictError("Commerce fulfillment mutation conflict", {
      code: error.code,
      reason: text.includes("order_not_fulfillable") ? "order_not_fulfillable" : "fulfillment_conflict",
    });
  }
  return new CommerceFulfillmentPersistenceError("Commerce fulfillment RPC failed", { code: error.code });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
