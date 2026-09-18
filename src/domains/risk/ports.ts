import type {
  AdminRiskCaseDecisionRequest,
  AdminRiskCaseDecisionResponse,
  AdminRiskCaseDetailRequest,
  AdminRiskCaseDetailResponse,
  AdminRiskCasesListRequest,
  AdminRiskCasesListResponse,
  RiskPaidOrderAssessmentRequest,
} from "./contracts.js";

export interface RiskAdminReadPort {
  listCases(request: AdminRiskCasesListRequest): Promise<AdminRiskCasesListResponse>;
  getCaseDetail(request: AdminRiskCaseDetailRequest): Promise<AdminRiskCaseDetailResponse | null>;
}

export interface RiskAdminWritePort {
  decideCase(request: AdminRiskCaseDecisionRequest & { actorUserId: string }): Promise<AdminRiskCaseDecisionResponse>;
}

export interface RiskAssessmentWritePort {
  assessPaidOrder(request: RiskPaidOrderAssessmentRequest & { idempotencyKey: string }): Promise<{
    assessmentId: string;
    caseId: string | null;
    holdId: string | null;
    decision: "allow" | "manual_review" | "block";
    holdOpened: boolean;
    replayed: boolean;
  }>;
}

export interface RiskCheckoutBlocklistPort {
  checkExactBlocklist(input: {
    subjectRefs: Array<{ subjectKind: string; subjectHash: string }>;
  }): Promise<{ blocked: boolean; reasonCodes: string[] }>;
}
