import { z } from "../../lib/validation/zod.js";
import { SUBSCRIPTION_RECORD_STATUSES } from "../subscription/types.js";

export const CUSTOMER_SUBSCRIPTION_CONTROL_CONTRACT_VERSION =
  "customer.subscription_control.v1" as const;

const uuidSchema = z.guid();
const datetimeSchema = z.string().datetime({ offset: true });

export const customerSubscriptionControlLineSchema = z
  .object({
    variantId: uuidSchema,
    quantity: z.number().int().positive().max(99),
    isAddon: z.boolean(),
    sortOrder: z.number().int().nonnegative(),
  })
  .strict();

export const customerSubscriptionControlItemSchema = z
  .object({
    subscriptionId: uuidSchema,
    status: z.enum(SUBSCRIPTION_RECORD_STATUSES),
    cadenceDays: z.number().int().positive().max(90),
    nextCycleAt: datetimeSchema.nullable(),
    editCutoffAt: datetimeSchema.nullable(),
    templateVersion: z.number().int().positive(),
    recurringTotal: z
      .object({
        amountMinor: z.number().int().nonnegative(),
        currency: z.string().trim().length(3),
      })
      .strict()
      .nullable(),
    lines: z.array(customerSubscriptionControlLineSchema).max(18),
  })
  .strict();

export const customerSubscriptionControlResponseSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_SUBSCRIPTION_CONTROL_CONTRACT_VERSION),
    subscriptions: z.array(customerSubscriptionControlItemSchema),
  })
  .strict();

export type CustomerSubscriptionControlResponse = z.infer<
  typeof customerSubscriptionControlResponseSchema
>;
