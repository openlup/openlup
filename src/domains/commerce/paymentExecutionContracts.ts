import { z } from "../../lib/validation/zod.js";

import { PAYMENT_EXECUTION_PROVIDERS } from "../payment/types.js";

export const tpayRecurringModelSchema = z.enum(["M", "O"]);
export const tpayBlikTokenSchema = z.string().regex(/^\d{6}$/);
export const tpayChannelIdSchema = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/);
export const tpaySavedPaymentMethodIdSchema = z.guid();

export const checkoutPaymentExecutionSchema = z.union([
  z.object({ provider: z.literal("hidden_rehearsal") }).strict(),
  z.object({ provider: z.literal("noop_payment") }).strict(),
  z
    .object({
      provider: z.literal("tpay"),
      flow: z.literal("blik_one_time"),
      blikToken: tpayBlikTokenSchema,
    })
    .strict(),
  z
    .object({
      provider: z.literal("tpay"),
      flow: z.literal("blik_one_click"),
      savedMethodId: tpaySavedPaymentMethodIdSchema,
    })
    .strict(),
  z
    .object({
      provider: z.literal("tpay"),
      flow: z.literal("pbl_one_time"),
      channelId: tpayChannelIdSchema,
    })
    .strict(),
  z
    .object({
      provider: z.literal("tpay"),
      flow: z.literal("blik_recurring_activation"),
      blikToken: tpayBlikTokenSchema,
      recurringModel: tpayRecurringModelSchema.default("M"),
    })
    .strict(),
  z
    .object({
      provider: z.literal("tpay"),
      flow: z.literal("blik_recurring_saved"),
      savedMethodId: tpaySavedPaymentMethodIdSchema,
      recurringModel: tpayRecurringModelSchema.default("M"),
    })
    .strict(),
]).superRefine((execution, ctx) => {
  if (!PAYMENT_EXECUTION_PROVIDERS.includes(execution.provider)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "unsupported payment provider",
      path: ["provider"],
    });
  }
});

export type CheckoutPaymentExecution = z.infer<typeof checkoutPaymentExecutionSchema>;
