import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TemplatesPage from "@/pages/admin/TemplatesPage";
import { renderWithProviders } from "@/test/render";

const {
  mockGetAdminEmailTemplates,
  mockUpdateAdminEmailTemplateActive,
  mockUpdateAdminEmailTemplateContent,
  mockUseAuth,
} = vi.hoisted(() => {
  const mockGetAdminEmailTemplates = vi.fn();
  const mockUpdateAdminEmailTemplateActive = vi.fn();
  const mockUpdateAdminEmailTemplateContent = vi.fn();
  const mockUseAuth = vi.fn();

  return {
    mockGetAdminEmailTemplates,
    mockUpdateAdminEmailTemplateActive,
    mockUpdateAdminEmailTemplateContent,
    mockUseAuth,
  };
});

vi.mock("@/domains/communications/adminTemplatesClient", () => ({
  getAdminEmailTemplates: mockGetAdminEmailTemplates,
  updateAdminEmailTemplateActive: mockUpdateAdminEmailTemplateActive,
  updateAdminEmailTemplateContent: mockUpdateAdminEmailTemplateContent,
}));

vi.mock("@/lib/authContext", () => ({
  useAuth: mockUseAuth,
}));

vi.mock("@/components/ui/table", () => ({
  Table: ({ children }: { children: React.ReactNode }) => <table>{children}</table>,
  TableHeader: ({ children }: { children: React.ReactNode }) => <thead>{children}</thead>,
  TableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody>,
  TableRow: ({ children, ...props }: React.HTMLAttributes<HTMLTableRowElement>) => (
    <tr {...props}>{children}</tr>
  ),
  TableHead: ({ children }: { children: React.ReactNode }) => <th>{children}</th>,
  TableCell: ({ children, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
    <td {...props}>{children}</td>
  ),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <button role="switch" aria-checked={checked} onClick={() => onCheckedChange(!checked)}>
      {checked ? "on" : "off"}
    </button>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
  }) => <input value={value} onChange={onChange} />,
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: ({
    value,
    onChange,
    rows,
  }: {
    value: string;
    rows?: number;
    onChange: React.ChangeEventHandler<HTMLTextAreaElement>;
  }) => <textarea value={value} rows={rows} onChange={onChange} />,
}));

