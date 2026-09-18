import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import B2BInquiryDetailSheet from "@/components/admin/B2BInquiryDetailSheet";
import type { PartnersB2BInquiry } from "@/domains/partners/contracts";
import { renderWithProviders } from "@/test/render";

const { updateStatusMock, toastSuccess, toastError } = vi.hoisted(() => ({
  updateStatusMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/domains/partners/adminB2BInquiryClient", () => ({
  updateAdminB2BInquiryStatus: updateStatusMock,
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
    info: vi.fn(),
  },
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const inquiry: PartnersB2BInquiry = {
  id: "inq-1",
  created_at: "2026-05-01T10:00:00.000Z",
  company: "Acme Foods",
  website: "https://acme.example",
  country: "DE",
  company_type: "Brand",
  revenue_bucket: "1M-5M",
  first_name: "Anna",
  last_name: "Nowak",
  business_email: "anna@acme.example",
  phone: "+48123",
  interests: ["private label"],
  notes: "Interested",
  ip_hash: "hash",
  pipedrive_deal_id: 123,
  status: "new",
};

describe("B2BInquiryDetailSheet", () => {
  beforeEach(() => {
    updateStatusMock.mockResolvedValue({ updated: true });
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it("renders inquiry details and updates status", async () => {
    renderWithProviders(<B2BInquiryDetailSheet inquiry={inquiry} onClose={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Acme Foods" })).toBeInTheDocument();
    expect(screen.getByText("Germany (DE) · Brand")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "anna@acme.example" })).toHaveAttribute("href", "mailto:anna@acme.example");

    fireEvent.click(screen.getByRole("button", { name: "Skontaktowany" }));

    await waitFor(() => {
      expect(updateStatusMock).toHaveBeenCalledWith("admin-token", {
        id: "inq-1",
        status: "contacted",
      });
    });
    expect(toastSuccess).toHaveBeenCalled();
  });
});
