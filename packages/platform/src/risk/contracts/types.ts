import type { RiskCaseDecision, RiskCaseStatus, RiskDecision, RiskEnforcementMode, RiskReasonCode, RiskSeverity, RiskSubjectKind, RiskEvaluationOutput, } from "@openlup/core/risk";
/** Output shapes of the unchanged risk.v1 schemas. */
export type RiskEvaluationResult = RiskEvaluationOutput & {
    contractVersion: "risk.v1";
    rulesetVersion: "risk-rules.v1";
};
export interface AdminRiskCaseSummary {
    id: string;
    status: RiskCaseStatus;
    severity: RiskSeverity;
    decision: RiskDecision;
    score: number;
    reasonCodes: RiskReasonCode[];
    orderId: string | null;
    clientId: string | null;
    paymentIntentId: string | null;
    holdId: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface AdminRiskCaseDetail extends AdminRiskCaseSummary {
    assessmentId: string;
    subjectRefs: Array<{
        subjectKind: RiskSubjectKind;
        subjectHash: string;
    }>;
    evidence: Record<string, unknown>;
    matchedRules: RiskEvaluationOutput["matchedRules"];
    events: Array<{
        id: string;
        caseId: string;
        eventType: string;
        actorUserId: string | null;
        note: string | null;
        occurredAt: string;
    }>;
    actionEligibility: Record<RiskCaseDecision, {
        allowed: boolean;
        reason: string | null;
    }>;
}
export interface AdminRiskCasesListRequest {
    page: number;
    pageSize: number;
    status?: RiskCaseStatus;
    severity?: RiskSeverity;
    orderId?: string;
    search?: string;
}
export interface AdminRiskCasesListResponse {
    contractVersion: "risk.v1";
    cases: AdminRiskCaseSummary[];
    totalCount: number;
    summaryCounts: {
        open: number;
        inReview: number;
        highSeverity: number;
        blocked: number;
    };
}
export interface AdminRiskCaseDetailRequest {
    caseId: string;
}
export interface AdminRiskCaseDetailResponse {
    contractVersion: "risk.v1";
    case: AdminRiskCaseDetail;
}
export interface AdminRiskCaseDecisionRequest {
    caseId: string;
    idempotencyKey: string;
    decision: RiskCaseDecision;
    note?: string;
}
export interface AdminRiskCaseDecisionResponse extends AdminRiskCaseDetailResponse {
    replayed: boolean;
}
export interface RiskPaidOrderAssessmentRequest {
    orderId: string;
    paymentIntentId: string | null;
    paymentEventId: string | null;
    mode: RiskEnforcementMode;
    evaluation: RiskEvaluationResult;
    subjectRefs: Array<{
        subjectKind: RiskSubjectKind;
        subjectHash: string;
    }>;
    evidence: Record<string, unknown>;
    occurredAt: string;
}
