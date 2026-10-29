import { describe, expect, it, vi } from "vitest";
import { createBffResponder } from "../../src/bff/index.js";
import type { HttpRequest, HttpResponse } from "../../src/http/index.js";
import type { AdminRiskCaseDetailResponse, AdminRiskCasesListResponse } from "../../src/risk/contracts/index.js";
import { createRiskBindings } from "../../src/risk/server/index.js";

const caseId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const at = "2026-01-01T00:00:00.000Z";
const summary = {
  id: caseId, status: "open" as const, severity: "high" as const, decision: "manual_review" as const,
  score: 60, reasonCodes: ["exact_blocklist_match" as const], orderId: null, clientId: null,
  paymentIntentId: null, holdId: null, createdAt: at, updatedAt: at,
};
const detail: AdminRiskCaseDetailResponse = {
  contractVersion: "risk.v1", case: {
    ...summary, assessmentId: "33333333-3333-4333-8333-333333333333", subjectRefs: [],
    evidence: { sanitized: true }, matchedRules: [], events: [{
      id: "44444444-4444-4444-8444-444444444444", caseId, actorUserId: actorId,
      eventType: "note", note: "Synthetic review", occurredAt: at,
    }],
    actionEligibility: {
      approve: { allowed: true, reason: null }, block: { allowed: true, reason: null },
      escalate: { allowed: true, reason: null }, note: { allowed: true, reason: null },
    },
  },
};
const list: AdminRiskCasesListResponse = {
  contractVersion: "risk.v1", cases: [summary], totalCount: 11,
  summaryCounts: { open: 1, inReview: 0, highSeverity: 1, blocked: 0 },
};
function fixture() {
  const adminPort = {
    listCases: vi.fn(async () => list),
    getCaseDetail: vi.fn(async (): Promise<AdminRiskCaseDetailResponse | null> => detail),
    decideCase: vi.fn(async () => ({ ...detail, replayed: false })),
  };
  const authorizeAdmin = vi.fn(async (): Promise<import("../../src/risk/server/index.js").RiskAdminAuthorization> => ({ ok: true, userId: actorId }));
  const mutationsEnabled = vi.fn(() => true);
  const bound = createRiskBindings({ adminPort, authorizeAdmin, mutationsEnabled,
    respond: createBffResponder({ responseRequestId: () => "synthetic-request" }),
    assessmentPort: { assessPaidOrder: async () => ({ kind: "allow" }) },
  });
  const headers: Record<string, unknown> = {};
  const output: { status: number; body: unknown } = { status: 200, body: undefined };
  const res = {
    setHeader(name: string, value: unknown) { headers[name] = value; },
    status(code: number) { output.status = code; return res; },
    json(body: unknown) { output.body = body; return res; },
  } as unknown as HttpResponse;
  async function call(name: "list" | "detail" | "decision", input?: Record<string, unknown>) {
    const query = name === "detail" ? { caseId } : {};
    const body = { caseId, decision: "note", idempotencyKey: "synthetic-decision" };
    await bound[name]({ method: name === "decision" ? "POST" : "GET", query, body, ...input } as unknown as HttpRequest, res);
  }
  function error(status: number, code: string, message: string) {
    expect(output.status).toBe(status);
    expect(output.body).toMatchObject({ ok: false, error: { code, message }, meta: { requestId: "synthetic-request" } });
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(headers["x-request-id"]).toBe("synthetic-request");
  }
  return { adminPort, authorizeAdmin, mutationsEnabled, output, call, error };
}

