import { z } from "zod";
z.config({ jitless: true });
const platformCurrencySchema = z.string().regex(/^[A-Z]{3}$/);
export const customerLifecycleStageSchema = z.enum([
  "lead",
  "tester",
  "customer",
  "inactive",
]);

export const customerMeRequestSchema = z.object({}).strict();

export const customerMeResponseSchema = z.object({
  clientId: z.string().min(1),
  email: z.string().min(1),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  lifecycleStage: customerLifecycleStageSchema,
  subscriptions: z
    .array(
      z
        .object({
          subscriptionId: z.guid(),
          status: z.string().min(1),
          cadenceDays: z.number().int().positive(),
          nextCycleAt: z.string().datetime({ offset: true }).nullable(),
          paymentMethodKind: z.string().nullable(),
        })
        .strict(),
    )
    .optional(),
  recentOrders: z
    .array(
      z
        .object({
          orderId: z.guid(),
          orderRef: z.string().regex(/^order_[a-z0-9-]+$/),
          status: z.string().min(1),
          mode: z.enum(["one_time", "subscription_cycle"]),
          total: z.object({
            amountMinor: z.number().int().nonnegative(),
            currency: platformCurrencySchema,
          }),
          createdAt: z.string().datetime({ offset: true }),
        })
        .strict(),
    )
    .optional(),
});


export type CustomerMeResponse = z.infer<typeof customerMeResponseSchema>;
