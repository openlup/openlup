import {
  type AdminRiskCaseDetail,
  type AdminRiskCaseDetailResponse,
  type AdminRiskCasesListResponse,
  type AdminRiskCaseSummary,
} from "../../../src/domains/risk/contracts.js";
import { RISK_CONTRACT_VERSION } from "../../../src/domains/risk/types.js";
import type { RiskAdminReadPort, RiskAdminWritePort } from "../../../src/domains/risk/ports.js";

interface RiskQueryBuilder {
  select(columns: string, options?: { count?: "exact" }): RiskQueryBuilder;
  eq(column: string, value: unknown): RiskQueryBuilder;
  or(filter: string): RiskQueryBuilder;
  order(column: string, options: { ascending: boolean }): RiskQueryBuilder;
  range(from: number, to: number): PromiseLike<{ data: unknown; error: unknown | null; count?: number | null }>;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown | null }>;
}

export interface RiskAdminSupabaseClient {
  from(table: string): RiskQueryBuilder;
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown | null }>;
}

export function createSupabaseRiskAdminPort(
  client: RiskAdminSupabaseClient,
): RiskAdminReadPort & RiskAdminWritePort {
  return {
    async listCases(request) {
      let query = client
        .from("risk_manual_review_cases")
        .select("*", { count: "exact" })
        .order("updated_at", { ascending: false });
      if (request.status) query = query.eq("status", request.status);
      if (request.severity) query = query.eq("severity", request.severity);
      if (request.orderId) query = query.eq("order_id", request.orderId);
      if (request.search) {
        query = query.or(`id.eq.${request.search},order_id.eq.${request.search}`);
      }
      const from = (request.page - 1) * request.pageSize;
      const to = from + request.pageSize - 1;
      const { data, error, count } = await query.range(from, to);
      if (error) throw error;

      const cases = Array.isArray(data) ? data.map(mapCaseSummary) : [];
      return {
        contractVersion: RISK_CONTRACT_VERSION,
        cases,
        totalCount: count ?? cases.length,
        summaryCounts: summarize(cases),
      };
    },

    async getCaseDetail(request) {
      return readCaseDetail(client, request.caseId);
    },

    async decideCase(request) {
      const { error } = await client.rpc("risk_resolve_manual_review_case", {
        p_idempotency_key: request.idempotencyKey,
        p_case_id: request.caseId,
        p_decision: request.decision,
        p_actor_user_id: request.actorUserId,
        p_note: request.note ?? null,
        p_metadata: {},
      });
      if (error) throw error;
      const detail = await readCaseDetail(client, request.caseId);
      if (!detail) throw new Error("risk_case_not_found_after_decision");
      return { ...detail, replayed: false };
    },
  };
}

async function readCaseDetail(
  client: RiskAdminSupabaseClient,
  caseId: string,
): Promise<AdminRiskCaseDetailResponse | null> {
  const { data: caseData, error: caseError } = await client
    .from("risk_manual_review_cases")
    .select("*")
    .eq("id", caseId)
    .maybeSingle();
  if (caseError) throw caseError;
  if (!caseData || typeof caseData !== "object") return null;
  const row = caseData as Record<string, unknown>;

  const assessmentId = readString(row.assessment_id);
  const { data: assessmentData, error: assessmentError } = await client
    .from("risk_assessments")
    .select("*")
    .eq("id", assessmentId)
    .maybeSingle();
  if (assessmentError) throw assessmentError;
  const assessment = assessmentData && typeof assessmentData === "object"
    ? (assessmentData as Record<string, unknown>)
    : {};

  const { data: eventData, error: eventError } = await client
    .from("risk_case_events")
    .select("*")
    .eq("case_id", caseId)
    .order("occurred_at", { ascending: false })
    .range(0, 100);
  if (eventError) throw eventError;

  const detail: AdminRiskCaseDetail = {
    ...mapCaseSummary(row),
    assessmentId,
    subjectRefs: Array.isArray(assessment.subject_refs) ? assessment.subject_refs as AdminRiskCaseDetail["subjectRefs"] : [],
    evidence: isRecord(assessment.evidence) ? assessment.evidence : {},
    matchedRules: Array.isArray(assessment.matched_rules) ? assessment.matched_rules as AdminRiskCaseDetail["matchedRules"] : [],
    events: Array.isArray(eventData) ? eventData.map(mapEvent) : [],
    actionEligibility: actionEligibility(readString(row.status)),
  };

  return { contractVersion: RISK_CONTRACT_VERSION, case: detail };
}

function mapCaseSummary(value: unknown): AdminRiskCaseSummary {
  const row = value as Record<string, unknown>;
  return {
    id: readString(row.id),
    status: readString(row.status) as AdminRiskCaseSummary["status"],
    severity: readString(row.severity) as AdminRiskCaseSummary["severity"],
    decision: readString(row.decision) as AdminRiskCaseSummary["decision"],
    score: readNumber(row.risk_score),
    reasonCodes: readStringArray(row.reason_codes) as AdminRiskCaseSummary["reasonCodes"],
    orderId: readNullableString(row.order_id),
    clientId: readNullableString(row.client_id),
    paymentIntentId: readNullableString(row.payment_intent_id),
    holdId: readNullableString(row.hold_id),
    createdAt: readString(row.opened_at),
    updatedAt: readString(row.updated_at),
  };
}

function mapEvent(value: unknown): AdminRiskCaseDetail["events"][number] {
  const row = value as Record<string, unknown>;
  return {
    id: readString(row.id),
    caseId: readString(row.case_id),
    eventType: readString(row.event_type),
    actorUserId: readNullableString(row.actor_user_id),
    note: readNullableString(row.note),
    occurredAt: readString(row.occurred_at),
  };
}

function summarize(cases: AdminRiskCaseSummary[]): AdminRiskCasesListResponse["summaryCounts"] {
  return {
    open: cases.filter((entry) => entry.status === "open").length,
    inReview: cases.filter((entry) => entry.status === "in_review").length,
    highSeverity: cases.filter((entry) => entry.severity === "high" || entry.severity === "critical").length,
    blocked: cases.filter((entry) => entry.status === "blocked").length,
  };
}

function actionEligibility(status: string): AdminRiskCaseDetail["actionEligibility"] {
  const active = status === "open" || status === "in_review" || status === "escalated";
  return {
    approve: { allowed: active, reason: active ? null : "case_closed" },
    block: { allowed: active, reason: active ? null : "case_closed" },
    escalate: { allowed: active, reason: active ? null : "case_closed" },
    note: { allowed: true, reason: null },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Invalid risk admin row");
  return value;
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
