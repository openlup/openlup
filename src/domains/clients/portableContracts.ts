import { z } from "../../lib/validation/zod.js";

export const CLIENTS_PORTABLE_CONTRACT_VERSION = "clients.customer_360.v2" as const;

const countSchema = z.number().int().nonnegative();
const nullableDateTimeSchema = z.string().datetime({ offset: true }).nullable();
const subjectIdSchema = z.string().trim().min(1).max(160);
const managedOverlaySchema = z.record(z.string(), z.unknown());

export const adminClientsPortableLifecycleStageSchema = z.enum([
  "lead", "waitlist", "tester", "customer", "inactive",
]);
export const adminClientsPortableSummaryRequestSchema = z.object({}).strict();
export const adminClientsPortableSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(200),
  page: z.coerce.number().int().nonnegative().max(2_147_483_647).default(0),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
  lifecycleStage: z.union([
    z.literal("all"), adminClientsPortableLifecycleStageSchema,
  ]).default("all"),
}).strict();

export const adminClientsPortableSubjectSchema = z.object({
  subjectId: subjectIdSchema,
  displayName: z.string().trim().min(1).max(240).nullable(),
  email: z.string().email().max(320).nullable(),
  phone: z.string().trim().min(1).max(80).nullable(),
  lifecycleStage: adminClientsPortableLifecycleStageSchema,
  createdAt: nullableDateTimeSchema,
  lastActivityAt: nullableDateTimeSchema,
}).strict();

export const adminClientsPortableSummaryResponseSchema = z.object({
  contractVersion: z.literal(CLIENTS_PORTABLE_CONTRACT_VERSION),
  summary: z.object({
    totalSubjects: countSchema,
    byLifecycleStage: z.object({
      lead: countSchema,
      waitlist: countSchema,
      tester: countSchema,
      customer: countSchema,
      inactive: countSchema,
    }).strict(),
    openDunningCases: countSchema,
    recoverableCases: countSchema,
    lastActivityAt: nullableDateTimeSchema,
  }).strict(),
  managedOverlay: managedOverlaySchema.optional(),
}).strict();

export const adminClientsPortableSearchResponseSchema = z.object({
  contractVersion: z.literal(CLIENTS_PORTABLE_CONTRACT_VERSION),
  candidates: z.array(z.object({
    subject: adminClientsPortableSubjectSchema,
    matchedBy: z.enum(["subject_id", "email", "phone", "name", "order", "subscription", "text"]),
    confidence: z.enum(["exact", "high", "medium"]),
    journeyLookup: z.object({ subjectId: subjectIdSchema }).strict(),
    managedOverlay: managedOverlaySchema.optional(),
  }).strict()),
  totalCount: countSchema,
  page: z.number().int().nonnegative(),
  pageSize: z.number().int().positive(),
}).strict();

export const adminClientsPortableDetailRequestSchema = z.object({
  subjectId: subjectIdSchema,
}).strict();

export const adminClientsPortableDetailResponseSchema = z.object({
  contractVersion: z.literal(CLIENTS_PORTABLE_CONTRACT_VERSION),
  subject: adminClientsPortableSubjectSchema,
  references: z.object({
    orderIds: z.array(subjectIdSchema),
    subscriptionIds: z.array(subjectIdSchema),
    dunningCaseIds: z.array(subjectIdSchema),
  }).strict(),
  journeyLookup: z.object({ subjectId: subjectIdSchema }).strict(),
  managedOverlay: managedOverlaySchema.optional(),
}).strict();

export type AdminClientsPortableSummaryRequest = z.infer<typeof adminClientsPortableSummaryRequestSchema>;
export type AdminClientsPortableSearchRequest = z.infer<typeof adminClientsPortableSearchRequestSchema>;
export type AdminClientsPortableSubject = z.infer<typeof adminClientsPortableSubjectSchema>;
export type AdminClientsPortableSummaryResponse = z.infer<typeof adminClientsPortableSummaryResponseSchema>;
export type AdminClientsPortableSearchResponse = z.infer<typeof adminClientsPortableSearchResponseSchema>;
export type AdminClientsPortableDetailRequest = z.infer<typeof adminClientsPortableDetailRequestSchema>;
export type AdminClientsPortableDetailResponse = z.infer<typeof adminClientsPortableDetailResponseSchema>;
