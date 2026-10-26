import { z } from "../../../lib/validation/zod.js";

export {
  PRELAUNCH_ACQUISITION_VIEW,
  PRELAUNCH_ACQUISITION_CONTRACT_VERSION,
  prelaunchAcquisitionListRequestSchema,
  prelaunchAcquisitionDetailRequestSchema,
  prelaunchAcquisitionLeadSchema,
  prelaunchAcquisitionListResponseSchema,
  prelaunchAcquisitionDetailResponseSchema,
  type PrelaunchAcquisitionListRequest,
  type PrelaunchAcquisitionDetailRequest,
  type PrelaunchAcquisitionLead,
  type PrelaunchAcquisitionListResponse,
  type PrelaunchAcquisitionDetailResponse,
} from "@openlup/platform/marketing";

export const MARKETING_PRELAUNCH_CONTRACT_VERSION = "2026-07-05.marketing-prelaunch-read-model";
export const prelaunchLeadSourceSchema = z.enum(["tester", "waitlist"]);
export const prelaunchLeadStageSchema = z.enum([
  "waitlist_only",
  "tester_signup",
  "tester_approved",
  "shipped",
  "delivered",
  "feedback_started",
  "feedback_completed",
  "conversion_ready",
]);
export const prelaunchLeadSourceRefSchema = z.string().regex(/^(testers|waitlist):[a-zA-Z0-9_-]{1,80}$/);

export const adminPrelaunchLeadsRequestSchema = z.object({
  query: z.string().trim().max(120).optional().catch(undefined),
  source: z.enum(["all", "tester", "waitlist"]).default("all"),
  stage: z.enum(["all", ...prelaunchLeadStageSchema.options]).default("all"),
  page: z.coerce.number().int().nonnegative().default(0),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const adminPrelaunchLeadDetailRequestSchema = z.object({
  sourceRef: prelaunchLeadSourceRefSchema,
});

const nullableTextSchema = z.string().min(1).nullable();
const nullableNumberSchema = z.number().finite().nullable();

export const prelaunchPetSnapshotSchema = z.object({
  sourceRef: prelaunchLeadSourceRefSchema,
  petKind: z.enum(["dog", "cat", "unknown"]),
  name: nullableTextSchema,
  breed: nullableTextSchema,
  age: nullableTextSchema,
  weightKg: nullableNumberSchema,
});

export const prelaunchFeedbackSummarySchema = z.object({
  testerId: z.string().min(1),
  feedbackId: z.string().min(1).nullable(),
  status: z.enum(["not_started", "started", "completed"]),
  submittedAt: nullableTextSchema,
  sectionBSubmittedAt: nullableTextSchema,
  sectionCSubmittedAt: nullableTextSchema,
  overallRating: nullableNumberSchema,
  npsRating: nullableNumberSchema,
  photoCount: z.number().int().nonnegative(),
});

export const prelaunchConsentSummarySchema = z.object({
  marketingLaunchOfferConsent: z.boolean().nullable(),
  testerProgramConsent: z.boolean().nullable(),
  newsletterConsent: z.boolean().nullable(),
  emailSequencePaused: z.boolean().nullable(),
});

export const prelaunchAttributionSummarySchema = z.object({
  waitlistSource: nullableTextSchema,
  waitlistLocale: z.enum(["pl", "en"]).nullable(),
});

export const prelaunchConversionCandidateSchema = z.object({
  status: z.enum(["ready", "review_required", "already_client"]),
  reason: z.enum(["has_email", "existing_client", "conflicting_sources", "rejected_tester"]),
  existingClientId: z.string().min(1).nullable(),
  existingLifecycleStage: nullableTextSchema,
  prefill: z.object({
    email: z.string().email(),
    firstName: nullableTextSchema,
    lastName: nullableTextSchema,
    phone: nullableTextSchema,
    pets: z.array(prelaunchPetSnapshotSchema),
  }),
});

export const prelaunchLeadSchema = z.object({
  contractVersion: z.literal(MARKETING_PRELAUNCH_CONTRACT_VERSION),
  primarySourceRef: prelaunchLeadSourceRefSchema,
  sourceRefs: z.array(prelaunchLeadSourceRefSchema).min(1),
  sources: z.array(prelaunchLeadSourceSchema).min(1),
  stage: prelaunchLeadStageSchema,
  displayName: nullableTextSchema,
  email: z.string().email(),
  phone: nullableTextSchema,
  createdAt: nullableTextSchema,
  testerStatus: nullableTextSchema,
  petSnapshots: z.array(prelaunchPetSnapshotSchema),
  feedbackSummary: prelaunchFeedbackSummarySchema.nullable(),
  consentSummary: prelaunchConsentSummarySchema,
  attributionSummary: prelaunchAttributionSummarySchema,
  conversionCandidate: prelaunchConversionCandidateSchema,
});

export const adminPrelaunchLeadsResponseSchema = z.object({
  contractVersion: z.literal(MARKETING_PRELAUNCH_CONTRACT_VERSION),
  leads: z.array(prelaunchLeadSchema),
  totalCount: z.number().int().nonnegative(),
  page: z.number().int().nonnegative(),
  pageSize: z.number().int().positive(),
});

export const adminPrelaunchLeadDetailResponseSchema = z.object({
  contractVersion: z.literal(MARKETING_PRELAUNCH_CONTRACT_VERSION),
  lead: prelaunchLeadSchema.nullable(),
});

export type PrelaunchLeadSource = z.infer<typeof prelaunchLeadSourceSchema>;
export type PrelaunchLeadStage = z.infer<typeof prelaunchLeadStageSchema>;
export type PrelaunchLeadSourceRef = z.infer<typeof prelaunchLeadSourceRefSchema>;
export type AdminPrelaunchLeadsRequest = z.infer<typeof adminPrelaunchLeadsRequestSchema>;
export type AdminPrelaunchLeadDetailRequest = z.infer<typeof adminPrelaunchLeadDetailRequestSchema>;
export type PrelaunchPetSnapshot = z.infer<typeof prelaunchPetSnapshotSchema>;
export type PrelaunchFeedbackSummary = z.infer<typeof prelaunchFeedbackSummarySchema>;
export type PrelaunchConsentSummary = z.infer<typeof prelaunchConsentSummarySchema>;
export type PrelaunchAttributionSummary = z.infer<typeof prelaunchAttributionSummarySchema>;
export type PrelaunchConversionCandidate = z.infer<typeof prelaunchConversionCandidateSchema>;
export type PrelaunchLead = z.infer<typeof prelaunchLeadSchema>;
export type AdminPrelaunchLeadsResponse = z.infer<typeof adminPrelaunchLeadsResponseSchema>;
export type AdminPrelaunchLeadDetailResponse = z.infer<typeof adminPrelaunchLeadDetailResponseSchema>;
