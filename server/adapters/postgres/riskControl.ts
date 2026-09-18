import type {
  AdminRiskCaseDetail,
  AdminRiskCaseDetailResponse,
  AdminRiskCasesListResponse,
  AdminRiskCaseSummary,
} from "../../../src/domains/risk/contracts.js";
import type {
  RiskAdminReadPort,
  RiskAdminWritePort,
  RiskAssessmentWritePort,
  RiskCheckoutBlocklistPort,
} from "../../../src/domains/risk/ports.js";
import { RISK_CONTRACT_VERSION } from "../../../src/domains/risk/types.js";
import {
  createOrderPaidRiskAssessmentPort,
  type OrderPaidRiskAssessmentPort,
  type RiskOrderEvidence,
  type RiskPaidOrderEvidencePort,
} from "../../domains/risk/orderPaidRiskPort.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

type Row = Record<string, unknown>;

export function createPostgresRiskControlPorts(
  executor: PgQueryExecutor,
  options: { mode: "shadow" | "hold"; hashSecret?: string | null },
): {
  adminPort: RiskAdminReadPort & RiskAdminWritePort;
  assessmentPort: OrderPaidRiskAssessmentPort;
} {
  const evidencePort = createEvidencePort(executor);
  const assessmentWritePort = createAssessmentWritePort(executor);
  const blocklistPort = createBlocklistPort(executor);
  return {
    adminPort: createAdminPort(executor),
    assessmentPort: createOrderPaidRiskAssessmentPort({
      evidencePort,
      assessmentPort: assessmentWritePort,
      blocklistPort,
      mode: options.mode,
      hashSecret: options.hashSecret,
    }),
  };
}

function createEvidencePort(executor: PgQueryExecutor): RiskPaidOrderEvidencePort {
  return {
    async readOrder(orderId): Promise<RiskOrderEvidence | null> {
      const { rows } = await executor.query(
        `SELECT id, client_id, total_amount_minor, currency_code, metadata
           FROM commerce_orders WHERE id = $1`,
        [orderId],
      );
      const row = rows[0];
      if (!row) return null;
      const total = numberOrNull(row.total_amount_minor);
      return {
        id: string(row.id),
        clientId: nullableString(row.client_id),
        subtotalCents: total,
        discountCents: 0,
        shippingCents: 0,
        shippingDiscountCents: 0,
        taxCents: 0,
        totalCents: total,
        currency: nullableString(row.currency_code),
        mode: record(row.metadata).mode === "subscription_cycle" ? "subscription_cycle" : "one_time",
        metadata: record(row.metadata),
      };
    },
    async readSucceededPaymentIntent(orderId) {
      const { rows } = await executor.query(
        `SELECT id, amount_minor, currency_code
           FROM commerce_settlement_intents
          WHERE order_id = $1 AND status = 'settled'
          ORDER BY settled_at DESC LIMIT 1`,
        [orderId],
      );
      const row = rows[0];
      return row
        ? {
            id: string(row.id),
            amountCents: number(row.amount_minor),
            currency: string(row.currency_code),
          }
        : null;
    },
  };
}

function createBlocklistPort(executor: PgQueryExecutor): RiskCheckoutBlocklistPort {
  return {
    async checkExactBlocklist(input) {
      const result = await rpc(executor, "risk_check_exact_blocklist", {
        p_subject_refs: input.subjectRefs.map((ref) => ({
          subjectKind: ref.subjectKind,
          subjectHash: ref.subjectHash,
        })),
      });
      const value = record(result);
      return {
        blocked: value.blocked === true,
        reasonCodes: strings(value.reasonCodes),
      };
    },
  };
}

function createAssessmentWritePort(executor: PgQueryExecutor): RiskAssessmentWritePort {
  return {
    async assessPaidOrder(request) {
      const value = record(await rpc(executor, "risk_assess_paid_order", {
        p_idempotency_key: request.idempotencyKey,
        p_order_id: request.orderId,
        p_payment_intent_id: request.paymentIntentId,
        p_payment_event_id: request.paymentEventId,
        p_mode: request.mode,
        p_evaluation: request.evaluation,
        p_subject_refs: request.subjectRefs,
        p_evidence: request.evidence,
        p_occurred_at: request.occurredAt,
      }));
      return {
        assessmentId: string(value.assessmentId),
        caseId: nullableString(value.caseId),
        holdId: nullableString(value.holdId),
        decision: string(value.decision) as "allow" | "manual_review" | "block",
        holdOpened: value.holdOpened === true,
        replayed: value.replayed === true,
      };
    },
  };
}