describe("TemplatesPage", () => {
  beforeEach(() => {
    mockGetAdminEmailTemplates.mockReset();
    mockUpdateAdminEmailTemplateActive.mockReset();
    mockUpdateAdminEmailTemplateContent.mockReset();
    mockUseAuth.mockReset();

    mockUseAuth.mockReturnValue({ session: { access_token: "admin-token" } });
    mockGetAdminEmailTemplates.mockResolvedValue({
      templates: [
        {
          id: "tpl-1",
          name: "Approval",
          slug: "approved",
          subject: "Hej {{first_name}}",
          body_html: "<p>Czesc {{first_name}} z {{city}}</p>",
          body_text: "Plain body",
          trigger_type: "status_change",
          sequence_order: 1,
          active: true,
        },
        {
          id: "tpl-2",
          name: "Shipping",
          slug: "shipped",
          subject: "Tracking {{tracking_number}}",
          body_html: "<p>Paczka dla {{dog_name}}</p>",
          body_text: null,
          trigger_type: null,
          sequence_order: 2,
          active: false,
        },
      ],
    });
    mockUpdateAdminEmailTemplateActive.mockResolvedValue({
      updated: true,
      templateId: "tpl-1",
      active: false,
    });
    mockUpdateAdminEmailTemplateContent.mockResolvedValue({
      updated: true,
      templateId: "tpl-1",
    });
  });

  it("renders the templates table and editable count", async () => {
    renderWithProviders(<TemplatesPage />);

    expect(await screen.findByText("Approval")).toBeInTheDocument();
    expect(screen.getByText(/2 z \d+ edytowalnych tutaj/)).toBeInTheDocument();
    expect(screen.getByText("approved")).toBeInTheDocument();
    expect(screen.getByText("Shipping")).toBeInTheDocument();
    // Only the two DB-backed rows expose an active toggle; code-rendered rows do not.
    expect(screen.getAllByRole("switch")).toHaveLength(2);
    expect(mockGetAdminEmailTemplates).toHaveBeenCalledWith("admin-token");
  });

  it("lists code-rendered canon kinds as read-only and does not open the editor for them", async () => {
    renderWithProviders(<TemplatesPage />);

    // A canonical_renderer slug that has no DB row still appears in the inventory.
    const codeSlug = await screen.findByText("commerce-order-paid");
    expect(codeSlug).toBeInTheDocument();

    // Clicking its row must not open the edit dialog (no DB row backs it).
    fireEvent.click(codeSlug);
    expect(screen.queryByText("Edycja: commerce-order-paid")).not.toBeInTheDocument();
  });

  it("opens the DB-template preview dialog and renders substituted sample values", async () => {
    renderWithProviders(<TemplatesPage />);

    fireEvent.click(await screen.findByLabelText("Podgląd maila: Approval"));

    expect(screen.getByText("Podgląd: Approval")).toBeInTheDocument();
    expect(screen.getAllByText("Hej {{first_name}}")).toHaveLength(2);
    expect(screen.getByTitle("Podgląd maila Approval")).toHaveAttribute(
      "srcdoc",
      expect.stringContaining("Czesc Jan z Warszawa"),
    );
  });

  it("previews code-rendered canon emails and marks emails without a code renderer as unavailable", async () => {
    renderWithProviders(<TemplatesPage />);

    // commerce-order-paid is rendered in code but previewable client-side.
    fireEvent.click(await screen.findByLabelText("Podgląd maila: Commerce order paid"));
    expect(screen.getByText("Podgląd: Commerce order paid")).toBeInTheDocument();
    expect(screen.getByTitle("Podgląd maila Commerce order paid")).toHaveAttribute(
      "srcdoc",
      expect.stringContaining("Zamówienie potwierdzone"),
    );

    // Emails with no code preview renderer (e.g. waitlist confirmation) cannot be previewed here.
    expect(screen.getAllByText("bez podglądu").length).toBeGreaterThan(0);
  });

  it("toggles the active state for a template", async () => {
    renderWithProviders(<TemplatesPage />);

    const switches = await screen.findAllByRole("switch");
    fireEvent.click(switches[0]);

    await waitFor(() => {
      expect(mockUpdateAdminEmailTemplateActive).toHaveBeenCalledWith("admin-token", {
        templateId: "tpl-1",
        active: false,
      });
    });
  });

  it("opens the edit dialog and saves updated template fields", async () => {
    renderWithProviders(<TemplatesPage />);

    fireEvent.click(await screen.findByText("Approval"));

    expect(screen.getByText("Edycja: approved")).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("Approval"), {
      target: { value: "Updated approval" },
    });
    fireEvent.change(screen.getByDisplayValue("Hej {{first_name}}"), {
      target: { value: "Nowy temat" },
    });
    fireEvent.change(screen.getByDisplayValue("<p>Czesc {{first_name}} z {{city}}</p>"), {
      target: { value: "<p>Nowa tresc</p>" },
    });
    fireEvent.change(screen.getByDisplayValue("Plain body"), {
      target: { value: "Updated plain text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Podgląd" }));

    expect(screen.getByTitle("Podgląd edytowanego szablonu")).toHaveAttribute(
      "srcdoc",
      expect.stringContaining("Nowa tresc"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Zapisz" }));

    await waitFor(() => {
      expect(mockUpdateAdminEmailTemplateContent).toHaveBeenCalledWith("admin-token", {
        templateId: "tpl-1",
        name: "Updated approval",
        subject: "Nowy temat",
        bodyHtml: "<p>Nowa tresc</p>",
        bodyText: "Updated plain text",
      });
    });
  });
});
