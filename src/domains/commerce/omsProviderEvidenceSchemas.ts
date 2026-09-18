import { z } from "../../lib/validation/zod.js";
import { datetimeSchema, nullableTextSchema } from "./omsContractBase.js";

export const omsProviderEvidenceSchema = z.object({
  evidenceType: z.enum(["dispatch_ref", "provider_attempt", "status_evidence"]),
  status: nullableTextSchema,
  providerStatus: nullableTextSchema,
  providerOrderId: nullableTextSchema,
  evidenceKind: nullableTextSchema,
  occurredAt: datetimeSchema.nullable(),
  updatedAt: datetimeSchema.nullable(),
  summary: nullableTextSchema,
}).strict();
