import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PipelinePage from "@/pages/admin/PipelinePage";
import { renderWithProviders } from "@/test/render";

const {
  toastSuccess,
  toastError,
  getPipelineMock,
  refreshDhlMock,
} = vi.hoisted(() => {
  const toastSuccess = vi.fn();
  const toastError = vi.fn();
  const testers = [
    { id: "t1", status: "pending_review", email_sequence_step: 0, email_sequence_paused: false },
    { id: "t2", status: "packing", email_sequence_step: 1, email_sequence_paused: true },
    { id: "t3", status: "shipped", email_sequence_step: 1, email_sequence_paused: false },
    { id: "t4", status: "in_transit", email_sequence_step: 2, email_sequence_paused: false },
    { id: "t5", status: "delivered", email_sequence_step: 2, email_sequence_paused: false },
    { id: "t6", status: "rejected", email_sequence_step: 0, email_sequence_paused: false },
  ];
  const templates = [
    { id: "tpl1", name: "Welcome", sequence_order: 0 },
    { id: "tpl2", name: "Check-in", sequence_order: 1 },
    { id: "tpl3", name: "Reminder", sequence_order: 2 },
  ];
  const emailEvents = [
    { event_type: "delivered" },
    { event_type: "delivered" },
    { event_type: "opened" },
    { event_type: "opened" },
    { event_type: "clicked" },
  ];

  const getPipelineMock = vi.fn().mockResolvedValue({
    testers,
    templates,
    emailSendCount: 4,
    emailEvents,
  });
  const refreshDhlMock = vi.fn();

  return {
    toastSuccess,
    toastError,
    getPipelineMock,
    refreshDhlMock,
  };
});

vi.mock("@/domains/platform/adminPipelineClient", () => ({
  getAdminPipeline: getPipelineMock,
  refreshAdminPipelineDhlTracking: refreshDhlMock,
}));

vi.mock("@/lib/authContext", () => ({
  useAuth: () => ({
    session: {
      access_token: "admin-token",
    },
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
  },
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe("PipelinePage", () => {
  beforeEach(() => {
    getPipelineMock.mockClear();
    refreshDhlMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    refreshDhlMock.mockResolvedValue({ checked: 3, updated: 2 });
  });

  it("renders the pipeline stats, stages, and email sequence overview", async () => {
    renderWithProviders(<PipelinePage />);

    expect(await screen.findByText("Pipeline")).toBeInTheDocument();
    expect(await screen.findByText("6")).toBeInTheDocument();
    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.getAllByText("1").length).toBeGreaterThan(0);
    expect(screen.getByText("Zaakceptowane")).toBeInTheDocument();
    expect(screen.getByText("Odrzucone (osobna ścieżka)")).toBeInTheDocument();
    expect(screen.getAllByText("Wysłane").length).toBeGreaterThan(0);
    expect(screen.getAllByText("50.0%").length).toBeGreaterThan(0);
    expect(screen.getByText("100.0%")).toBeInTheDocument();
    expect(screen.getByText("Krok 1")).toBeInTheDocument();
    expect(screen.getByText("Check-in")).toBeInTheDocument();
    expect(screen.getByText("Wstrzymane")).toBeInTheDocument();
  });

  it("does not expose the retired direct DHL tracking refresh", async () => {
    renderWithProviders(<PipelinePage />);

    expect(await screen.findByText("Pipeline")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Odśwież statusy DHL/i })).not.toBeInTheDocument();
    expect(refreshDhlMock).not.toHaveBeenCalled();
  });
});
