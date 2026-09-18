import type {
  AdminCommerceOrderNoteRequest,
  AdminCommerceOrderNoteResponse,
  AdminCommerceOrderUpdateShippingAddressRequest,
  AdminCommerceOrderUpdateShippingAddressResponse,
} from "../../../src/domains/commerce/omsContracts.js";
import {
  CommerceOmsConflictError,
  CommerceOmsPersistenceError,
} from "../../../src/domains/commerce/omsPorts.js";
import type { OmsOperationRow } from "../../../src/domains/commerce/omsReadModel.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import type { CommerceOmsClient, CommerceOmsSupabaseClient, RpcError } from "./commerce/oms/types.js";

const OPERATION_COLUMNS = "id, order_id, operation_type, hold_id, actor_user_id, occurred_at, payload";

export async function addCommerceOmsNote(
  client: CommerceOmsSupabaseClient,
  request: AdminCommerceOrderNoteRequest & { actorUserId: string },
): Promise<AdminCommerceOrderNoteResponse> {
  const insertResult = await client
    .from("commerce_order_operations")
    .insert({
      order_id: request.orderId,
      actor_user_id: request.actorUserId,
      operation_type: "support_note",
      idempotency_key: request.idempotencyKey,
      payload: { note: request.note, metadata: request.metadata ?? {}, source: "commerce.oms.v0" },
    })
    .select(OPERATION_COLUMNS)
    .maybeSingle();

  if (insertResult.error) {
    if (insertResult.error.code === "23505") {
      const replayResult = await client
        .from("commerce_order_operations")
        .select(OPERATION_COLUMNS)
        .eq("idempotency_key", request.idempotencyKey)
        .maybeSingle();
      if (replayResult.error || !replayResult.data) throw mapRpcError(insertResult.error);
      return noteResponse(replayResult.data as OmsOperationRow, true);
    }
    throw mapRpcError(insertResult.error);
  }
  return noteResponse(insertResult.data as OmsOperationRow, false);
}

export async function updateCommerceOmsShippingAddress(
  client: CommerceOmsSupabaseClient,
  request: AdminCommerceOrderUpdateShippingAddressRequest & { actorUserId: string },
): Promise<AdminCommerceOrderUpdateShippingAddressResponse> {
  return callOmsRpc<AdminCommerceOrderUpdateShippingAddressResponse>(client, "commerce_oms_update_shipping_address", {
    p_idempotency_key: request.idempotencyKey,
    p_order_id: request.orderId,
    p_address: request.address,
    p_actor_user_id: request.actorUserId,
    p_metadata: {
      ...(request.metadata ?? {}),
      _deliveryContactExpectedRevision: request.expectedRevision,
      _deliveryContactExpectedDigest: request.expectedContactDigest,
    },
  });
}

// Every OMS control RPC answers the same way: the function's own jsonb response,
// or a Postgres error this module already knows how to classify. The cast is not
// a validation step and never was - it is recorded here once instead of at each
// call site, so tightening it later is one edit.
export async function callOmsRpc<T>(
  client: CommerceOmsClient,
  functionName: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await client.rpc(functionName, args);
  if (error) throw mapRpcError(error);
  return data as T;
}

/**
 * SQLSTATE 55P03. A routine here gave up waiting for a lock another writer holds
 * and returned before touching anything - not a failure, a refusal, and the same
 * request may be sent again unchanged.
 *
 * It is read from the code rather than the message because the server's text for
 * it ("canceling statement due to lock timeout") names no routine of ours, so
 * there is nothing for `readShippingAddressReason` to match on. The reason stays
 * routine-neutral for the same span the mapper covers: today only the shipping
 * address correction bounds its waits, but this classification is true of any OMS
 * routine that later does, and a `delivery_contact_` prefix would be a lie the
 * day one of the hold routines raises it.
 */
const LOCK_TIMEOUT_SQLSTATE = "55P03";

export function mapRpcError(error: RpcError): Error {
  const text = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  if (error.code === LOCK_TIMEOUT_SQLSTATE) {
    return new CommerceOmsConflictError("Commerce OMS request could not take its locks", {
      code: error.code,
      reason: "lock_timeout",
    });
  }
  const shippingAddressReason = readShippingAddressReason(text);
  if (shippingAddressReason) {
    return new CommerceOmsConflictError("Commerce OMS shipping address update blocked", {
      code: error.code,
      reason: shippingAddressReason,
    });
  }
  if (
    error.code === "23505" ||
    /(?:commerce_oms_|commerce_order_).*(?:conflict|already|not_found|invalid_status)/.test(text)
  ) {
    return new CommerceOmsConflictError("Commerce OMS hold conflict", { code: error.code });
  }
  return new CommerceOmsPersistenceError("Commerce OMS RPC failed", { code: error.code });
}

function noteResponse(operation: OmsOperationRow, replayed: boolean): AdminCommerceOrderNoteResponse {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    operation: operationResponse(operation),
    replayed,
  };
}

function operationResponse(operation: OmsOperationRow): AdminCommerceOrderNoteResponse["operation"] {
  return {
    id: operation.id,
    orderId: operation.order_id,
    type: operation.operation_type,
    holdId: operation.hold_id,
    actorUserId: operation.actor_user_id,
    occurredAt: operation.occurred_at,
    payload: operation.payload,
  };
}

function readShippingAddressReason(text: string): string | null {
  if (text.includes("commerce_oms_delivery_contact_stale_revision")) return "delivery_contact_stale_revision";
  if (text.includes("commerce_oms_delivery_contact_submission_started")) return "delivery_contact_submission_started";
  if (text.includes("commerce_oms_shipping_address_missing_shipping_address")) return "missing_shipping_address";
  if (text.includes("commerce_oms_shipping_address_locked_after_label")) return "address_locked_after_label";
  if (text.includes("commerce_oms_shipping_address_idempotency_conflict")) return "idempotency_conflict";
  return null;
}
