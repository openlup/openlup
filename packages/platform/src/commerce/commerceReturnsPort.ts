// Provider-neutral Commerce Returns contracts and validation.

import { z } from "zod";

/** Returns request/approve/reject only. Restock and refund fields record intent; no receive, restock or refund execution. */
export const returnRequestLineSchema = z.object({
  orderItemId: z.guid(),
  sku: z.string().trim().min(1).max(120).optional(),
  quantity: z.number().int().positive(),
  restockDisposition: z.enum(["restock", "quarantine", "scrap"]).optional(),
});

/** Bind host reason codes for request/approve/reject only; restock/refund fields record intent, without execution. */
export function createCommerceReturnsSchemas<const Reasons extends readonly [string, ...string[]]>(reasonCodes: Reasons) {
  return {
    returnRequestCreateSchema: z.object({
      idempotencyKey: z.string().trim().min(8).max(200),
      orderId: z.guid(),
      reasonCode: z.enum(reasonCodes),
      lines: z.array(returnRequestLineSchema).min(1),
      customerNote: z.string().trim().max(2000).optional(),
    }),
  };
}

/** Neutral default reasons for request/approve/reject only; restock/refund fields record intent, without execution. */
export const { returnRequestCreateSchema } = createCommerceReturnsSchemas([
  "damaged", "wrong_item", "not_as_described", "changed_mind", "other",
]);

/** Returns request/approve/reject only. Restock and refund fields record intent; no receive, restock or refund execution. */
export const returnApproveSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  returnRequestId: z.guid(),
  refundMode: z.enum(["full", "partial", "none"]).default("full"),
  refundAmountCents: z.number().int().nonnegative().optional(),
  adminNote: z.string().trim().max(2000).optional(),
});

/** Returns request/approve/reject only. Restock and refund fields record intent; no receive, restock or refund execution. */
export const returnRejectSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  returnRequestId: z.guid(),
  adminNote: z.string().trim().max(2000).optional(),
});

/** Returns request/approve/reject only. Restock and refund fields record intent; no receive, restock or refund execution. */
export type ReturnRequestCreateInput<Reason extends string = z.infer<typeof returnRequestCreateSchema>["reasonCode"]> =
  Omit<z.infer<typeof returnRequestCreateSchema>, "reasonCode"> & { reasonCode: Reason; requestedBy?: string | null };
/** Returns request/approve/reject only. Restock and refund fields record intent; no receive, restock or refund execution. */
export type ReturnApproveInput = z.infer<typeof returnApproveSchema> & { actorUserId?: string | null };
/** Returns request/approve/reject only. Restock and refund fields record intent; no receive, restock or refund execution. */
export type ReturnRejectInput = z.infer<typeof returnRejectSchema> & { actorUserId?: string | null };

/** Returns request/approve/reject only. Restock and refund fields record intent; no receive, restock or refund execution. */
export interface ReturnLifecycleResult {
  returnRequestId: string;
  status: string;
  replayed: boolean;
}

/** Returns request/approve/reject only. Restock and refund fields record intent; no receive, restock or refund execution. */
export interface CommerceReturnsPort<Reason extends string = ReturnRequestCreateInput["reasonCode"]> {
  createRequest(input: ReturnRequestCreateInput<Reason>): Promise<ReturnLifecycleResult>;
  approve(input: ReturnApproveInput): Promise<ReturnLifecycleResult>;
  reject(input: ReturnRejectInput): Promise<ReturnLifecycleResult>;
}