describe("captured admin workflow beyond the five reference guards", () => {
  it("list forwards a host forbidden response before validation or reads", async () => {
    const f = fixture();
    f.authorizeAdmin.mockResolvedValue({ ok: false, code: "FORBIDDEN", message: "Operator scope required" });
    await f.call("list", { query: { unknown: true } });
    f.error(403, "FORBIDDEN", "Operator scope required");
    expect(f.adminPort.listCases).not.toHaveBeenCalled();
  });
  it("list maps a throwing authorizer to unavailable", async () => {
    const f = fixture(); f.authorizeAdmin.mockRejectedValue(new Error("synthetic authorization fault"));
    await f.call("list"); f.error(503, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    expect(f.adminPort.listCases).not.toHaveBeenCalled();
  });
  it("list rejects invalid pagination with field details before reading", async () => {
    const f = fixture(); await f.call("list", { query: { page: "0" } });
    f.error(400, "BAD_REQUEST", "Invalid risk cases request");
    expect(f.output.body).toMatchObject({ error: { details: { fieldErrors: { page: expect.any(Array) } } } });
    expect(f.adminPort.listCases).not.toHaveBeenCalled();
  });
  it("list treats malformed port output as upstream unavailable", async () => {
    const f = fixture(); f.adminPort.listCases.mockResolvedValue({ ...list, totalCount: -1 });
    await f.call("list"); f.error(503, "UPSTREAM_UNAVAILABLE", "Risk cases read failed");
  });
  it("list coerces pagination and preserves filters, counts and response", async () => {
    const f = fixture();
    await f.call("list", { query: { page: "2", pageSize: "5", status: "in_review", severity: "high", search: " synthetic " } });
    expect(f.adminPort.listCases).toHaveBeenCalledExactlyOnceWith({ page: 2, pageSize: 5, status: "in_review", severity: "high", search: "synthetic" });
    expect(f.output.body).toEqual({ ok: true, data: list });
  });
  it("detail refuses an unauthenticated caller before reading", async () => {
    const f = fixture(); f.authorizeAdmin.mockResolvedValue({ ok: false, code: "UNAUTHORIZED", message: "Session required" });
    await f.call("detail"); f.error(401, "UNAUTHORIZED", "Session required");
    expect(f.adminPort.getCaseDetail).not.toHaveBeenCalled();
  });
  it("detail rejects an invalid case identity before reading", async () => {
    const f = fixture(); await f.call("detail", { query: { caseId: "invalid" } });
    f.error(400, "BAD_REQUEST", "Invalid risk case detail request");
    expect(f.adminPort.getCaseDetail).not.toHaveBeenCalled();
  });
  it("detail maps a missing case to not found", async () => {
    const f = fixture(); f.adminPort.getCaseDetail.mockResolvedValue(null);
    await f.call("detail"); f.error(404, "NOT_FOUND", "Risk case not found");
  });
  it("detail masks a read failure without exposing adapter prose", async () => {
    const f = fixture(); f.adminPort.getCaseDetail.mockRejectedValue(new Error("synthetic persistence fault"));
    await f.call("detail"); f.error(503, "UPSTREAM_UNAVAILABLE", "Risk case detail failed");
  });
  it("detail retains event history, evidence and action eligibility", async () => {
    const f = fixture(); await f.call("detail");
    expect(f.adminPort.getCaseDetail).toHaveBeenCalledExactlyOnceWith({ caseId });
    expect(f.output.body).toEqual({ ok: true, data: detail });
  });
  it("decision authorizes before consulting mutation enablement", async () => {
    const f = fixture(); f.authorizeAdmin.mockResolvedValue({ ok: false, code: "FORBIDDEN", message: "Operator scope required" });
    await f.call("decision"); f.error(403, "FORBIDDEN", "Operator scope required");
    expect(f.mutationsEnabled).not.toHaveBeenCalled(); expect(f.adminPort.decideCase).not.toHaveBeenCalled();
  });
  it("decision masks authorization faults before mutation policy", async () => {
    const f = fixture(); f.authorizeAdmin.mockRejectedValue(new Error("synthetic authorization fault"));
    await f.call("decision"); f.error(503, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    expect(f.mutationsEnabled).not.toHaveBeenCalled(); expect(f.adminPort.decideCase).not.toHaveBeenCalled();
  });
  it("decision rejects a caller supplied actor rather than accepting an override", async () => {
    const f = fixture(); await f.call("decision", { body: { caseId, decision: "note", idempotencyKey: "synthetic-decision", actorUserId: caseId } });
    f.error(400, "BAD_REQUEST", "Invalid risk decision request"); expect(f.adminPort.decideCase).not.toHaveBeenCalled();
  });
  it("decision keeps adapter conflicts as the captured upstream failure", async () => {
    const f = fixture(); f.adminPort.decideCase.mockRejectedValue(new Error("risk_idempotency_conflict"));
    await f.call("decision"); f.error(503, "UPSTREAM_UNAVAILABLE", "Risk decision failed");
  });
  it("decision rejects malformed mutation output after the port call", async () => {
    const f = fixture(); f.adminPort.decideCase.mockResolvedValue({ ...detail, replayed: "true" } as never);
    await f.call("decision"); f.error(503, "UPSTREAM_UNAVAILABLE", "Risk decision failed");
    expect(f.adminPort.decideCase).toHaveBeenCalledTimes(1);
  });
  // Each decision is an independent case, preserving key/note/actor and the rail's projection.
  it.each(["approve", "block", "escalate", "note"] as const)("%s uses the trusted actor and preserves the response replay field", async decision => {
    const f = fixture(); const replayed = decision === "note";
    f.adminPort.decideCase.mockResolvedValue({ ...detail, replayed });
    await f.call("decision", { body: { caseId, decision, idempotencyKey: "synthetic-decision", note: "  Synthetic review  " } });
    expect(f.adminPort.decideCase).toHaveBeenCalledExactlyOnceWith({ caseId, decision, idempotencyKey: "synthetic-decision", note: "Synthetic review", actorUserId: actorId });
    expect(f.output.body).toEqual({ ok: true, data: { ...detail, replayed } });
  });
});
