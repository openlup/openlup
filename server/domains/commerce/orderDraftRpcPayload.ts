import { z } from "zod";
import {
  commerceIdempotencyKeySchema,
  createQuoteResponseSchema,
  type CreateOrderDraftRequest,
} from "../../../src/domains/commerce/contracts.js";
import {
  createOrderDraftSnapshotFromQuoteSnapshot,
  ORDER_DRAFT_SNAPSHOT_SOURCE,
  orderDraftSnapshotSchema,
} from "../../../src/domains/commerce/orderDraftSnapshotContracts.js";

export const ORDER_DRAFT_RPC_NAME = "commerce_create_order_draft_with_outbox";
export { ORDER_DRAFT_SNAPSHOT_SOURCE };

export const orderDraftRpcArgsSchema = z
  .object({
    p_idempotency_key: commerceIdempotencyKeySchema,
    p_quote_snapshot: createQuoteResponseSchema,
    p_order_draft_snapshot: orderDraftSnapshotSchema,
    // Persisted onto commerce_orders.client_id so the outbox dispatcher can
    // resolve a recipient. OMITTED for the anonymous standalone route (the
    // producer RPC defaults it NULL); the saga passes the provisioned client.
    // Omitting (rather than sending null) keeps the anonymous call a 3-arg
    // PostgREST call that resolves both before AND after the client_id migration
    // applies — no PGRST202 window on a code-ahead-of-schema deploy.
    p_client_id: z.guid().optional(),
  })
  .strict();

export type OrderDraftRpcArgs = z.infer<typeof orderDraftRpcArgsSchema>;

// clientId is passed OUT-OF-BAND by the caller (never from the request body):
// the saga supplies provisioned.clientId; the standalone route supplies nothing.
export function createOrderDraftRpcArgs(
  request: CreateOrderDraftRequest,
  clientId: string | null = null,
): OrderDraftRpcArgs {
  const base = {
    p_idempotency_key: request.idempotencyKey,
    p_quote_snapshot: request.quoteSnapshot,
    p_order_draft_snapshot: createOrderDraftSnapshotFromQuoteSnapshot(
      request.quoteSnapshot,
    ),
  };
  return orderDraftRpcArgsSchema.parse(
    clientId ? { ...base, p_client_id: clientId } : base,
  );
}
