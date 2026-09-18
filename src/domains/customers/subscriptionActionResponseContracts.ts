import { z } from "../../lib/validation/zod.js";
import { SUBSCRIPTION_RECORD_STATUSES, type SubscriptionStatus } from "../subscription/types.js";

const uuidSchema = z.guid();
const datetimeSchema = z.string().datetime({ offset: true });
const CUSTOMER_SELF_SERVICE_ACTION_CONTRACT_VERSION = "customer.self_service.v1" as const;

export const customerSubscriptionActionNameSchema = z.enum([
  "slide_next_cycle",
  "skip_next_cycle",
  "order_now",
  "pause",
  "resume",
  "reactivate",
  "cancel",
  "change_shipping_address",
  "update_plan_length",
  "update_recipe_mix",
  "update_bundle",
  "update_package_template",
  "set_portion_mode",
  "resize_bundle",
  "add_addon",
  "remove_addon",
  "update_addon_quantity",
  "swap_recipe",
  "update_cadence",
  "update_package",
] as const);

export type CustomerSubscriptionActionName = z.infer<typeof customerSubscriptionActionNameSchema>;

export interface CustomerSubscriptionActionResult {
  subscriptionId: string;
  action: CustomerSubscriptionActionName;
  status: "applied" | "replayed" | "noop";
  subscriptionStatus: SubscriptionStatus;
  nextCycleAt: string | null;
  templateVersion: number | null;
  eventId: string | null;
}

export interface CustomerSubscriptionActionResponse {
  contractVersion: typeof CUSTOMER_SELF_SERVICE_ACTION_CONTRACT_VERSION;
  subscriptionAction: CustomerSubscriptionActionResult;
}

export const customerSubscriptionActionResponseSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_SELF_SERVICE_ACTION_CONTRACT_VERSION),
    subscriptionAction: z
      .object({
        subscriptionId: uuidSchema,
        action: customerSubscriptionActionNameSchema,
        status: z.enum(["applied", "replayed", "noop"]),
        subscriptionStatus: z.enum(SUBSCRIPTION_RECORD_STATUSES),
        nextCycleAt: datetimeSchema.nullable(),
        templateVersion: z.number().int().positive().nullable(),
        eventId: uuidSchema.nullable(),
      })
      .strict(),
  })
  .strict() as unknown as z.ZodType<CustomerSubscriptionActionResponse>;
