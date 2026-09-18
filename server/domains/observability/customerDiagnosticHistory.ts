import { createHash, randomBytes } from "node:crypto";

import type {
  CustomerDiagnosticAction,
  CustomerDiagnosticCode,
  CustomerDiagnosticCoverageVersion,
  CustomerDiagnosticHistoryContractVersion,
  CustomerDiagnosticIngestRequest,
  CustomerDiagnosticPhase,
} from "../../../src/domains/observability/customerJourneyDiagnostics.js";

export type DiagnosticAttribution = "anonymous" | "account_verified";

export interface CustomerDiagnosticStoreInput extends Omit<CustomerDiagnosticIngestRequest, "segmentCredential" | "coverageVersion"> {
  coverageVersion?: CustomerDiagnosticCoverageVersion;
  presentedCredentialHash: string | null;
  issuedCredentialHash: string;
  principalId: string | null;
  subjectId: string | null;
  ingestRequestId: string;
  abuseKeyHash: string;
  payloadFingerprint: string;
}

export interface CustomerDiagnosticStoreResult {
  outcome: "committed" | "rate_limited";
  credentialDisposition?: "reused" | "issued" | "rotated";
  deduplicated?: boolean;
  segmentId?: string;
  actionId?: string | null;
}

export interface CustomerDiagnosticSearchInput {
  contractVersion: CustomerDiagnosticHistoryContractVersion;
  operatorId: string;
  windowStart: string;
  windowEnd: string;
  subjectId?: string;
  action?: CustomerDiagnosticAction;
  phase?: CustomerDiagnosticPhase;
  code?: CustomerDiagnosticCode;
  pageSize: number;
  cursor?: string;
}

export interface CustomerDiagnosticHistoryInput {
  contractVersion: CustomerDiagnosticHistoryContractVersion;
  operatorId: string;
  segmentId: string;
  pageSize: number;
  cursor?: string;
}

/** Overview is additive to the explicit v2 read contract; v1 keeps its retained views. */
export interface CustomerDiagnosticOverviewInput {
  contractVersion: "customer-diagnostic-history.v2";
  operatorId: string;
  windowStart: string;
  windowEnd: string;
  pageSize: number;
  cursor?: string;
}

export interface CustomerDiagnosticGroup {
  coverageVersion: CustomerDiagnosticCoverageVersion;
  action: CustomerDiagnosticAction;
  phase: CustomerDiagnosticPhase;
  code: CustomerDiagnosticCode | null;
  eventCount: number;
  actionCount: number;
  segmentCount: number;
}

export interface CustomerDiagnosticLegacyGroup {
  action: CustomerDiagnosticAction;
  phase: CustomerDiagnosticPhase;
  code: CustomerDiagnosticCode | null;
  eventCount: number;
  actionCount: number;
  segmentCount: number;
}

export interface CustomerDiagnosticSegmentSummary {
  segmentId: string;
  attribution: DiagnosticAttribution;
  subjectId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  eventCount: number;
  actionCount: number;
}

interface CustomerDiagnosticSearchMetadata {
  retainedFrom: string | null;
  truncated: boolean;
  nextCursor: string | null;
  segments: CustomerDiagnosticSegmentSummary[];
  sourceHealth: CustomerDiagnosticSourceHealth;
  loss: CustomerDiagnosticLoss;
}

export interface CustomerDiagnosticV1SearchResult extends CustomerDiagnosticSearchMetadata {
  contractVersion: "customer-diagnostic-history.v1";
  coverageVersion: "purchase-auth-account.v1";
  groups: CustomerDiagnosticLegacyGroup[];
}

export interface CustomerDiagnosticV2SearchResult extends CustomerDiagnosticSearchMetadata {
  contractVersion: "customer-diagnostic-history.v2";
  groups: CustomerDiagnosticGroup[];
}

export type CustomerDiagnosticSearchResult = CustomerDiagnosticV1SearchResult | CustomerDiagnosticV2SearchResult;

export interface CustomerDiagnosticSourceHealth {
  read: "available";
  delivery: "unknown";
}

export interface CustomerDiagnosticLoss {
  status: "unknown";
  reason: "browser_delivery_not_measurable";
}

export type CustomerDiagnosticWindowCoverage = "full" | "partial" | "expired";
export type CustomerDiagnosticEvidencePresence = "observed" | "empty";
export type CustomerDiagnosticRateApplicability = "applicable" | "not_applicable";
export type CustomerDiagnosticOverviewClassification = "succeeded"
  | "rejected"
  | "failed"
  | "unknown"
  | "timeout"
  | "transport_uncertain"
  | "retryable"
  | "validation_blocked"
  | "quote_unavailable"
  | "refresh_failed"
  | "conflicting_terminal"
  | "observation_gap"
  | "terminalWithoutStart";

export interface CustomerDiagnosticOverviewBucket {
  classification: CustomerDiagnosticOverviewClassification;
  actionCount: number;
  exampleSegmentIds: string[];
}

export interface CustomerDiagnosticStaticLifecycleObservation {
  phase: CustomerDiagnosticPhase;
  code: CustomerDiagnosticCode;
  eventCount: number;
  /** Distinct action ids in this bucket; null when no event in it carries one. */
  actionCount: number | null;
  exampleSegmentIds: string[];
}

export interface CustomerDiagnosticOverviewGroup {
  coverageVersion: CustomerDiagnosticCoverageVersion;
  action: CustomerDiagnosticAction;
  rateApplicability: CustomerDiagnosticRateApplicability;
  attemptedActionCount: number | null;
  terminalOutcomes: CustomerDiagnosticOverviewBucket[];
  staticLifecycle: CustomerDiagnosticStaticLifecycleObservation[];
}

