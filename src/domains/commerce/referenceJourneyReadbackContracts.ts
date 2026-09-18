import { z } from "../../lib/validation/zod.js";

export const REFERENCE_JOURNEY_ORDER_READBACK_CONTRACT_VERSION = "reference.order-readback.v1" as const;

const orderIdSchema = z.guid();
const listRequestSchema = z.object({ operation: z.literal("list"), limit: z.coerce.number().int().positive().max(100).default(20) }).strict();
const detailRequestSchema = z.object({ operation: z.literal("detail"), orderId: orderIdSchema }).strict();
const orderSchema = z.object({ orderId: orderIdSchema }).strict();

export const referenceJourneyOrderReadbackRequestSchema = z.discriminatedUnion("operation", [listRequestSchema, detailRequestSchema]);
export const referenceJourneyOrderReadbackListResponseSchema = z.object({ contractVersion: z.literal(REFERENCE_JOURNEY_ORDER_READBACK_CONTRACT_VERSION), orders: z.array(orderSchema) }).strict();
export const referenceJourneyOrderReadbackDetailResponseSchema = z.object({ contractVersion: z.literal(REFERENCE_JOURNEY_ORDER_READBACK_CONTRACT_VERSION), order: orderSchema }).strict();

export type ReferenceJourneyOrderReadbackRequest = z.infer<typeof referenceJourneyOrderReadbackRequestSchema>;
export type ReferenceJourneyOrderReadbackListResponse = z.infer<typeof referenceJourneyOrderReadbackListResponseSchema>;
export type ReferenceJourneyOrderReadbackDetailResponse = z.infer<typeof referenceJourneyOrderReadbackDetailResponseSchema>;
export type ReferenceJourneyOrderReadbackPort = {
  listCustomerOrders: (client: unknown, userId: string, limit: number) => Promise<{ orderId: string }[] | null>;
  getCustomerOrder: (client: unknown, userId: string, orderId: string) => Promise<{ orderId: string } | null>;
  listOperatorOrders: (client: unknown, limit: number) => Promise<Array<{ orderId: string; clientId: string | null }>>;
  getOperatorOrder: (client: unknown, orderId: string) => Promise<{ orderId: string; clientId: string | null } | null>;
};
