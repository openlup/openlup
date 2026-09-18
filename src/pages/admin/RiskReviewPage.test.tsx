import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import RiskReviewPage from "@/pages/admin/RiskReviewPage";
import { renderWithProviders } from "@/test/render";
import type { AdminRiskCaseDetail } from "@/domains/risk/contracts";

const {
  getAdminRiskCasesMock,
  getAdminRiskCaseDetailMock,
  decideAdminRiskCaseMock,
} = vi.hoisted(() => ({
  getAdminRiskCasesMock: vi.fn(),
  getAdminRiskCaseDetailMock: vi.fn(),
  decideAdminRiskCaseMock: vi.fn(),
}));

vi.mock("@/lib/authContext", () => ({
  useAuth: () => ({ session: { access_token: "admin-token" } }),
}));

vi.mock("@/domains/risk/riskClient", () => ({
  getAdminRiskCases: getAdminRiskCasesMock,
  getAdminRiskCaseDetail: getAdminRiskCaseDetailMock,
  decideAdminRiskCase: decideAdminRiskCaseMock,
}));

describe("RiskReviewPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAdminRiskCasesMock.mockResolvedValue({
      contractVersion: "risk.v1",
      cases: [riskCase],
      totalCount: 1,
      summaryCounts: {
        open: 1,
        inReview: 0,
        highSeverity: 1,
        blocked: 0,
      },
    });
    getAdminRiskCaseDetailMock.mockResolvedValue({
      contractVersion: "risk.v1",
      case: riskCase,
    });
    decideAdminRiskCaseMock.mockResolvedValue({
      contractVersion: "risk.v1",
      case: { ...riskCase, status: "in_review" },
      replayed: false,
    });
  });

  it("renders the risk queue, loads details, and submits a reviewer note", async () => {
    renderWithProviders(<RiskReviewPage />);

    expect(screen.getByText("Fraud / Risk review")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("High severity")).toBeInTheDocument();

    fireEvent.click(await screen.findByText("exact_blocklist_match"));

    expect(await screen.findByText("Review case")).toBeInTheDocument();
    expect(screen.getByText("Matched rules")).toBeInTheDocument();
    expect(screen.getByText("+80")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Add decision rationale/i), {
      target: { value: "Known false positive after manual review" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Note/i }));

    await waitFor(() => {
      expect(decideAdminRiskCaseMock).toHaveBeenCalledWith(
        "admin-token",
        expect.objectContaining({
          caseId: riskCase.id,
          decision: "note",
          note: "Known false positive after manual review",
        }),
      );
    });
    expect(getAdminRiskCasesMock).toHaveBeenCalledWith("admin-token", {
      page: 1,
      pageSize: 25,
      status: "open",
    });
    expect(getAdminRiskCaseDetailMock).toHaveBeenCalledWith("admin-token", riskCase.id);
  });
});

const riskCase: AdminRiskCaseDetail = {
  id: "11111111-1111-4111-8111-111111111111",
  assessmentId: "22222222-2222-4222-8222-222222222222",
  status: "open",
  severity: "high",
  decision: "manual_review",
  score: 80,
  reasonCodes: ["exact_blocklist_match"],
  orderId: "33333333-3333-4333-8333-333333333333",
  clientId: "44444444-4444-4444-8444-444444444444",
  paymentIntentId: null,
  holdId: null,
  createdAt: "2026-06-16T20:00:00.000Z",
  updatedAt: "2026-06-16T21:00:00.000Z",
  subjectRefs: [
    {
      subjectKind: "email",
      subjectHash: "email-hash-value-0001",
    },
  ],
  evidence: {
    emailDomain: "example.test",
    matchedBlocklist: true,
  },
  matchedRules: [
    {
      code: "exact_blocklist_match",
      score: 80,
      severity: "high",
      evidence: {
        subjectKind: "email",
      },
    },
  ],
  events: [],
  actionEligibility: {
    approve: { allowed: true, reason: null },
    block: { allowed: true, reason: null },
    escalate: { allowed: true, reason: null },
    note: { allowed: true, reason: null },
  },
};
