import { z } from "../../lib/validation/zod.js";
import { orderStatusSchema } from "./contracts.js";
import { actionEligibilitySchema as eligibilitySchema, datetimeSchema, omsFulfillmentStatusSchema, omsHoldReasonSchema, omsHoldStatusSchema, uuidSchema } from "./omsContractBase.js";

export const OMS_CONTROL_PLANE_VERSION = "commerce.oms_control_plane.v1" as const;
export const OMS_CONTROL_PLANE_VIEW = "control_plane_v1" as const;

const moneySchema = z.object({ amountMinor: z.number().int().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();

export const omsControlPlaneListRequestSchema = z.object({
  view: z.literal(OMS_CONTROL_PLANE_VIEW),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: orderStatusSchema.optional(),
}).strict();

export const omsControlPlaneDetailRequestSchema = z.object({
  view: z.literal(OMS_CONTROL_PLANE_VIEW),
  orderId: uuidSchema,
}).strict();

export const omsControlPlaneHoldSchema = z.object({
  id: uuidSchema,
  status: omsHoldStatusSchema,
  reason: omsHoldReasonSchema,
  note: z.string().nullable(),
  createdAt: datetimeSchema,
  releasedAt: datetimeSchema.nullable(),
}).strict();

export const omsControlPlaneOperationSchema = z.object({
  id: uuidSchema,
  action: z.enum(["hold_created", "hold_released", "order_cancelled", "order_refunded"]),
  holdId: uuidSchema.nullable(),
  actorId: uuidSchema.nullable(),
  occurredAt: datetimeSchema,
}).strict();

const actionsSchema = z.object({
  createHold: eligibilitySchema,
  releaseHold: eligibilitySchema,
  cancelOrder: eligibilitySchema,
  markRefunded: eligibilitySchema,
}).strict();

export const omsControlPlaneOrderSchema = z.object({
  orderId: uuidSchema,
  status: orderStatusSchema,
  sourceKind: z.string().min(1).max(32),
  sourceOrderRef: z.string().min(1).max(128).nullable(),
  money: moneySchema.nullable(),
  shipmentStatus: omsFulfillmentStatusSchema.nullable(),
  activeHoldCount: z.number().int().nonnegative(),
  activeHoldReasons: z.array(omsHoldReasonSchema),
  actions: actionsSchema,
  createdAt: datetimeSchema,
  updatedAt: datetimeSchema,
}).strict();

export const omsControlPlaneListResponseSchema = z.object({
  contractVersion: z.literal(OMS_CONTROL_PLANE_VERSION),
  orders: z.array(omsControlPlaneOrderSchema),
  totalCount: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
}).strict();

export const omsControlPlaneDetailResponseSchema = z.object({
  contractVersion: z.literal(OMS_CONTROL_PLANE_VERSION),
  order: omsControlPlaneOrderSchema,
  holds: z.array(omsControlPlaneHoldSchema),
  operations: z.array(omsControlPlaneOperationSchema),
}).strict();

export type OmsControlPlaneListRequest = z.infer<typeof omsControlPlaneListRequestSchema>;
export type OmsControlPlaneDetailRequest = z.infer<typeof omsControlPlaneDetailRequestSchema>;
export type OmsControlPlaneOrder = z.infer<typeof omsControlPlaneOrderSchema>;
export type OmsControlPlaneListResponse = z.infer<typeof omsControlPlaneListResponseSchema>;
export type OmsControlPlaneDetailResponse = z.infer<typeof omsControlPlaneDetailResponseSchema>;

export interface CommerceOmsControlPlanePort {
  listOrders(request: OmsControlPlaneListRequest): Promise<OmsControlPlaneListResponse>;
  getOrderDetail(request: OmsControlPlaneDetailRequest): Promise<OmsControlPlaneDetailResponse | null>;
}

export interface CommerceOmsOperatorResolver {
  resolveOperator(principalId: string): Promise<string | null>;
}

export function omsControlPlaneActions(status: OmsControlPlaneOrder["status"], activeHoldCount: number): OmsControlPlaneOrder["actions"] {
  const terminal = status === "cancelled" || status === "refunded";
  return {
    createHold: { allowed: !terminal, reason: terminal ? "order_terminal" : null },
    releaseHold: { allowed: activeHoldCount > 0, reason: activeHoldCount > 0 ? null : "no_active_hold" },
    cancelOrder: { allowed: status === "pending_payment", reason: status === "pending_payment" ? null : "payment_state_ineligible" },
    markRefunded: { allowed: status === "paid", reason: status === "paid" ? null : "payment_state_ineligible" },
  };
}
