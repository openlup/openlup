import type {
  AdminCommerceFulfillmentCancelRequest,
  AdminCommerceFulfillmentCreateRequest,
  AdminCommerceFulfillmentHandOffRequest,
  AdminCommerceFulfillmentMutationResponse,
  AdminCommerceFulfillmentRecordLabelRequest,
  AdminCommerceFulfillmentRecordProviderAttemptRequest,
  AdminCommerceFulfillmentTrackingEventRequest,
} from "../../../src/domains/fulfillment/commerceFulfillmentContracts.js";
import {
  CommerceFulfillmentConflictError,
  CommerceFulfillmentPersistenceError,
  type CommerceFulfillmentMutationPort,
} from "../../../src/domains/fulfillment/commerceFulfillmentPorts.js";
import type { CommerceFulfillmentSupabaseClient, RpcError } from "./commerceFulfillmentPort.js";

export function createSupabaseCommerceFulfillmentMutationPort(
  client: CommerceFulfillmentSupabaseClient,
): CommerceFulfillmentMutationPort {
  return {
    async createCommerceFulfillmentOrder(
      request: AdminCommerceFulfillmentCreateRequest & { actorUserId: string },
    ): Promise<AdminCommerceFulfillmentMutationResponse> {
      return callMutation(client, "commerce_fulfillment_create_order", {
        p_idempotency_key: request.idempotencyKey,
        p_order_id: request.orderId,
        p_actor_user_id: request.actorUserId,
        p_metadata: request.metadata ?? {},
      });
    },

    async recordCommerceFulfillmentProviderAttempt(
      request: AdminCommerceFulfillmentRecordProviderAttemptRequest & { actorUserId: string },
    ): Promise<AdminCommerceFulfillmentMutationResponse> {
      return callMutation(client, "commerce_fulfillment_record_provider_attempt", {
        p_idempotency_key: request.idempotencyKey,
        p_fulfillment_order_id: request.fulfillmentOrderId,
        p_provider_kind: request.providerKind,
        p_status: request.status,
        p_request_payload: request.requestPayload,
        p_response_payload: request.responsePayload,
        p_error: request.error ?? null,
        p_actor_user_id: request.actorUserId,
        p_metadata: request.metadata ?? {},
      });
    },

    async recordCommerceFulfillmentLabel(
      request: AdminCommerceFulfillmentRecordLabelRequest & { actorUserId: string },
    ): Promise<AdminCommerceFulfillmentMutationResponse> {
      return callMutation(client, "commerce_fulfillment_record_label_created", {
        p_idempotency_key: request.idempotencyKey,
        p_fulfillment_order_id: request.fulfillmentOrderId,
        p_provider_kind: request.providerKind,
        p_provider_tracking_id: request.providerTrackingId,
        p_label_url: request.labelUrl ?? null,
        p_delivery_estimate_days: request.deliveryEstimateDays ?? null,
        p_raw_provider_payload: request.rawProviderPayload,
        p_actor_user_id: request.actorUserId,
        p_metadata: request.metadata ?? {},
      });
    },

    async handOffCommerceFulfillmentOrder(
      request: AdminCommerceFulfillmentHandOffRequest & { actorUserId: string },
    ): Promise<AdminCommerceFulfillmentMutationResponse> {
      return callMutation(client, "commerce_fulfillment_mark_handed_over", {
        p_idempotency_key: request.idempotencyKey,
        p_fulfillment_order_id: request.fulfillmentOrderId,
        p_actor_user_id: request.actorUserId,
        p_metadata: request.metadata ?? {},
      });
    },

    async recordCommerceFulfillmentTrackingEvent(
      request: AdminCommerceFulfillmentTrackingEventRequest & { actorUserId: string },
    ): Promise<AdminCommerceFulfillmentMutationResponse> {
      return callMutation(client, "commerce_fulfillment_record_tracking_event", {
        p_idempotency_key: request.idempotencyKey,
        p_fulfillment_order_id: request.fulfillmentOrderId,
        p_status: request.status,
        p_provider_tracking_id: request.providerTrackingId ?? null,
        p_raw_event: request.rawEvent,
        p_actor_user_id: request.actorUserId,
        p_metadata: request.metadata ?? {},
      });
    },

    async cancelCommerceFulfillmentOrder(
      request: AdminCommerceFulfillmentCancelRequest & { actorUserId: string },
    ): Promise<AdminCommerceFulfillmentMutationResponse> {
      return callMutation(client, "commerce_fulfillment_cancel_order", {
        p_idempotency_key: request.idempotencyKey,
        p_fulfillment_order_id: request.fulfillmentOrderId,
        p_reason: request.reason,
        p_actor_user_id: request.actorUserId,
        p_metadata: request.metadata ?? {},
      });
    },
  };
}

async function callMutation(
  client: CommerceFulfillmentSupabaseClient,
  functionName: string,
  args: Record<string, unknown>,
): Promise<AdminCommerceFulfillmentMutationResponse> {
  const { data, error } = await client.rpc(functionName, args);
  if (error) throw mapRpcError(error);
  return data as AdminCommerceFulfillmentMutationResponse;
}

function mapRpcError(error: RpcError): Error {
  const text = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  if (
    error.code === "23505" ||
    /commerce_fulfillment_.*(?:active_hold|after_handoff|conflict|forbidden|invalid|missing|not_active|not_fulfillable|not_found|not_succeeded|requires|subscription)/.test(
      text,
    )
  ) {
    return new CommerceFulfillmentConflictError("Commerce fulfillment mutation conflict", { code: error.code });
  }
  return new CommerceFulfillmentPersistenceError("Commerce fulfillment RPC failed", { code: error.code });
}