export interface CustomerDiagnosticOverviewResult {
  contractVersion: "customer-diagnostic-history.v2";
  sourceHealth: CustomerDiagnosticSourceHealth;
  loss: CustomerDiagnosticLoss;
  windowCoverage: CustomerDiagnosticWindowCoverage;
  evidencePresence: CustomerDiagnosticEvidencePresence;
  retainedFrom: string | null;
  truncated: boolean;
  nextCursor: string | null;
  groups: CustomerDiagnosticOverviewGroup[];
}

export interface CustomerDiagnosticOverviewPort {
  overview(input: CustomerDiagnosticOverviewInput): Promise<CustomerDiagnosticOverviewResult>;
}

export interface CustomerDiagnosticEvent {
  coverageVersion: CustomerDiagnosticCoverageVersion;
  eventId: string;
  actionId: string | null;
  action: CustomerDiagnosticAction;
  phase: CustomerDiagnosticPhase;
  code: CustomerDiagnosticCode | null;
  durationMs: number | null;
  relatedRequestId: string | null;
  relatedRequestTrust: "browser_reported" | null;
  ingestRequestId: string;
  receivedAt: string;
}

export interface CustomerDiagnosticLegacyEvent {
  eventId: string;
  actionId: string | null;
  action: CustomerDiagnosticAction;
  phase: CustomerDiagnosticPhase;
  code: CustomerDiagnosticCode | null;
  durationMs: number | null;
  relatedRequestId: string | null;
  relatedRequestTrust: "browser_reported" | null;
  ingestRequestId: string;
  receivedAt: string;
}

interface CustomerDiagnosticSegmentMetadata {
  segmentId: string;
  attribution: DiagnosticAttribution;
  subjectId: string | null;
  predecessor: { segmentId: string; relation: "same_tab_pre_auth_context" } | null;
  truncated: boolean;
  nextCursor: string | null;
  sourceHealth: CustomerDiagnosticSourceHealth;
  loss: CustomerDiagnosticLoss;
}

export interface CustomerDiagnosticV1SegmentResult extends CustomerDiagnosticSegmentMetadata {
  contractVersion: "customer-diagnostic-history.v1";
  coverageVersion: "purchase-auth-account.v1";
  events: CustomerDiagnosticLegacyEvent[];
}

export interface CustomerDiagnosticV2SegmentResult extends CustomerDiagnosticSegmentMetadata {
  contractVersion: "customer-diagnostic-history.v2";
  events: CustomerDiagnosticEvent[];
}

export type CustomerDiagnosticSegmentResult = CustomerDiagnosticV1SegmentResult | CustomerDiagnosticV2SegmentResult;

export interface CustomerDiagnosticHistoryPort {
  ingest(input: CustomerDiagnosticStoreInput): Promise<CustomerDiagnosticStoreResult>;
  search(input: CustomerDiagnosticSearchInput): Promise<CustomerDiagnosticSearchResult>;
  readSegment(input: CustomerDiagnosticHistoryInput): Promise<CustomerDiagnosticSegmentResult | null>;
  prune(batchSize: number): Promise<{ eventsDeleted: number; segmentsDeleted: number; limitsDeleted: number; accessDeleted: number }>;
}

export class CustomerDiagnosticConflictError extends Error {
  constructor() { super("customer_diagnostic_event_conflict"); }
}
export class CustomerDiagnosticUnavailableError extends Error {
  constructor() { super("customer_diagnostic_history_unavailable"); }
}

export type CustomerDiagnosticIngestResult =
  | { outcome: "rate_limited" }
  | { outcome: "committed"; segmentCredential: string; deduplicated: boolean };

export async function ingestCustomerDiagnostic(
  port: CustomerDiagnosticHistoryPort,
  request: CustomerDiagnosticIngestRequest,
  context: { principalId: string | null; subjectId: string | null; ingestRequestId: string; abuseKeyHash: string },
  options: { createCredential?: () => string } = {},
): Promise<CustomerDiagnosticIngestResult> {
  const issuedCredential = (options.createCredential ?? defaultCredential)();
  const { segmentCredential: _credential, ...observation } = request;
  const coverageVersion = "coverageVersion" in request ? request.coverageVersion : "purchase-auth-account.v1";
  const fingerprintPayload = {
    clientActionKey: request.clientActionKey ?? null,
    action: request.action,
    phase: request.phase,
    code: request.code ?? null,
    durationMs: request.durationMs ?? null,
    relatedRequestId: request.relatedRequestId ?? null,
  };
  const result = await port.ingest({
    ...observation,
    presentedCredentialHash: request.segmentCredential ? digest(request.segmentCredential) : null,
    issuedCredentialHash: digest(issuedCredential),
    principalId: context.principalId,
    subjectId: context.subjectId,
    ingestRequestId: context.ingestRequestId,
    abuseKeyHash: context.abuseKeyHash,
    payloadFingerprint: digest(JSON.stringify(coverageVersion === "purchase-auth-account.v1"
      ? fingerprintPayload
      : { coverageVersion, ...fingerprintPayload })),
  });
  if (result.outcome === "rate_limited") return { outcome: "rate_limited" };
  const segmentCredential = result.credentialDisposition === "reused"
    ? request.segmentCredential
    : issuedCredential;
  if (!segmentCredential || typeof result.deduplicated !== "boolean") {
    throw new CustomerDiagnosticUnavailableError();
  }
  return { outcome: "committed", segmentCredential, deduplicated: result.deduplicated };
}

function digest(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

function defaultCredential(): string {
  return randomBytes(32).toString("base64url");
}
