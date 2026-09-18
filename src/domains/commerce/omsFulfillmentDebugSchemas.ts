import { z } from "../../lib/validation/zod.js";
import { datetimeSchema, nullableTextSchema } from "./omsContractBase.js";

export const omsFulfillmentDebugStepSchema = z.object({
  key: z.enum(["payment", "stock", "provider_stock", "fulfillment", "dispatch", "provider", "tracking", "communication"]),
  status: z.enum(["ok", "pending", "missing", "warning", "blocked"]),
  label: z.string().min(1),
  value: nullableTextSchema,
  evidenceAt: datetimeSchema.nullable(),
  details: z.array(z.string()).default([]),
}).strict();

export const omsFulfillmentDebugSchema = z.object({
  summary: z.string().min(1),
  severity: z.enum(["ok", "watch", "action_required"]),
  nextAction: z.enum([
    "wait",
    "create_fulfillment",
    "retry_dispatch",
    "reconcile",
    "review_payment",
    "review_stock",
    "review_provider",
    "contact_support",
  ]),
  blockers: z.array(z.string()).default([]),
  steps: z.array(omsFulfillmentDebugStepSchema).default([]),
}).strict();

export type OmsFulfillmentDebug = z.infer<typeof omsFulfillmentDebugSchema>;

export const defaultOmsFulfillmentDebug: OmsFulfillmentDebug = {
  summary: "Brak danych fulfillmentu.",
  severity: "watch",
  nextAction: "wait",
  blockers: [],
  steps: [],
};
