import { z } from "../../src/lib/validation/zod.js";
import {
  CUSTOMER_DIAGNOSTIC_COVERAGE_VERSION,
  customerDiagnosticCoverageVersionSchema,
  CUSTOMER_DIAGNOSTIC_COVERAGE_VERSION_V1,
  CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V1,
  CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V2,
  customerDiagnosticActionSchema,
  customerDiagnosticCodeSchema,
  customerDiagnosticPhaseSchema,
} from "../../src/domains/observability/customerJourneyDiagnostics.js";
import {
  CustomerDiagnosticConflictError,
  CustomerDiagnosticUnavailableError,
  type CustomerDiagnosticHistoryPort,
  type CustomerDiagnosticOverviewPort,
  type CustomerDiagnosticOverviewResult,
  type CustomerDiagnosticSearchResult,
  type CustomerDiagnosticSegmentResult,
} from "../domains/observability/customerDiagnosticHistory.js";

type RpcResult = { data: unknown; error: unknown };
type RpcGateway = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
};

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const nullableCode = customerDiagnosticCodeSchema.nullable();
const segmentSummarySchema = z.object({
  segmentId: uuid,
  attribution: z.enum(["anonymous", "account_verified"]),
  subjectId: uuid.nullable(),
  firstSeenAt: timestamp,
  lastSeenAt: timestamp,
  eventCount: z.number().int().nonnegative(),
  actionCount: z.number().int().nonnegative(),
}).strict();
const groupSchema = z.object({
  coverageVersion: customerDiagnosticCoverageVersionSchema,
  action: customerDiagnosticActionSchema,
  phase: customerDiagnosticPhaseSchema,
  code: nullableCode,
  eventCount: z.number().int().nonnegative(),
  actionCount: z.number().int().nonnegative(),
  segmentCount: z.number().int().nonnegative(),
}).strict();
const legacyGroupSchema = z.object({
  action: customerDiagnosticActionSchema,
  phase: customerDiagnosticPhaseSchema,
  code: nullableCode,
  eventCount: z.number().int().nonnegative(),
  actionCount: z.number().int().nonnegative(),
  segmentCount: z.number().int().nonnegative(),
}).strict();
const common = {
  sourceHealth: z.object({ read: z.literal("available"), delivery: z.literal("unknown") }).strict(),
  loss: z.object({ status: z.literal("unknown"), reason: z.literal("browser_delivery_not_measurable") }).strict(),
};
const overviewTerminalClassificationSchema = z.union([
  z.enum([
    "succeeded", "rejected", "failed", "unknown", "timeout", "transport_uncertain", "retryable",
    "validation_blocked", "quote_unavailable", "refresh_failed",
  ]),
  z.enum(["conflicting_terminal", "observation_gap", "terminalWithoutStart"]),
]);
const overviewBucketSchema = z.object({
  classification: overviewTerminalClassificationSchema,
  actionCount: z.number().int().nonnegative(),
  exampleSegmentIds: z.array(uuid).max(3),
}).strict();
const staticLifecycleSchema = z.object({
  phase: customerDiagnosticPhaseSchema,
  code: customerDiagnosticCodeSchema,
  eventCount: z.number().int().nonnegative(),
  // Null when no event in this (phase, code) bucket carries an action id.
  actionCount: z.number().int().nonnegative().nullable(),
  exampleSegmentIds: z.array(uuid).max(3),
}).strict();
const overviewGroupSchema = z.object({
  coverageVersion: customerDiagnosticCoverageVersionSchema,
  action: customerDiagnosticActionSchema,
  rateApplicability: z.enum(["applicable", "not_applicable"]),
  attemptedActionCount: z.number().int().nonnegative().nullable(),
  terminalOutcomes: z.array(overviewBucketSchema),
  staticLifecycle: z.array(staticLifecycleSchema),
}).strict().superRefine((group, context) => {
  if (group.rateApplicability === "applicable" && group.attemptedActionCount === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid overview rate applicability" });
  }
  if (group.rateApplicability === "applicable" && group.staticLifecycle.length !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Applicable overview cannot contain static lifecycle observations" });
  }
  if (group.rateApplicability === "not_applicable" && group.attemptedActionCount !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid overview rate applicability" });
  }
  if (group.rateApplicability === "not_applicable" && group.terminalOutcomes.length !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Static lifecycle overview cannot contain terminal outcomes" });
  }
  if (group.rateApplicability === "applicable") {
    const classifiedAttemptCount = group.terminalOutcomes
      .filter((outcome) => outcome.classification !== "terminalWithoutStart")
      .reduce((total, outcome) => total + outcome.actionCount, 0);
    if (group.attemptedActionCount !== classifiedAttemptCount) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Overview action count does not match terminal outcomes" });
    }
  }
});
const overviewSchema = z.object({
  ...common,
  contractVersion: z.literal(CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V2),
  windowCoverage: z.enum(["full", "partial", "expired"]),
  evidencePresence: z.enum(["observed", "empty"]),
  retainedFrom: timestamp.nullable(),
  truncated: z.boolean(),
  nextCursor: z.string().nullable(),
  groups: z.array(overviewGroupSchema),
}).strict().superRefine((result, context) => {
  if (result.evidencePresence === "empty" && result.groups.length !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid overview evidence presence" });
  }
});
const v2SearchSchema = z.object({
  ...common,
  contractVersion: z.literal(CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V2),
  retainedFrom: timestamp.nullable(),
  truncated: z.boolean(),
  nextCursor: z.string().nullable(),
  groups: z.array(groupSchema),
  segments: z.array(segmentSummarySchema),
}).strict();
const v1SearchSchema = z.object({
  ...common,
  contractVersion: z.literal(CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V1),
  coverageVersion: z.literal(CUSTOMER_DIAGNOSTIC_COVERAGE_VERSION_V1),
  retainedFrom: timestamp.nullable(),
  truncated: z.boolean(),
  nextCursor: z.string().nullable(),
  groups: z.array(legacyGroupSchema),
  segments: z.array(segmentSummarySchema),
}).strict();
const eventSchema = z.object({
  coverageVersion: customerDiagnosticCoverageVersionSchema,
  eventId: uuid,
  actionId: uuid.nullable(),
  action: customerDiagnosticActionSchema,
  phase: customerDiagnosticPhaseSchema,
  code: nullableCode,
  durationMs: z.number().int().nonnegative().nullable(),
  relatedRequestId: z.string().nullable(),
  relatedRequestTrust: z.literal("browser_reported").nullable(),
  ingestRequestId: z.string().min(1).max(128),
  receivedAt: timestamp,
}).strict();
const legacyEventSchema = z.object({
  eventId: uuid,
  actionId: uuid.nullable(),
  action: customerDiagnosticActionSchema,
  phase: customerDiagnosticPhaseSchema,
  code: nullableCode,
  durationMs: z.number().int().nonnegative().nullable(),
  relatedRequestId: z.string().nullable(),
  relatedRequestTrust: z.literal("browser_reported").nullable(),
  ingestRequestId: z.string().min(1).max(128),
  receivedAt: timestamp,
}).strict();
const v2HistorySchema = z.object({
  ...common,
  contractVersion: z.literal(CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V2),
  segmentId: uuid,
  attribution: z.enum(["anonymous", "account_verified"]),
  subjectId: uuid.nullable(),
  predecessor: z.object({
    segmentId: uuid,
    relation: z.literal("same_tab_pre_auth_context"),
  }).strict().nullable(),
  events: z.array(eventSchema),
  truncated: z.boolean(),
  nextCursor: z.string().nullable(),
}).strict();
const v1HistorySchema = z.object({
  ...common,
  contractVersion: z.literal(CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V1),
  coverageVersion: z.literal(CUSTOMER_DIAGNOSTIC_COVERAGE_VERSION_V1),
  segmentId: uuid,
  attribution: z.enum(["anonymous", "account_verified"]),
  subjectId: uuid.nullable(),
  predecessor: z.object({
    segmentId: uuid,
    relation: z.literal("same_tab_pre_auth_context"),
  }).strict().nullable(),
  events: z.array(legacyEventSchema),
  truncated: z.boolean(),
  nextCursor: z.string().nullable(),
}).strict();
const storeSchema = z.object({
  outcome: z.enum(["committed", "rate_limited"]),
  credentialDisposition: z.enum(["reused", "issued", "rotated"]).optional(),
  deduplicated: z.boolean().optional(),
  segmentId: uuid.optional(),
  actionId: uuid.nullable().optional(),
}).strict();
const pruneSchema = z.object({
  eventsDeleted: z.number().int().nonnegative(),
  segmentsDeleted: z.number().int().nonnegative(),
  limitsDeleted: z.number().int().nonnegative(),
  accessDeleted: z.number().int().nonnegative(),
}).strict();

