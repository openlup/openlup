import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SurveyResponsesPage from "@/pages/admin/SurveyResponsesPage";
import { renderWithProviders } from "@/test/render";
import type { SurveyRow } from "@/lib/exportSurveyCsv";

const {
  mockState,
  mockGetAdminSurveyResponses,
  mockDownloadCsv,
  mockUseAuth,
} = vi.hoisted(() => {
  const mockState = {
    producerRows: [] as SurveyRow[],
    consumerRows: [] as SurveyRow[],
  };
  const mockGetAdminSurveyResponses = vi.fn();
  const mockDownloadCsv = vi.fn();
  const mockUseAuth = vi.fn();

  return { mockState, mockGetAdminSurveyResponses, mockDownloadCsv, mockUseAuth };
});

vi.mock("@/domains/marketing/research/adminSurveyResponsesClient", () => ({
  getAdminSurveyResponses: mockGetAdminSurveyResponses,
}));

vi.mock("@/lib/authContext", () => ({
  useAuth: mockUseAuth,
}));

vi.mock("@/lib/exportSurveyCsv", async () => {
  const actual = await vi.importActual<typeof import("@/lib/exportSurveyCsv")>("@/lib/exportSurveyCsv");
  return {
    ...actual,
    downloadCsv: mockDownloadCsv,
    todayDateStr: () => "2026-05-14",
  };
});

vi.mock("@/components/admin/ProducerSurveyCharts", () => ({
  default: ({ rows }: { rows: SurveyRow[] }) => <div>Producer charts: {rows.length}</div>,
}));

vi.mock("@/components/admin/ConsumerSurveyCharts", () => ({
  default: ({ rows }: { rows: SurveyRow[] }) => <div>Consumer charts: {rows.length}</div>,
}));

describe("SurveyResponsesPage", () => {
  beforeEach(() => {
    mockGetAdminSurveyResponses.mockReset();
    mockDownloadCsv.mockReset();
    mockUseAuth.mockReset();
    mockUseAuth.mockReturnValue({ session: { access_token: "admin-token" } });
    mockState.producerRows = [
      {
        id: "prod-1",
        created_at: "2026-05-14T07:00:00.000Z",
        response_data: {
          screen2_region: "Europe",
          screen1_role: "Founder",
          screen5_usage_combined: ["Food", "Treats"],
          screen10_pipeline_timing: "2026",
          screen12a_company_size: "Small — 10 to 49 employees",
          screen12b_seniority: "C-level / Owner / Founder",
          screen13_opt_in: true,
        },
      },
      {
        id: "prod-2",
        created_at: "2026-05-13T07:00:00.000Z",
        response_data: {
          screen2_region: "North America",
        },
      },
    ];
    mockState.consumerRows = [
      {
        id: "cons-1",
        created_at: "2026-05-14T08:00:00.000Z",
        response_data: {
          screen12d_region: "Europe",
          screen1_pet_type: "Dog",
          screen7_vet_scenario: "Often",
          screen10b_anchored_wtp: "Premium",
          screen12a_age: "35-44",
          screen12b_gender: "Female",
          screen12c_household: "Family",
        },
      },
    ];
    mockGetAdminSurveyResponses.mockImplementation(async (_token, request) => ({
      rows: request.surveyType === "producer"
        ? mockState.producerRows
        : mockState.consumerRows,
      totalCount: request.surveyType === "producer"
        ? mockState.producerRows.length
        : mockState.consumerRows.length,
      page: request.page ?? 0,
      pageSize: request.pageSize ?? 50,
    }));
  });

  it("renders producer metrics, switches to consumer rows, and exports active rows", async () => {
    renderWithProviders(<SurveyResponsesPage />);

    expect(await screen.findByText("Interzoo 2026 – Survey Responses")).toBeInTheDocument();
    await waitFor(() => {
      expect(mockGetAdminSurveyResponses).toHaveBeenCalledWith(
        "admin-token",
        { surveyType: "producer", page: 0, pageSize: 50 },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    expect(screen.getByText("Producer charts: 2")).toBeInTheDocument();
    expect(screen.getByText("1 (50%)")).toBeInTheDocument();
    expect(screen.getByText("Founder")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(mockDownloadCsv).toHaveBeenCalledWith(
      "survey_responses_producer_2026-05-14.csv",
      expect.stringContaining("prod-1"),
    );

    fireEvent.click(screen.getByRole("button", { name: /Consumer \(B2C\)/ }));

    expect(await screen.findByText("Consumer charts: 1")).toBeInTheDocument();
    await waitFor(() => {
      expect(mockGetAdminSurveyResponses).toHaveBeenCalledWith(
        "admin-token",
        { surveyType: "consumer", page: 0, pageSize: 50 },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    expect(screen.getByText("Dog")).toBeInTheDocument();
  });

  it("renders the empty state and disables export when the active tab has no rows", async () => {
    mockState.producerRows = [];
    mockState.consumerRows = [];

    renderWithProviders(<SurveyResponsesPage />);

    expect(await screen.findByText("No responses yet. Refresh in 60s.")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
    });
  });
});
