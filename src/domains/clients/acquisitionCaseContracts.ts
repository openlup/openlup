import { z } from "../../lib/validation/zod.js";
import { CLIENTS_CONTRACT_VERSION } from "./searchContracts.js";

export const ACQUISITION_CASE_CONTRACT_VERSION = "tester_application_v1" as const;
export const ACQUISITION_CASE_VIEW = "acquisition_case_v1" as const;
export const ACQUISITION_CASE_SOURCE = "tester_application" as const;

const opaqueReferenceSchema = z.string().trim().min(8).max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const dateTimeSchema = z.string().datetime({ offset: true });

export const acquisitionAddressReferenceSchema = z.object({
  source: z.string().trim().min(1).max(48).regex(/^[a-z][a-z0-9_-]*$/),
  reference: opaqueReferenceSchema,
  revision: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  provenance: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
}).strict();

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

export const acquisitionCaseStateSchema = z.enum([
  "submitted", "approved", "active", "rejected", "withdrawn",
]);

export const acquisitionCaseProjectionSchema = z.object({
  contractVersion: z.literal(ACQUISITION_CASE_CONTRACT_VERSION),
  caseRef: opaqueReferenceSchema,
  contactRef: opaqueReferenceSchema,
  sourceKind: z.literal(ACQUISITION_CASE_SOURCE),
  consent: z.object({
    consentVersion: z.string().min(1).max(64),
    policyVersion: z.string().min(1).max(64),
    recordedAt: dateTimeSchema,
    locale: z.enum(["en", "pl"]),
    sourcePath: z.literal("/tester-application"),
  }).strict(),
  addressReference: acquisitionAddressReferenceSchema.nullable(),
  state: acquisitionCaseStateSchema,
  version: z.number().int().positive(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
}).strict().superRefine((value, context) => {
  if (value.state !== "withdrawn" && value.addressReference === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["addressReference"], message: "active case requires address reference" });
  }
});

export const acquisitionCaseListRequestSchema = z.object({
  view: z.literal(ACQUISITION_CASE_VIEW),
  cursor: opaqueReferenceSchema.optional(),
  limit: z.number().int().min(1).max(100).default(25),
}).strict();

export const acquisitionCaseListResponseSchema = z.object({
  contractVersion: z.literal(ACQUISITION_CASE_CONTRACT_VERSION),
  cases: z.array(acquisitionCaseProjectionSchema).max(100),
  nextCursor: opaqueReferenceSchema.nullable(),
}).strict();

export const acquisitionCaseTransitionRequestSchema = z.object({
  view: z.literal(ACQUISITION_CASE_VIEW),
  caseRef: opaqueReferenceSchema,
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

export const acquisitionCaseActiveCountResponseSchema = z.object({
  activeTesterCount: z.number().int().nonnegative(),
}).strict();

export const acquisitionIdempotencyKeySchema = z.string().trim().min(8).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export type AcquisitionCaseSubmitRequest = z.infer<typeof acquisitionCaseSubmitRequestSchema>;
export type AcquisitionCaseProjection = z.infer<typeof acquisitionCaseProjectionSchema>;
export type AcquisitionCaseListRequest = z.infer<typeof acquisitionCaseListRequestSchema>;
export type AcquisitionCaseListResponse = z.infer<typeof acquisitionCaseListResponseSchema>;
export type AcquisitionCaseTransitionRequest = z.infer<typeof acquisitionCaseTransitionRequestSchema>;
export type AcquisitionCaseTransitionResponse = z.infer<typeof acquisitionCaseTransitionResponseSchema>;
