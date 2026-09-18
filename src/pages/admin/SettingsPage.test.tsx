import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "@/pages/admin/SettingsPage";
import { renderWithProviders } from "@/test/render";

const {
  toastSuccess,
  toastError,
  mockGetAdminSettings,
  mockInviteAdminUser,
  mockRemoveAdminUser,
  mockUpdateAdminSetting,
  mockUpdateAdminUserRole,
  mockConfirm,
} = vi.hoisted(() => {
  const toastSuccess = vi.fn();
  const toastError = vi.fn();
  const mockGetAdminSettings = vi.fn();
  const mockInviteAdminUser = vi.fn();
  const mockRemoveAdminUser = vi.fn();
  const mockUpdateAdminSetting = vi.fn();
  const mockUpdateAdminUserRole = vi.fn();
  const mockConfirm = vi.fn();

  return {
    toastSuccess,
    toastError,
    mockGetAdminSettings,
    mockInviteAdminUser,
    mockRemoveAdminUser,
    mockUpdateAdminSetting,
    mockUpdateAdminUserRole,
    mockConfirm,
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
  },
}));

vi.mock("@/lib/authContext", () => ({
  useAuth: () => ({
    user: { id: "current-user" },
    session: { access_token: "admin-token" },
    role: null,
  }),
}));

vi.mock("@/domains/platform/adminSettingsClient", () => ({
  getAdminSettings: mockGetAdminSettings,
  inviteAdminUser: mockInviteAdminUser,
  removeAdminUser: mockRemoveAdminUser,
  updateAdminSetting: mockUpdateAdminSetting,
  updateAdminUserRole: mockUpdateAdminUserRole,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
    >
      switch
    </button>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    children: React.ReactNode;
  }) => (
    <div>
      {children}
      <button type="button" onClick={() => onValueChange?.("admin")}>
        choose-admin
      </button>
      <button type="button" onClick={() => onValueChange?.("distributor")}>
        choose-distributor
      </button>
    </div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span>value</span>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe("SettingsPage", () => {
  beforeEach(() => {
    mockGetAdminSettings.mockReset();
    mockInviteAdminUser.mockReset();
    mockRemoveAdminUser.mockReset();
    mockUpdateAdminSetting.mockReset();
    mockUpdateAdminUserRole.mockReset();
    mockConfirm.mockReset();
    mockConfirm.mockReturnValue(true);
    vi.stubGlobal("confirm", mockConfirm);
    toastSuccess.mockReset();
    toastError.mockReset();

    mockGetAdminSettings.mockResolvedValue({
      settings: {
        tester_cap: 123,
        counter_display: false,
        dhl_shipper_name: "openlup",
        dhl_shipper_city: "Warszawa",
      },
      adminUsers: [
        { id: "current-user", email: "owner@openlup.com", role: "admin" },
        { id: "other-user", email: "ops@openlup.com", role: "distributor" },
      ],
    });
    mockInviteAdminUser.mockResolvedValue({ message: "Zaproszenie wysłane" });
    mockRemoveAdminUser.mockResolvedValue({ revoked: true });
    mockUpdateAdminSetting.mockResolvedValue({ saved: true });
    mockUpdateAdminUserRole.mockResolvedValue({
      userId: "other-user",
      role: "admin",
      saved: true,
    });
  });

  it("loads settings, pre-fills fields, and renders admin users", async () => {
    renderWithProviders(<SettingsPage />);

    expect(await screen.findByDisplayValue("123")).toBeInTheDocument();
    expect(mockGetAdminSettings).toHaveBeenCalledWith("admin-token");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByDisplayValue("openlup")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Warszawa")).toBeInTheDocument();
    expect(screen.getByText("owner@openlup.com")).toBeInTheDocument();
    expect(screen.getByText("ops@openlup.com")).toBeInTheDocument();
    expect(screen.getAllByText("Dystrybutor").length).toBeGreaterThan(0);
    expect(screen.getByText("Odbierz dostęp")).toBeInTheDocument();
  });

  it("saves the tester cap, counter display, and DHL shipper settings", async () => {
    renderWithProviders(<SettingsPage />);

    const capInput = await screen.findByDisplayValue("123");
    fireEvent.change(capInput, { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Zapisz" }));

    await waitFor(() => {
      expect(mockUpdateAdminSetting).toHaveBeenCalledWith("admin-token", {
        key: "tester_cap",
        value: 250,
      });
    });

    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() => {
      expect(mockUpdateAdminSetting).toHaveBeenCalledWith("admin-token", {
        key: "counter_display",
        value: true,
      });
    });

    fireEvent.change(screen.getByDisplayValue("openlup"), {
      target: { value: "openlup Labs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Zapisz dane nadawcy" }));

    await waitFor(() => {
      expect(mockUpdateAdminSetting).toHaveBeenCalledWith("admin-token", {
        key: "dhl_shipper_name",
        value: "openlup Labs",
      });
    });
  });

  it("invites a new admin and resets the form on success", async () => {
    renderWithProviders(<SettingsPage />);

    fireEvent.change(await screen.findByPlaceholderText("email@example.com"), {
      target: { value: " NEW@OPENLUP.COM " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Wyślij zaproszenie" }));

    await waitFor(() => {
      expect(mockInviteAdminUser).toHaveBeenCalledWith("admin-token", {
        email: "new@openlup.com",
        role: "admin",
      });
    });
    expect(toastSuccess).toHaveBeenCalledWith("Zaproszenie wysłane");
    expect(screen.getByPlaceholderText("email@example.com")).toHaveValue("");
  });

  it("shows an error toast when inviting an admin fails", async () => {
    mockInviteAdminUser.mockRejectedValue(new Error("Invite failed"));

    renderWithProviders(<SettingsPage />);

    fireEvent.change(await screen.findByPlaceholderText("email@example.com"), {
      target: { value: "new@openlup.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Wyślij zaproszenie" }));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Invite failed");
    });
  });

  it("updates another admin role and revokes that user with confirmation", async () => {
    renderWithProviders(<SettingsPage />);

    await screen.findByText("ops@openlup.com");

    fireEvent.click(screen.getAllByRole("button", { name: "choose-admin" })[0]);

    await waitFor(() => {
      expect(mockUpdateAdminUserRole).toHaveBeenCalledWith("admin-token", {
        userId: "other-user",
        role: "admin",
      });
    });

    fireEvent.click(screen.getByText("Odbierz dostęp"));

    await waitFor(() => {
      expect(mockRemoveAdminUser).toHaveBeenCalledWith("admin-token", {
        userId: "other-user",
      });
    });
    expect(mockConfirm).toHaveBeenCalledWith("Czy na pewno odebrać dostęp użytkownikowi ops@openlup.com?");
    expect(toastSuccess).toHaveBeenCalledWith("Dostęp odebrany");
  });

  it("keeps the action pending and shows an error when access revocation fails", async () => {
    let rejectRemove: ((error: Error) => void) | undefined;
    mockRemoveAdminUser.mockImplementation(() => new Promise((_, reject) => {
      rejectRemove = reject;
    }));

    renderWithProviders(<SettingsPage />);

    const button = await screen.findByRole("button", { name: "Odbierz dostęp" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Odbieranie dostępu..." })).toBeDisabled();
    });

    rejectRemove?.(new Error("Revoke failed"));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Revoke failed");
    });
  });
});
