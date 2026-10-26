import { z } from "../../lib/validation/zod.js";
import { CLIENTS_CONTRACT_VERSION } from "./searchContracts.js";
import { ACQUISITION_CASE_CONTRACT_VERSION, ACQUISITION_CASE_VIEW, acquisitionAddressReferenceSchema, acquisitionCaseProjectionSchema, acquisitionOpaqueReferenceSchema } from "@openlup/platform/marketing";

export {
  ACQUISITION_CASE_CONTRACT_VERSION,
  ACQUISITION_CASE_VIEW,
  ACQUISITION_CASE_SOURCE,
  acquisitionAddressReferenceSchema,
  acquisitionCaseStateSchema,
  acquisitionCaseProjectionSchema,
  acquisitionCaseListRequestSchema,
  acquisitionCaseListResponseSchema,
  acquisitionCaseActiveCountResponseSchema,
  acquisitionIdempotencyKeySchema,
} from "@openlup/platform/marketing";
export type { AcquisitionCaseProjection, AcquisitionCaseListRequest, AcquisitionCaseListResponse } from "@openlup/platform/marketing/contracts";

export const acquisitionCaseSubmitRequestSchema = z.object({
  contact: z.object({ email: z.string().trim().email().max(254) }).strict(),
  consent: z.object({
    accepted: z.literal(true),
    consentVersion: z.string().trim().min(1).max(64),
    policyVersion: z.string().trim().min(1).max(64),
    locale: z.enum(["en", "pl"]),
  }).strict(),
  addressReference: acquisitionAddressReferenceSchema,
}).strict();
export const acquisitionCaseTransitionRequestSchema = z.object({
  view: z.literal(ACQUISITION_CASE_VIEW),
  caseRef: acquisitionOpaqueReferenceSchema,
  expectedVersion: z.number().int().positive(),
  transition: z.enum(["approve", "activate", "reject", "withdraw"]),
  reason: z.string().trim().min(1).max(240).optional(),
}).strict().superRefine((value, context) => {
  if (value.transition === "reject" && !value.reason) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "reason is required" });
  }
  if (value.transition !== "reject" && value.reason) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "reason is reject-only" });
  }
});
export const acquisitionCaseTransitionResponseSchema = z.object({
  contractVersion: z.literal(ACQUISITION_CASE_CONTRACT_VERSION),
  acquisitionCase: acquisitionCaseProjectionSchema,
  replayed: z.boolean(),
}).strict();
export const acquisitionCaseSubmitResponseSchema = z.object({
  contractVersion: z.literal(CLIENTS_CONTRACT_VERSION),
  created: z.literal(true),
  testerEmail: z.string().email(),
  welcomeEmailRequested: z.literal(false),
}).strict();

export type AcquisitionCaseSubmitRequest = z.infer<typeof acquisitionCaseSubmitRequestSchema>;
export type AcquisitionCaseTransitionRequest = z.infer<typeof acquisitionCaseTransitionRequestSchema>;
export type AcquisitionCaseTransitionResponse = z.infer<typeof acquisitionCaseTransitionResponseSchema>;
