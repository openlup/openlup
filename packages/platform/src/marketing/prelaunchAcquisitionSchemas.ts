import { z } from "./validation.js";

export const PRELAUNCH_ACQUISITION_VIEW = "prelaunch_acquisition_v1" as const;
export const PRELAUNCH_ACQUISITION_CONTRACT_VERSION = "prelaunch_acquisition_v1" as const;

const acquisitionCaseRefSchema = z.string().regex(/^acquisition-case:[0-9a-f-]{36}$/);
const acquisitionContactRefSchema = z.string().regex(/^acquisition-contact:[0-9a-f-]{36}$/);
const acquisitionOpaqueRefSchema = z.string().trim().min(8).max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const acquisitionDateTimeSchema = z.string().datetime({ offset: true });

export const prelaunchAcquisitionListRequestSchema = z.object({
  view: z.literal(PRELAUNCH_ACQUISITION_VIEW),
  cursor: acquisitionOpaqueRefSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export const prelaunchAcquisitionDetailRequestSchema = z.object({
  sourceRef: acquisitionCaseRefSchema,
}).strict();

export const prelaunchAcquisitionLeadSchema = z.object({
  sourceRef: acquisitionCaseRefSchema,
  contactRef: acquisitionContactRefSchema,
  sourceKind: z.literal("tester_application"),
  consent: z.object({
    consentVersion: z.string().min(1).max(64),
    policyVersion: z.string().min(1).max(64),
    recordedAt: acquisitionDateTimeSchema,
    locale: z.enum(["en", "pl"]),
    sourcePath: z.literal("/tester-application"),
  }).strict(),
  addressReference: z.object({
    source: z.string().trim().min(1).max(48).regex(/^[a-z][a-z0-9_-]*$/),
    reference: acquisitionOpaqueRefSchema,
    revision: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    provenance: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
  }).strict().nullable(),
  state: z.enum(["submitted", "approved", "active", "rejected", "withdrawn"]),
  version: z.number().int().positive(),
  createdAt: acquisitionDateTimeSchema,
  updatedAt: acquisitionDateTimeSchema,
}).strict().superRefine((value, context) => {
  if (value.state !== "withdrawn" && value.addressReference === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["addressReference"], message: "active case requires address reference" });
  }
});

export const prelaunchAcquisitionListResponseSchema = z.object({
  contractVersion: z.literal(PRELAUNCH_ACQUISITION_CONTRACT_VERSION),
  leads: z.array(prelaunchAcquisitionLeadSchema).max(100),
  nextCursor: acquisitionOpaqueRefSchema.nullable(),
}).strict();

export const prelaunchAcquisitionDetailResponseSchema = z.object({
  contractVersion: z.literal(PRELAUNCH_ACQUISITION_CONTRACT_VERSION),
  lead: prelaunchAcquisitionLeadSchema,
}).strict();

export type PrelaunchAcquisitionListRequest = z.infer<typeof prelaunchAcquisitionListRequestSchema>;
export type PrelaunchAcquisitionDetailRequest = z.infer<typeof prelaunchAcquisitionDetailRequestSchema>;
export type PrelaunchAcquisitionLead = z.infer<typeof prelaunchAcquisitionLeadSchema>;
export type PrelaunchAcquisitionListResponse = z.infer<typeof prelaunchAcquisitionListResponseSchema>;
export type PrelaunchAcquisitionDetailResponse = z.infer<typeof prelaunchAcquisitionDetailResponseSchema>;
