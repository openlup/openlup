import { z } from "zod";
import { commerceIdempotencyKeySchema } from "../contractPrimitives.js";

export const ORDER_DRAFT_RPC_NAME = "commerce_create_order_draft_with_outbox";

// Keep the emitted declaration in Zod's public types rather than expanding its
// internal mapped output, which cannot be checked by a strict installed consumer.
type OrderDraftRpcSchema<Quote extends z.ZodType, Draft extends z.ZodType> = z.ZodObject<{
  p_idempotency_key: z.ZodString;
  p_quote_snapshot: Quote;
  p_order_draft_snapshot: Draft;
  p_client_id: z.ZodOptional<z.ZodGUID>;
}, z.core.$strict>;

export function createOrderDraftRpcPayload<Quote extends z.ZodType, Draft extends z.ZodType>(input: {
  quoteSchema: Quote;
  draftSchema: Draft;
  createSnapshot(quote: z.output<Quote>): z.input<Draft>;
}) {
  const orderDraftRpcArgsSchema: OrderDraftRpcSchema<Quote, Draft> = z.object({
    p_idempotency_key: commerceIdempotencyKeySchema,
    p_quote_snapshot: input.quoteSchema,
    p_order_draft_snapshot: input.draftSchema,
    // Omit the optional client for anonymous calls, preserving the three-argument RPC.
    p_client_id: z.guid().optional(),
  }).strict();
  function createOrderDraftRpcArgs(
    request: { idempotencyKey: string; quoteSnapshot: z.output<Quote> },
    clientId: string | null = null,
  ): z.output<OrderDraftRpcSchema<Quote, Draft>> {
    const base = {
      p_idempotency_key: request.idempotencyKey,
      p_quote_snapshot: request.quoteSnapshot,
      p_order_draft_snapshot: input.createSnapshot(request.quoteSnapshot),
    };
    return orderDraftRpcArgsSchema.parse(clientId ? { ...base, p_client_id: clientId } : base);
  }
  return { orderDraftRpcArgsSchema, createOrderDraftRpcArgs };
}
