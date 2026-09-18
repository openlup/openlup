import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import B2BInquiriesPage from "@/pages/admin/B2BInquiriesPage";
import type {
  PartnersB2BInquiry,
  PartnersB2BInquiryListRequest,
} from "@/domains/partners/contracts";
import { renderWithProviders } from "@/test/render";

const { mockState, getInquiriesMock } = vi.hoisted(() => {
  const mockState = {
    inquiries: [] as PartnersB2BInquiry[],
  };

  const filterRows = (params: { status?: string | null; search?: string | null; range?: [number, number] | null }) => {
    let rows = [...mockState.inquiries];
    if (params.status && params.status !== "all") {
      rows = rows.filter((row) => row.status === params.status);
    }
    if (params.search) {
      const term = params.search.toLowerCase();
      rows = rows.filter((row) =>
        [row.company, row.business_email, row.first_name, row.last_name]
          .some((value) => value.toLowerCase().includes(term)),
      );
    }
    if (params.range) rows = rows.slice(params.range[0], params.range[1] + 1);
    return rows;
  };

  const getInquiriesMock = vi.fn((_token: string, request: PartnersB2BInquiryListRequest) => {
    const range: [number, number] = [
      request.page * request.pageSize,
      (request.page + 1) * request.pageSize - 1,
    ];
    return Promise.resolve({
      inquiries: filterRows({ status: request.status, search: request.search, range }),
      totalCount: filterRows({ status: request.status, search: request.search }).length,
      newCount: mockState.inquiries.filter((row) => row.status === "new").length,
    });
  });

  return { mockState, getInquiriesMock };
});

vi.mock("@/domains/partners/adminB2BInquiryClient", () => ({
  getAdminB2BInquiries: getInquiriesMock,
}));

vi.mock("@/lib/authContext", () => ({
  useAuth: () => ({
    session: {
      access_token: "admin-token",
    },
  }),
}));

vi.mock("@/components/admin/B2BInquiryDetailSheet", () => ({
  default: ({ inquiry }: { inquiry: PartnersB2BInquiry | null }) =>
    inquiry ? <aside>Detail: {inquiry.company}</aside> : null,
}));

vi.mock("@/components/ui/table", () => ({
  Table: ({ children }: { children: React.ReactNode }) => <table>{children}</table>,
  TableHeader: ({ children }: { children: React.ReactNode }) => <thead>{children}</thead>,
  TableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody>,
  TableRow: ({ children, ...props }: React.HTMLAttributes<HTMLTableRowElement>) => <tr {...props}>{children}</tr>,
  TableHead: ({ children }: { children: React.ReactNode }) => <th>{children}</th>,
  TableCell: ({ children, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) => <td {...props}>{children}</td>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe("B2BInquiriesPage", () => {
  beforeEach(() => {
    getInquiriesMock.mockClear();
    mockState.inquiries = [
      {
        id: "inq-1",
        created_at: "2026-05-14T07:00:00.000Z",
        company: "Acme Pet Foods",
        website: "https://acme.example",
        country: "US",
        company_type: "Retailer",
        revenue_bucket: null,
        first_name: "Jane",
        last_name: "Smith",
        business_email: "jane@acme.example",
        phone: null,
        interests: ["private-label"],
        notes: null,
        ip_hash: null,
        pipedrive_deal_id: 123,
        status: "new",
      },
      {
        id: "inq-2",
        created_at: "2026-05-13T07:00:00.000Z",
        company: "Baltic Vet Supply",
        website: null,
        country: "PL",
        company_type: "Distributor",
        revenue_bucket: null,
        first_name: "Jan",
        last_name: "Kowalski",
        business_email: "jan@baltic.example",
        phone: null,
        interests: [],
        notes: null,
        ip_hash: null,
        pipedrive_deal_id: null,
        status: "contacted",
      },
    ];
  });

  it("renders inquiry rows, counts, and opens the detail sheet", async () => {
    renderWithProviders(<B2BInquiriesPage />);

    expect(await screen.findByText("B2B Inquiries")).toBeInTheDocument();
    expect(getInquiriesMock).toHaveBeenCalledWith("admin-token", {
      status: "all",
      search: "",
      page: 0,
      pageSize: 50,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(await screen.findByText("Acme Pet Foods")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText((_, element) => element?.textContent === "2 łącznie")).toBeInTheDocument();
      expect(screen.getByText("1 nowych")).toBeInTheDocument();
    });
    expect(screen.getByText("jane@acme.example")).toBeInTheDocument();
    expect(screen.getByText("#123")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Acme Pet Foods"));

    expect(await screen.findByText("Detail: Acme Pet Foods")).toBeInTheDocument();
  });

  it("renders the empty state when there are no inquiries", async () => {
    mockState.inquiries = [];

    renderWithProviders(<B2BInquiriesPage />);

    expect(await screen.findByText("Brak zapytań")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText((_, element) => element?.textContent === "0 łącznie")).toBeInTheDocument());
  });
});
