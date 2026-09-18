import { PAYMENT_FAILURE_CUSTOMER_CAUSES } from "@openlup/core/payment";

import { z } from "../../lib/validation/zod.js";

const uuidSchema = z.guid();
const datetimeSchema = z.string().datetime({ offset: true });
const messageCodeSchema = z.enum([
  "payment_blocked",
  // The dunning journey ended without collecting: every retry was spent, the
  // case is terminal and the subscription is paused. Distinct from
  // `payment_blocked` (a case still retrying) and from `payment_failed` (a cycle
  // that failed with no case) because the customer's next step differs: nothing
  // will retry, so resuming skips the unpaid cycle and starts a new one.
  "payment_expired",
  "missing_payment_method",
  "payment_failed",
  "payment_requires_action",
  "subscription_edit_blocked",
  "invoice_pdf_unavailable",
  "subscription_activation_missing_mandate",
]);

export const customerAccountActionRequiredSchema = z
  .object({
    actionId: z.string().min(1).max(180),
    kind: z.enum([
      "payment_recovery",
      "payment_method_missing",
      "subscription_blocked",
      "order_attention",
      "invoice_attention",
    ]),
    severity: z.enum(["info", "warning", "critical"]),
    entityType: z.enum(["subscription", "order", "invoice", "account"]),
    entityId: uuidSchema.nullable(),
    subscriptionId: uuidSchema.nullable(),
    orderId: uuidSchema.nullable(),
    messageCode: messageCodeSchema,
    blockedReason: messageCodeSchema.nullable(),
    title: z.string().min(1).max(160),
    body: z.string().max(360).nullable(),
    cta: z.enum(["repair_payment", "view_subscription", "view_order", "contact_support"]).nullable(),
    /**
     * Why the payment failed, in the payer-facing vocabulary — a CODE, never a
     * sentence. The browser renders it from the same table the emails render, so
     * the mail and the page cannot describe one problem two ways. `unknown` (and
     * every case whose class predates classification) renders nothing at all.
     */
    failureCause: z.enum(PAYMENT_FAILURE_CUSTOMER_CAUSES),
    recoveryEligible: z.boolean(),
    dueAt: datetimeSchema.nullable(),
    nextRetryAt: datetimeSchema.nullable(),
  })
  .strict();

export type CustomerAccountActionRequired = z.infer<typeof customerAccountActionRequiredSchema>;

export function hasPaidSubscriptionActivationGap(
  actions: readonly CustomerAccountActionRequired[] | null | undefined,
  subscriptionId: string | null | undefined,
): boolean {
  return Boolean(subscriptionId && actions?.some((action) =>
    action.subscriptionId === subscriptionId && action.messageCode === "subscription_activation_missing_mandate"));
}
