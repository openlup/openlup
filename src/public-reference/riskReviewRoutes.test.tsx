import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createBffResponder } from "@openlup/platform/bff";
import type { HttpRequest, HttpResponse } from "@openlup/platform/http";
import { createRiskBindings } from "@openlup/platform/risk/server";
import type { AdminRiskCaseDetail } from "../domains/risk/contracts";
import { getAdminRiskCases, getAdminRiskCaseDetail, decideAdminRiskCase } from "../domains/risk/riskClient";
import { RiskCaseDetailPanel } from "../pages/admin/RiskReviewPageParts";

const caseId = "11111111-1111-4111-8111-111111111111";
const riskCase: AdminRiskCaseDetail = {
  id: caseId, assessmentId: "22222222-2222-4222-8222-222222222222", status: "escalated", severity: "high",
  decision: "manual_review", score: 60, reasonCodes: [], orderId: null, clientId: null, paymentIntentId: null, holdId: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", subjectRefs: [], evidence: { sanitized: true }, matchedRules: [], events: [],
  actionEligibility: { approve: { allowed: true, reason: null }, block: { allowed: true, reason: null }, escalate: { allowed: true, reason: null }, note: { allowed: true, reason: null } },
};
function fixture() {
  const authorizeAdmin = vi.fn(async (req: HttpRequest) => req.headers.authorization === "Bearer synthetic-token"
    ? { ok: true as const, userId: "33333333-3333-4333-8333-333333333333" }
    : { ok: false as const, code: "UNAUTHORIZED" as const, message: "Session required" });
  const adminPort = {
    listCases: vi.fn(async () => ({ contractVersion: "risk.v1" as const, cases: [], totalCount: 0, summaryCounts: { open: 0, inReview: 0, highSeverity: 0, blocked: 0 } })),
    getCaseDetail: vi.fn(async () => ({ contractVersion: "risk.v1" as const, case: riskCase })),
    decideCase: vi.fn(async () => ({ contractVersion: "risk.v1" as const, case: riskCase, replayed: false })),
  };
  const handlers = createRiskBindings({ respond: createBffResponder(), authorizeAdmin, adminPort,
    mutationsEnabled: () => false, assessmentPort: { assessPaidOrder: async () => ({ kind: "allow" }) } });
  // A synthetic transport calls selected handlers without mounting the public router.
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://reference.example.test");
    const name = url.pathname.endsWith("/decision") ? "decision" : url.pathname.endsWith("/detail") ? "detail" : "list";
    let status = 200; let body: unknown;
    const res = { setHeader() {}, status(code: number) { status = code; return res; }, json(value: unknown) { body = value; return res; } } as unknown as HttpResponse;
    await handlers[name]({ method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers)),
      query: Object.fromEntries(url.searchParams), body: init?.body ? JSON.parse(String(init.body)) : undefined } as HttpRequest, res);
    return new Response(JSON.stringify(body), { status });
  });
  return { fetcher, adminPort, authorizeAdmin };
}

it("browser list client reaches the delegated handler with typed filters and trusted bearer", async () => {
  const f = fixture();
  await expect(getAdminRiskCases("synthetic-token", { page: 2, pageSize: 10, severity: "high", search: " synthetic " }, { fetcher: f.fetcher })).resolves.toMatchObject({ totalCount: 0 });
  expect(f.adminPort.listCases).toHaveBeenCalledExactlyOnceWith({ page: 2, pageSize: 10, severity: "high", search: "synthetic" });
  expect(f.authorizeAdmin).toHaveBeenCalledTimes(1);
});

it("browser detail client preserves the server eligibility even when the UI status disagrees", async () => {
  const f = fixture();
  await expect(getAdminRiskCaseDetail("synthetic-token", caseId, { fetcher: f.fetcher })).resolves.toEqual({ contractVersion: "risk.v1", case: riskCase });
  expect(f.adminPort.getCaseDetail).toHaveBeenCalledExactlyOnceWith({ caseId });
});

it("browser decision client preserves mutation refusal and causes no write", async () => {
  const f = fixture();
  await expect(decideAdminRiskCase("synthetic-token", { caseId, idempotencyKey: "synthetic-key", decision: "approve" }, { fetcher: f.fetcher })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  expect(f.adminPort.decideCase).not.toHaveBeenCalled();
});

it("captured escalated UI disables every action despite allowed server eligibility", () => {
  const onDecision = vi.fn();
  render(<RiskCaseDetailPanel riskCase={riskCase} loading={false} error={false} note="Synthetic note"
    onNoteChange={() => {}} onDecision={onDecision} busy={false} mutationError={false} />);
  for (const name of ["Approve", "Block", "Escalate", "Note"]) {
    const button = screen.getByRole("button", { name: new RegExp(name) });
    expect(button).toBeDisabled(); fireEvent.click(button);
  }
  expect(onDecision).not.toHaveBeenCalled();
});
