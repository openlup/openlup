// Provider-neutral Commerce Returns contracts and validation.

import { z } from "zod";

export const returnRequestLineSchema = z.object({
  orderItemId: z.guid(),
  sku: z.string().trim().min(1).max(120).optional(),
  quantity: z.number().int().positive(),
  restockDisposition: z.enum(["restock", "quarantine", "scrap"]).optional(),
});

export const returnRequestCreateSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  orderId: z.guid(),
  reasonCode: z.enum(["damaged", "wrong_item", "not_as_described", "pet_refused", "changed_mind", "other"]),
  lines: z.array(returnRequestLineSchema).min(1),
  customerNote: z.string().trim().max(2000).optional(),
});

export const returnApproveSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  returnRequestId: z.guid(),
  refundMode: z.enum(["full", "partial", "none"]).default("full"),
  refundAmountCents: z.number().int().nonnegative().optional(),
  adminNote: z.string().trim().max(2000).optional(),
});

export const returnRejectSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  returnRequestId: z.guid(),
  adminNote: z.string().trim().max(2000).optional(),
});

export type ReturnRequestCreateInput = z.infer<typeof returnRequestCreateSchema> & { requestedBy?: string | null };
export type ReturnApproveInput = z.infer<typeof returnApproveSchema> & { actorUserId?: string | null };
export type ReturnRejectInput = z.infer<typeof returnRejectSchema> & { actorUserId?: string | null };

export interface ReturnLifecycleResult {
  returnRequestId: string;
  status: string;
  replayed: boolean;
}

export interface CommerceReturnsPort {
  createRequest(input: ReturnRequestCreateInput): Promise<ReturnLifecycleResult>;
  approve(input: ReturnApproveInput): Promise<ReturnLifecycleResult>;
  reject(input: ReturnRejectInput): Promise<ReturnLifecycleResult>;
}
