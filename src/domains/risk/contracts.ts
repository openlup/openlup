import { z } from "../../lib/validation/zod.js";
import {
  RISK_CASE_DECISIONS,
  RISK_CASE_STATUSES,
  RISK_CONTRACT_VERSION,
  RISK_DECISIONS,
  RISK_ENFORCEMENT_MODES,
  RISK_REASON_CODES,
  RISK_RULESET_VERSION,
  RISK_SEVERITIES,
  RISK_SUBJECT_KINDS,
} from "./types.js";

const uuidSchema = z.string().uuid();
const datetimeSchema = z.string().datetime({ offset: true });
const moneyMinorSchema = z.number().int().nonnegative();

export const riskDecisionSchema = z.enum(RISK_DECISIONS);
export const riskEnforcementModeSchema = z.enum(RISK_ENFORCEMENT_MODES);
export const riskReasonCodeSchema = z.enum(RISK_REASON_CODES);
export const riskSeveritySchema = z.enum(RISK_SEVERITIES);
export const riskCaseStatusSchema = z.enum(RISK_CASE_STATUSES);
export const riskCaseDecisionSchema = z.enum(RISK_CASE_DECISIONS);
export const riskSubjectKindSchema = z.enum(RISK_SUBJECT_KINDS);

export const riskSubjectRefSchema = z.object({
  subjectKind: riskSubjectKindSchema,
  subjectHash: z.string().min(16).max(128),
}).strict();

export const riskRuleMatchSchema = z.object({
  code: riskReasonCodeSchema,
  score: z.number().int().min(0).max(100),
  severity: riskSeveritySchema,
  evidence: z.record(z.string(), z.unknown()),
}).strict();

export const riskEvaluationResultSchema = z.object({
  contractVersion: z.literal(RISK_CONTRACT_VERSION),
  rulesetVersion: z.literal(RISK_RULESET_VERSION),
  decision: riskDecisionSchema,
  score: z.number().int().min(0).max(100),
  severity: riskSeveritySchema,
  reasonCodes: z.array(riskReasonCodeSchema),
  matchedRules: z.array(riskRuleMatchSchema),
  enforcement: z.object({
    mode: riskEnforcementModeSchema,
    applied: z.boolean(),
    checkoutBlocked: z.boolean(),
    holdRequested: z.boolean(),
  }).strict(),
}).strict();

export const adminRiskCaseSummarySchema = z.object({
  id: uuidSchema,
  status: riskCaseStatusSchema,
  severity: riskSeveritySchema,
  decision: riskDecisionSchema,
  score: z.number().int().min(0).max(100),
  reasonCodes: z.array(riskReasonCodeSchema),
  orderId: uuidSchema.nullable(),
  clientId: uuidSchema.nullable(),
  paymentIntentId: uuidSchema.nullable(),
  holdId: uuidSchema.nullable(),
  createdAt: datetimeSchema,
  updatedAt: datetimeSchema,
}).strict();

export const adminRiskCaseEventSchema = z.object({
  id: uuidSchema,
  caseId: uuidSchema,
  eventType: z.string().min(1),
  actorUserId: uuidSchema.nullable(),
  note: z.string().nullable(),
  occurredAt: datetimeSchema,
}).strict();

export const adminRiskCaseDetailSchema = adminRiskCaseSummarySchema.extend({
  assessmentId: uuidSchema,
  subjectRefs: z.array(riskSubjectRefSchema),
  evidence: z.record(z.string(), z.unknown()),
  matchedRules: z.array(riskRuleMatchSchema),
  events: z.array(adminRiskCaseEventSchema),
  actionEligibility: z.object({
    approve: z.object({ allowed: z.boolean(), reason: z.string().nullable() }).strict(),
    block: z.object({ allowed: z.boolean(), reason: z.string().nullable() }).strict(),
    escalate: z.object({ allowed: z.boolean(), reason: z.string().nullable() }).strict(),
    note: z.object({ allowed: z.boolean(), reason: z.string().nullable() }).strict(),
  }).strict(),
}).strict();

export const adminRiskCasesListRequestSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: riskCaseStatusSchema.optional(),
  severity: riskSeveritySchema.optional(),
  orderId: uuidSchema.optional(),
  search: z.string().trim().max(120).optional(),
}).strict();

export const adminRiskCasesListResponseSchema = z.object({
  contractVersion: z.literal(RISK_CONTRACT_VERSION),
  cases: z.array(adminRiskCaseSummarySchema),
  totalCount: z.number().int().nonnegative(),
  summaryCounts: z.object({
    open: z.number().int().nonnegative(),
    inReview: z.number().int().nonnegative(),
    highSeverity: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const adminRiskCaseDetailRequestSchema = z.object({
  caseId: uuidSchema,
}).strict();

export const adminRiskCaseDetailResponseSchema = z.object({
  contractVersion: z.literal(RISK_CONTRACT_VERSION),
  case: adminRiskCaseDetailSchema,
}).strict();

export const adminRiskCaseDecisionRequestSchema = z.object({
  caseId: uuidSchema,
  idempotencyKey: z.string().min(8).max(160),
  decision: riskCaseDecisionSchema,
  note: z.string().trim().max(2000).optional(),
}).strict();

export const adminRiskCaseDecisionResponseSchema = z.object({
  contractVersion: z.literal(RISK_CONTRACT_VERSION),
  case: adminRiskCaseDetailSchema,
  replayed: z.boolean(),
}).strict();

export const riskCheckoutBlocklistRequestSchema = z.object({
  subjectRefs: z.array(riskSubjectRefSchema).min(1).max(20),
}).strict();

export const riskCheckoutBlocklistResponseSchema = z.object({
  blocked: z.boolean(),
  reasonCodes: z.array(riskReasonCodeSchema),
}).strict();

export const riskPaidOrderAssessmentRequestSchema = z.object({
  orderId: uuidSchema,
  paymentIntentId: uuidSchema.nullable(),
  paymentEventId: uuidSchema.nullable(),
  mode: riskEnforcementModeSchema,
  evaluation: riskEvaluationResultSchema,
  subjectRefs: z.array(riskSubjectRefSchema),
  evidence: z.record(z.string(), z.unknown()),
  occurredAt: datetimeSchema,
}).strict();

export type AdminRiskCasesListRequest = z.infer<typeof adminRiskCasesListRequestSchema>;
export type AdminRiskCasesListResponse = z.infer<typeof adminRiskCasesListResponseSchema>;
export type AdminRiskCaseDetailRequest = z.infer<typeof adminRiskCaseDetailRequestSchema>;
export type AdminRiskCaseDetailResponse = z.infer<typeof adminRiskCaseDetailResponseSchema>;
export type AdminRiskCaseDecisionRequest = z.infer<typeof adminRiskCaseDecisionRequestSchema>;
export type AdminRiskCaseDecisionResponse = z.infer<typeof adminRiskCaseDecisionResponseSchema>;
export type AdminRiskCaseSummary = z.infer<typeof adminRiskCaseSummarySchema>;
export type AdminRiskCaseDetail = z.infer<typeof adminRiskCaseDetailSchema>;
export type RiskEvaluationResult = z.infer<typeof riskEvaluationResultSchema>;
export type RiskPaidOrderAssessmentRequest = z.infer<typeof riskPaidOrderAssessmentRequestSchema>;
