import { expect, it } from "vitest";
import { z } from "zod";
import * as schemas from "../../src/risk/index.js";
import type * as contracts from "../../src/risk/contracts/index.js";
// Bidirectional compiler checks prevent independent type-only declarations drifting.
type Equal<A, B> = [
    A
] extends [
    B
] ? [
    B
] extends [
    A
] ? true : false : false;
const equality: [
    Equal<contracts.AdminRiskCasesListRequest, z.infer<typeof schemas.adminRiskCasesListRequestSchema>>,
    Equal<contracts.AdminRiskCasesListResponse, schemas.AdminRiskCasesListResponse>,
    Equal<contracts.AdminRiskCaseDetailResponse, schemas.AdminRiskCaseDetailResponse>,
    Equal<contracts.AdminRiskCaseDecisionRequest, schemas.AdminRiskCaseDecisionRequest>,
    Equal<contracts.AdminRiskCaseDecisionResponse, schemas.AdminRiskCaseDecisionResponse>,
    Equal<contracts.RiskEvaluationResult, schemas.RiskEvaluationResult>,
    Equal<contracts.AdminRiskCaseDetailRequest, schemas.AdminRiskCaseDetailRequest>,
    Equal<contracts.AdminRiskCaseSummary, schemas.AdminRiskCaseSummary>,
    Equal<contracts.AdminRiskCaseDetail, schemas.AdminRiskCaseDetail>,
    Equal<contracts.RiskPaidOrderAssessmentRequest, schemas.RiskPaidOrderAssessmentRequest>
] = [true, true, true, true, true, true, true, true, true, true];
it.each([
    ["defaults/coercion", () => schemas.adminRiskCasesListRequestSchema.parse({ page: "2", search: "  sample  " }), { page: 2, pageSize: 25, search: "sample" }],
    ["page upper bound", () => schemas.adminRiskCasesListRequestSchema.safeParse({ pageSize: 101 }).success, false],
    ["strict list keys", () => schemas.adminRiskCasesListRequestSchema.safeParse({ actorUserId: "injected" }).success, false],
    ["subject hash boundary", () => [16, 128, 15, 129].map(n => schemas.riskSubjectRefSchema.safeParse({ subjectKind: "email", subjectHash: "a".repeat(n) }).success), [true, true, false, false]],
    ["decision note trim and bound", () => [schemas.adminRiskCaseDecisionRequestSchema.parse({ caseId: "10000000-0000-4000-8000-000000000001", idempotencyKey: "case-key", decision: "note", note: "  text  " }).note, schemas.adminRiskCaseDecisionRequestSchema.safeParse({ caseId: "bad", idempotencyKey: "short", decision: "note" }).success], ["text", false]],
    ["checkout subject collection", () => [0, 1, 20, 21].map(n => schemas.riskCheckoutBlocklistRequestSchema.safeParse({ subjectRefs: Array.from({ length: n }, () => ({ subjectKind: "ip", subjectHash: "a".repeat(16) })) }).success), [false, true, true, false]],
    ["score and strict rule evidence", () => [0, 100, -1, 101].map(score => schemas.riskRuleMatchSchema.safeParse({ code: "exact_blocklist_match", score, severity: "high", evidence: { opaque: 1 } }).success), [true, true, false, false]],
    ["type isolation and CSP initialization", () => [equality.every(Boolean), z.config().jitless, schemas.adminRiskCaseDetailRequestSchema.safeParse({ caseId: "10000000-0000-4000-8000-000000000001", extra: true }).success], [true, true, false]],
] as const)("preserves schema boundary: %s", (_name, run, expected) => { expect(run()).toEqual(expected); });
