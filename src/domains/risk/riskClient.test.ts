import { describe, expect, it, vi } from "vitest";
import { RISK_CONTRACT_VERSION } from "./types";
import { decideAdminRiskCase, getAdminRiskCaseDetail, getAdminRiskCases } from "./riskClient";

const CASE_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_ID = "33333333-3333-4333-8333-333333333333";
const ASSESSMENT_ID = "44444444-4444-4444-8444-444444444444";
type TestFetcher = ReturnType<typeof createFetcher>;

describe("risk BFF client", () => {
  it("reads admin risk cases with bearer auth and typed query params", async () => {
    const fetcher = createFetcher(listResponse());

    await expect(
      getAdminRiskCases("token", { page: 2, pageSize: 25, status: "open" }, { fetcher }),
    ).resolves.toMatchObject({ cases: [{ status: "open", score: 82 }] });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/admin/risk/cases?page=2&pageSize=25&status=open",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(readAuth(fetcher)).toBe("Bearer token");
  });

  it("reads admin risk case detail", async () => {
    const fetcher = createFetcher(detailResponse());

    await expect(getAdminRiskCaseDetail("token", CASE_ID, { fetcher })).resolves.toMatchObject({
      case: { assessmentId: ASSESSMENT_ID, matchedRules: [{ code: "exact_blocklist_match" }] },
    });
  });

  it("posts manual-review decisions through the typed mutation endpoint", async () => {
    const fetcher = createFetcher({ ...detailResponse(), replayed: false });

    await expect(
      decideAdminRiskCase(
        "token",
        {
          caseId: CASE_ID,
          idempotencyKey: "risk-decision-1",
          decision: "approve",
          note: "Evidence checked",
        },
        { fetcher },
      ),
    ).resolves.toMatchObject({ replayed: false, case: { status: "open" } });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/admin/risk/cases/decision",
      expect.objectContaining({ method: "POST" }),
    );
    expect(readAuth(fetcher)).toBe("Bearer token");
  });
});

function listResponse() {
  return {
    contractVersion: RISK_CONTRACT_VERSION,
    cases: [caseSummary()],
    totalCount: 1,
    summaryCounts: {
      open: 1,
      inReview: 0,
      highSeverity: 1,
      blocked: 0,
    },
  };
}

function detailResponse() {
  return {
    contractVersion: RISK_CONTRACT_VERSION,
    case: {
      ...caseSummary(),
      assessmentId: ASSESSMENT_ID,
      subjectRefs: [{ subjectKind: "email", subjectHash: "hashed-email-value" }],
      evidence: { sanitized: true },
      matchedRules: [
        {
          code: "exact_blocklist_match",
          score: 100,
          severity: "critical",
          evidence: { matchCount: 1 },
        },
      ],
      events: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          caseId: CASE_ID,
          eventType: "opened",
          actorUserId: null,
          note: null,
          occurredAt: "2026-06-16T12:00:00.000Z",
        },
      ],
      actionEligibility: {
        approve: { allowed: true, reason: null },
        block: { allowed: true, reason: null },
        escalate: { allowed: true, reason: null },
        note: { allowed: true, reason: null },
      },
    },
  };
}

function caseSummary() {
  return {
    id: CASE_ID,
    status: "open",
    severity: "critical",
    decision: "block",
    score: 82,
    reasonCodes: ["exact_blocklist_match"],
    orderId: ORDER_ID,
    clientId: "66666666-6666-4666-8666-666666666666",
    paymentIntentId: "77777777-7777-4777-8777-777777777777",
    holdId: "88888888-8888-4888-8888-888888888888",
    createdAt: "2026-06-16T12:00:00.000Z",
    updatedAt: "2026-06-16T12:05:00.000Z",
  };
}

function createFetcher(data: unknown) {
  return vi.fn(async () => new Response(JSON.stringify({ ok: true, data }), { status: 200 }));
}

function readAuth(fetcher: TestFetcher): string | null {
  const calls = fetcher.mock.calls as unknown as Array<[string, RequestInit]>;
  const headers = calls[0]?.[1]?.headers;
  return headers instanceof Headers ? headers.get("authorization") : null;
}
