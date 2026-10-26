import { z } from "zod";

export const ACQUISITION_CASE_CONTRACT_VERSION = "tester_application_v1" as const;
export const ACQUISITION_CASE_VIEW = "acquisition_case_v1" as const;
export const ACQUISITION_CASE_SOURCE = "tester_application" as const;

export const acquisitionOpaqueReferenceSchema = z.string().trim().min(8).max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const dateTimeSchema = z.string().datetime({ offset: true });

export const acquisitionAddressReferenceSchema = z.object({
  source: z.string().trim().min(1).max(48).regex(/^[a-z][a-z0-9_-]*$/),
  reference: acquisitionOpaqueReferenceSchema,
  revision: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  provenance: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
}).strict();


export const acquisitionCaseStateSchema = z.enum([
  "submitted", "approved", "active", "rejected", "withdrawn",
]);

export const acquisitionCaseProjectionSchema = z.object({
  contractVersion: z.literal(ACQUISITION_CASE_CONTRACT_VERSION),
  caseRef: acquisitionOpaqueReferenceSchema,
  contactRef: acquisitionOpaqueReferenceSchema,
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
  cursor: acquisitionOpaqueReferenceSchema.optional(),
  limit: z.number().int().min(1).max(100).default(25),
}).strict();

export const acquisitionCaseListResponseSchema = z.object({
  contractVersion: z.literal(ACQUISITION_CASE_CONTRACT_VERSION),
  cases: z.array(acquisitionCaseProjectionSchema).max(100),
  nextCursor: acquisitionOpaqueReferenceSchema.nullable(),
}).strict();




export const acquisitionCaseActiveCountResponseSchema = z.object({
  activeTesterCount: z.number().int().nonnegative(),
}).strict();

export const acquisitionIdempotencyKeySchema = z.string().trim().min(8).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export type AcquisitionOpaqueReference = z.infer<typeof acquisitionOpaqueReferenceSchema>;
export type AcquisitionAddressReference = z.infer<typeof acquisitionAddressReferenceSchema>;
export type AcquisitionCaseState = z.infer<typeof acquisitionCaseStateSchema>;
export type AcquisitionCaseProjection = z.infer<typeof acquisitionCaseProjectionSchema>;
export type AcquisitionCaseListRequest = z.infer<typeof acquisitionCaseListRequestSchema>;
export type AcquisitionCaseListResponse = z.infer<typeof acquisitionCaseListResponseSchema>;
export type AcquisitionCaseActiveCountResponse = z.infer<typeof acquisitionCaseActiveCountResponseSchema>;
export type AcquisitionIdempotencyKey = z.infer<typeof acquisitionIdempotencyKeySchema>;
