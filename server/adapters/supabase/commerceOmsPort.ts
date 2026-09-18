import type {
  AdminCommerceOrderDetailRequest,
  AdminCommerceOrderDetailResponse,
  AdminCommerceOrderHoldRequest,
  AdminCommerceOrderHoldResponse,
  AdminCommerceOrderMarkRefundedRequest,
  AdminCommerceOrderMarkRefundedResponse,
  AdminCommerceOrderCancelRequest,
  AdminCommerceOrderNoteRequest,
  AdminCommerceOrderNoteResponse,
  AdminCommerceOrderReleaseHoldRequest,
  AdminCommerceOrderRequestReplacementShipmentRequest,
  AdminCommerceOrderRequestReplacementShipmentResponse,
  AdminCommerceOrderUpdateShippingAddressRequest,
  AdminCommerceOrderUpdateShippingAddressResponse,
  AdminCommerceOrdersListRequest,
  AdminCommerceOrdersListResponse,
} from "../../../src/domains/commerce/omsContracts.js";
import {
  CommerceOmsConflictError,
  CommerceOmsPersistenceError,
  type CommerceOmsHoldPort,
  type CommerceOmsReadPort,
  readOmsReplacementRefusal,
} from "../../../src/domains/commerce/omsPorts.js";
import type { OmsActionAvailabilityFlags } from "../../../src/domains/commerce/omsReadModelHelpers.js";
import {
  addCommerceOmsNote,
  callOmsRpc,
  updateCommerceOmsShippingAddress,
} from "./commerceOmsMutations.js";
import {
  getCommerceOmsOrderDetail,
  listCommerceOmsOrders,
} from "./commerce/oms/readQueries.js";
import type { CommerceOmsSupabaseClient, RpcError } from "./commerce/oms/types.js";

export type { CommerceOmsSupabaseClient } from "./commerce/oms/types.js";

export function createSupabaseCommerceOmsPort(
  client: CommerceOmsSupabaseClient,
  options: { actionFlags?: OmsActionAvailabilityFlags } = {},
): CommerceOmsReadPort & CommerceOmsHoldPort {
  return {
    listOrders(request: AdminCommerceOrdersListRequest): Promise<AdminCommerceOrdersListResponse> {
      return listCommerceOmsOrders(client, request);
    },

    getOrderDetail(request: AdminCommerceOrderDetailRequest): Promise<AdminCommerceOrderDetailResponse | null> {
      return getCommerceOmsOrderDetail(client, request, options);
    },

    async createHold(request: AdminCommerceOrderHoldRequest & { actorUserId: string }): Promise<AdminCommerceOrderHoldResponse> {
      return callOmsRpc<AdminCommerceOrderHoldResponse>(client, "commerce_oms_create_hold", {
        p_idempotency_key: request.idempotencyKey,
        p_order_id: request.orderId,
        p_reason: request.reason,
        p_note: request.note ?? null,
        p_actor_user_id: request.actorUserId,
        p_metadata: request.metadata ?? {},
      });
    },

    async releaseHold(request: AdminCommerceOrderReleaseHoldRequest & { actorUserId: string }): Promise<AdminCommerceOrderHoldResponse> {
      return callOmsRpc<AdminCommerceOrderHoldResponse>(client, "commerce_oms_release_hold", {
        p_idempotency_key: request.idempotencyKey,
        p_hold_id: request.holdId,
        p_note: request.note ?? null,
        p_actor_user_id: request.actorUserId,
        p_metadata: request.metadata ?? {},
      });
    },

    addNote(request: AdminCommerceOrderNoteRequest & { actorUserId: string }): Promise<AdminCommerceOrderNoteResponse> {
      return addCommerceOmsNote(client, request);
    },

    updateShippingAddress(
      request: AdminCommerceOrderUpdateShippingAddressRequest & { actorUserId: string },
    ): Promise<AdminCommerceOrderUpdateShippingAddressResponse> {
      return updateCommerceOmsShippingAddress(client, request);
    },

    async markRefunded(
      request: AdminCommerceOrderMarkRefundedRequest & { actorUserId: string },
    ): Promise<AdminCommerceOrderMarkRefundedResponse> {
      return callOmsRpc<AdminCommerceOrderMarkRefundedResponse>(client, "commerce_order_mark_refunded_manual", {
        p_idempotency_key: request.idempotencyKey,
        p_order_id: request.orderId,
        p_reason: request.reason,
        p_actor_user_id: request.actorUserId,
        p_metadata: request.metadata ?? {},
      });
    },

    async requestReplacementShipment(
      request: AdminCommerceOrderRequestReplacementShipmentRequest & { actorUserId: string },
    ): Promise<AdminCommerceOrderRequestReplacementShipmentResponse> {
      // Deliberately not `callOmsRpc`: that helper classifies through the shared
      // `mapRpcError`, whose catch-all would collapse thirteen distinct refusals
      // into one anonymous "hold conflict". This command's whole operator value is
      // being told *which* refusal it hit, so the raw error is read here.
      const { data, error } = await client.rpc("commerce_oms_request_replacement_shipment", {
        p_idempotency_key: request.idempotencyKey,
        p_order_id: request.orderId,
        p_reason: request.reason,
        p_actor_user_id: request.actorUserId,
        p_metadata: request.metadata ?? {},
      });
      if (error) throw mapReplacementRefusal(error);
      return data as AdminCommerceOrderRequestReplacementShipmentResponse;
    },

    async cancelOrder(
      request: AdminCommerceOrderCancelRequest & { actorUserId: string },
    ): Promise<AdminCommerceOrderMarkRefundedResponse> {
      return callOmsRpc<AdminCommerceOrderMarkRefundedResponse>(client, "commerce_oms_cancel_unpaid_order", {
        p_idempotency_key: request.idempotencyKey,
        p_order_id: request.orderId,
        p_reason: request.reason,
        p_actor_user_id: request.actorUserId,
        p_metadata: request.metadata ?? {},
      });
    },
  };
}

/**
 * Two outcomes, and the split is the honest one. An error naming a refusal this command can
 * reach - its own `commerce_oms_replacement_*` names, or the reservation vocabulary raised
 * through `inventory_reserve_order` while it mints the replacement's stock generation - is
 * something the operator caused and can answer: it becomes a conflict carrying only the
 * stable reason, not the SQLSTATE and not the message, because that reason is the single
 * field the operator surface renders from. Anything else never reached a refusal at all
 * (transport, permissions, a dead connection) and stays an upstream failure keyed by
 * SQLSTATE, which is diagnostic and never shown as a refusal.
 *
 * The reservation half is the one this wave added, and it is the most likely legitimate
 * refusal in production: the command reserves through an external stock authority, so a
 * stockout arrives as `inventory_external_provider_insufficient_available_stock`. It carries
 * no `commerce_oms_replacement_` prefix, matched nothing, and the operator was told to check
 * holds that were not there. The vocabulary itself lives in
 * `src/domains/commerce/omsPorts.ts` so the surface renders from the same list.
 */
export function mapReplacementRefusal(error: RpcError): Error {
  const reason = readOmsReplacementRefusal(
    [error.message, error.details, error.hint].filter(Boolean).join(" "),
  );
  if (!reason) {
    return new CommerceOmsPersistenceError("Commerce OMS replacement request failed", { code: error.code });
  }
  return new CommerceOmsConflictError("Commerce OMS replacement request refused", { reason });
}
