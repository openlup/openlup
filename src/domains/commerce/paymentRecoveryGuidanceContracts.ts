import { PAYMENT_RECOVERY_ACTIONS, PAYMENT_RECOVERY_CAUSES } from "@openlup/core/payment";
import { z } from "../../lib/validation/zod.js";
import { paymentStatusResponseSchema } from "./checkoutContracts.js";

export const PAYMENT_RECOVERY_GUIDANCE_HEADER = "X-Payment-Recovery-Guidance";
const methodKey = z.string().regex(/^[a-zA-Z0-9_:.-]{1,96}$/).nullable();
export const paymentRecoveryGuidanceSchema = z.object({
  version: z.literal(1),
  paymentAttemptId: z.uuid(),
  purchaseContext: z.enum(["one_time", "subscription_initial"]),
  cause: z.enum(PAYMENT_RECOVERY_CAUSES),
  methodKind: methodKey,
  methodKey,
  operation: z.enum(["one_time_payment", "recurring_setup", "stored_method_payment"]).nullable(),
  restriction: z.enum(["instrument", "method", "operation"]).nullable(),
  actions: z.array(z.enum(PAYMENT_RECOVERY_ACTIONS)),
  consecutiveRefusals: z.union([z.literal(0), z.literal(1), z.literal(2)]).nullable(),
  emphasis: z.enum(["normal", "recommended"]),
}).strict();
export type CheckoutPaymentRecoveryGuidance = z.infer<typeof paymentRecoveryGuidanceSchema>;

/** Strip only the known optional extension on incompatibility; base stays strict. */
export const paymentRecoveryStatusResponseSchema = z.preprocess((input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const data = input as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(data, "recoveryGuidance") || data.recoveryGuidance === null) return input;
  return paymentRecoveryGuidanceSchema.safeParse(data.recoveryGuidance).success
    ? input : { ...data, recoveryGuidance: null };
}, paymentStatusResponseSchema.extend({ recoveryGuidance: paymentRecoveryGuidanceSchema.nullable().optional() }).strict());
export type PaymentRecoveryStatusResponse = z.infer<typeof paymentRecoveryStatusResponseSchema>;