export function createCustomerDiagnosticHistoryPort(
  gateway: unknown,
  retentionDays: number,
): CustomerDiagnosticHistoryPort & CustomerDiagnosticOverviewPort {
  const client = gateway as RpcGateway;
  return {
    async ingest(input) {
      const isV2 = input.coverageVersion === CUSTOMER_DIAGNOSTIC_COVERAGE_VERSION;
      return storeSchema.parse(await call(client, isV2 ? "customer_diagnostic_ingest_v2" : "customer_diagnostic_ingest_v1", {
        p_presented_credential_hash: input.presentedCredentialHash,
        p_issued_credential_hash: input.issuedCredentialHash,
        p_principal_id: input.principalId,
        p_subject_id: input.subjectId,
        p_client_event_key: input.clientEventKey,
        p_client_action_key: input.clientActionKey ?? null,
        p_action: input.action,
        p_phase: input.phase,
        p_code: input.code ?? null,
        p_duration_ms: input.durationMs ?? null,
        p_reported_request_id: input.relatedRequestId ?? null,
        p_ingest_request_id: input.ingestRequestId,
        p_abuse_key_hash: input.abuseKeyHash,
        p_payload_fingerprint: input.payloadFingerprint,
        p_retention_days: retentionDays,
        ...(isV2 ? { p_coverage_version: input.coverageVersion } : {}),
      }));
    },
    async search(input) {
      const isV2 = input.contractVersion === CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V2;
      const result = await call(client, isV2 ? "customer_diagnostic_search_v2" : "customer_diagnostic_search_v1", {
        p_operator_id: input.operatorId,
        p_from: input.windowStart,
        p_to: input.windowEnd,
        p_subject_id: input.subjectId ?? null,
        p_action: input.action ?? null,
        p_phase: input.phase ?? null,
        p_code: input.code ?? null,
        p_page_size: input.pageSize,
        p_cursor: input.cursor ?? null,
        p_retention_days: retentionDays,
      });
      return (isV2 ? v2SearchSchema : v1SearchSchema).parse(result) as CustomerDiagnosticSearchResult;
    },
    async readSegment(input) {
      const isV2 = input.contractVersion === CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V2;
      const data = await call(client, isV2 ? "customer_diagnostic_segment_v2" : "customer_diagnostic_segment_v1", {
        p_operator_id: input.operatorId,
        p_segment_id: input.segmentId,
        p_page_size: input.pageSize,
        p_cursor: input.cursor ?? null,
        p_retention_days: retentionDays,
      });
      return data === null ? null : (isV2 ? v2HistorySchema : v1HistorySchema).parse(data) as CustomerDiagnosticSegmentResult;
    },
    async overview(input) {
      return overviewSchema.parse(await call(client, "customer_diagnostic_overview_v2", {
        p_operator_id: input.operatorId,
        p_from: input.windowStart,
        p_to: input.windowEnd,
        p_page_size: input.pageSize,
        p_cursor: input.cursor ?? null,
        p_retention_days: retentionDays,
      })) as CustomerDiagnosticOverviewResult;
    },
    async prune(batchSize) {
      return pruneSchema.parse(await call(client, "customer_diagnostic_prune_v1", {
        p_batch_size: batchSize,
      }));
    },
  };
}

async function call(client: RpcGateway, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.rpc(name, args);
  if (result.error) {
    const text = errorText(result.error);
    if (text.includes("customer_diagnostic_event_conflict")) throw new CustomerDiagnosticConflictError();
    throw new CustomerDiagnosticUnavailableError();
  }
  if (result.data === undefined) throw new CustomerDiagnosticUnavailableError();
  return result.data;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return "";
}