function createAdminPort(executor: PgQueryExecutor): RiskAdminReadPort & RiskAdminWritePort {
  const getCaseDetail = (caseId: string) => readCaseDetail(executor, caseId);
  return {
    async listCases(request) {
      const values: unknown[] = [];
      const filters: string[] = [];
      const add = (clause: string, value: unknown) => {
        values.push(value);
        filters.push(clause.replace("?", `$${values.length}`));
      };
      if (request.status) add("status = ?", request.status);
      if (request.severity) add("severity = ?", request.severity);
      if (request.orderId) add("order_id = ?", request.orderId);
      if (request.search) {
        values.push(request.search);
        filters.push(`(id::text = $${values.length} OR order_id::text = $${values.length})`);
      }
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      values.push(request.pageSize, (request.page - 1) * request.pageSize);
      const { rows } = await executor.query(
        `SELECT *, count(*) OVER() AS exact_count
           FROM risk_manual_review_cases ${where}
          ORDER BY updated_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      );
      const cases = rows.map(mapSummary);
      return {
        contractVersion: RISK_CONTRACT_VERSION,
        cases,
        totalCount: rows[0] ? number(rows[0].exact_count) : 0,
        summaryCounts: summarize(cases),
      } satisfies AdminRiskCasesListResponse;
    },
    getCaseDetail(request) {
      return getCaseDetail(request.caseId);
    },
    async decideCase(request) {
      const result = record(await rpc(executor, "risk_resolve_manual_review_case", {
        p_idempotency_key: request.idempotencyKey,
        p_case_id: request.caseId,
        p_decision: request.decision,
        p_actor_user_id: request.actorUserId,
        p_note: request.note ?? null,
        p_metadata: {},
      }));
      const detail = await getCaseDetail(request.caseId);
      if (!detail) throw new Error("risk_case_not_found_after_decision");
      return { ...detail, replayed: result.replayed === true };
    },
  };
}

async function readCaseDetail(
  executor: PgQueryExecutor,
  caseId: string,
): Promise<AdminRiskCaseDetailResponse | null> {
  const { rows } = await executor.query(
    `SELECT c.*, a.subject_refs, a.evidence, a.matched_rules
       FROM risk_manual_review_cases c
       JOIN risk_assessments a ON a.id = c.assessment_id
      WHERE c.id = $1`,
    [caseId],
  );
  if (!rows[0]) return null;
  const { rows: eventRows } = await executor.query(
    `SELECT * FROM risk_case_events WHERE case_id = $1 ORDER BY occurred_at DESC LIMIT 101`,
    [caseId],
  );
  const row = rows[0];
  const status = string(row.status);
  const active = ["open", "in_review", "escalated"].includes(status);
  const detail: AdminRiskCaseDetail = {
    ...mapSummary(row),
    assessmentId: string(row.assessment_id),
    subjectRefs: array(row.subject_refs) as AdminRiskCaseDetail["subjectRefs"],
    evidence: record(row.evidence),
    matchedRules: array(row.matched_rules) as AdminRiskCaseDetail["matchedRules"],
    events: eventRows.map((event) => ({
      id: string(event.id),
      caseId: string(event.case_id),
      eventType: string(event.event_type),
      actorUserId: nullableString(event.actor_user_id),
      note: nullableString(event.note),
      occurredAt: date(event.occurred_at),
    })),
    actionEligibility: {
      approve: { allowed: active, reason: active ? null : "case_closed" },
      block: { allowed: active, reason: active ? null : "case_closed" },
      escalate: { allowed: active, reason: active ? null : "case_closed" },
      note: { allowed: true, reason: null },
    },
  };
  return { contractVersion: RISK_CONTRACT_VERSION, case: detail };
}

function mapSummary(row: Row): AdminRiskCaseSummary {
  return {
    id: string(row.id), status: string(row.status) as AdminRiskCaseSummary["status"],
    severity: string(row.severity) as AdminRiskCaseSummary["severity"],
    decision: string(row.decision) as AdminRiskCaseSummary["decision"], score: number(row.risk_score),
    reasonCodes: strings(row.reason_codes) as AdminRiskCaseSummary["reasonCodes"],
    orderId: nullableString(row.order_id), clientId: nullableString(row.client_id),
    paymentIntentId: nullableString(row.payment_intent_id), holdId: nullableString(row.hold_id),
    createdAt: date(row.opened_at), updatedAt: date(row.updated_at),
  };
}

function summarize(cases: AdminRiskCaseSummary[]) {
  return {
    open: cases.filter((entry) => entry.status === "open").length,
    inReview: cases.filter((entry) => entry.status === "in_review").length,
    highSeverity: cases.filter((entry) => ["high", "critical"].includes(entry.severity)).length,
    blocked: cases.filter((entry) => entry.status === "blocked").length,
  };
}

async function rpc(executor: PgQueryExecutor, name: string, args: Record<string, unknown>) {
  const keys = Object.keys(args);
  const call = keys.map((key, index) => `"${key}" => $${index + 1}`).join(", ");
  const { rows } = await executor.query(`SELECT ${name}(${call}) AS value`, keys.map((key) => parameter(args[key])));
  return rows[0]?.value;
}

function record(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function strings(value: unknown): string[] { return array(value).filter((item): item is string => typeof item === "string"); }
function string(value: unknown): string { if (typeof value !== "string" || !value) throw new Error("invalid_risk_response"); return value; }
function nullableString(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function number(value: unknown): number { const parsed = Number(value); if (!Number.isFinite(parsed)) throw new Error("invalid_risk_response"); return parsed; }
function numberOrNull(value: unknown): number | null { return value === null || value === undefined ? null : number(value); }
function date(value: unknown): string { return value instanceof Date ? value.toISOString() : string(value); }
function parameter(value: unknown): unknown {
  return value !== null && typeof value === "object" ? JSON.stringify(value) : value;
}
