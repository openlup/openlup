import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AuthCallbackPage from "@/pages/admin/AuthCallbackPage";
import { renderWithProviders } from "@/test/render";

const navigateMock = vi.fn();

const {
  mockOnAuthStateChange,
  mockGetSession,
  mockRefreshAdmin,
  mockSignOut,
  mockUpdateUser,
  mockUnsubscribe,
  mockInitialType,
} = vi.hoisted(() => {
  const mockUnsubscribe = vi.fn();
  const mockOnAuthStateChange = vi.fn();
  const mockGetSession = vi.fn();
  const mockRefreshAdmin = vi.fn();
  const mockSignOut = vi.fn();
  const mockUpdateUser = vi.fn();
  // Holder for the type captured at client init; null = fall back to live URL.
  const mockInitialType = { value: null as string | null };

  return {
    mockOnAuthStateChange,
    mockGetSession,
    mockRefreshAdmin,
    mockSignOut,
    mockUpdateUser,
    mockUnsubscribe,
    mockInitialType,
  };
});

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      onAuthStateChange: mockOnAuthStateChange,
      getSession: mockGetSession,
      signOut: mockSignOut,
      updateUser: mockUpdateUser,
    },
  },
  get initialAuthCallbackType() {
    return mockInitialType.value;
  },
  readAuthCallbackTypeFrom: (search: string, hash: string): string | null => {
    const fromSearch = new URLSearchParams(search).get("type");
    if (fromSearch) return fromSearch;
    return new URLSearchParams(hash.replace(/^#/, "")).get("type");
  },
}));

vi.mock("@/lib/authContext", () => ({
  useAuth: () => ({
    refreshAdmin: mockRefreshAdmin,
  }),
}));

describe("AuthCallbackPage", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/admin/auth/callback");
    mockInitialType.value = null;
    navigateMock.mockReset();
    mockGetSession.mockReset();
    mockRefreshAdmin.mockReset();
    mockSignOut.mockReset();
    mockUpdateUser.mockReset();
    mockUnsubscribe.mockReset();
    mockOnAuthStateChange.mockImplementation((callback: (event: string) => void) => {
      return {
        data: {
          subscription: {
            unsubscribe: mockUnsubscribe,
          },
        },
      };
    });
  });

  it("shows the expired-link state when there is no recovery session", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
    });

    renderWithProviders(<AuthCallbackPage />);

    expect(await screen.findByText(/Link jest nieprawidłowy lub wygasł/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Wróć do logowania/i })).toHaveAttribute(
      "href",
      "/admin/login",
    );
  });

  it("renders the password form when a session already exists", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: "1" } } },
    });

    renderWithProviders(<AuthCallbackPage />);

    expect(await screen.findByText("Ustaw hasło do panelu")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Min. 8 znaków")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ustaw hasło i wejdź" })).toBeInTheDocument();
  });

  it("validates password length and confirmation before submitting", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: "1" } } },
    });

    renderWithProviders(<AuthCallbackPage />);

    const passwordInput = await screen.findByPlaceholderText("Min. 8 znaków");
    const confirmInput = screen.getByLabelText(/^Powtórz hasło/);

    fireEvent.change(passwordInput, { target: { value: "short" } });
    fireEvent.change(confirmInput, { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Ustaw hasło i wejdź" }));

    expect(await screen.findByText("Hasło jest za krótkie")).toBeInTheDocument();

    fireEvent.change(passwordInput, { target: { value: "long-enough" } });
    fireEvent.change(confirmInput, { target: { value: "different-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Ustaw hasło i wejdź" }));

    expect(await screen.findByText("Hasła nie są takie same")).toBeInTheDocument();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("shows the Supabase error when updating the password fails", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: "1" } } },
    });
    mockUpdateUser.mockResolvedValue({
      error: { message: "Token expired" },
    });

    renderWithProviders(<AuthCallbackPage />);

    const passwordInput = await screen.findByPlaceholderText("Min. 8 znaków");
    const confirmInput = screen.getByLabelText(/^Powtórz hasło/);

    fireEvent.change(passwordInput, { target: { value: "very-secret" } });
    fireEvent.change(confirmInput, { target: { value: "very-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Ustaw hasło i wejdź" }));

    expect(await screen.findByText("Token expired")).toBeInTheDocument();
  });

  it("updates the password and redirects to admin on success", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: "1" } } },
    });
    mockUpdateUser.mockResolvedValue({
      error: null,
    });

    renderWithProviders(<AuthCallbackPage />);

    const passwordInput = await screen.findByPlaceholderText("Min. 8 znaków");
    const confirmInput = screen.getByLabelText(/^Powtórz hasło/);

    fireEvent.change(passwordInput, { target: { value: "very-secret" } });
    fireEvent.change(confirmInput, { target: { value: "very-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Ustaw hasło i wejdź" }));

    await waitFor(() => {
      expect(mockUpdateUser).toHaveBeenCalledWith({ password: "very-secret" });
    });
    expect(navigateMock).toHaveBeenCalledWith("/admin", { replace: true });
  });

  it("refreshes admin authorization and enters admin for magic-link callbacks", async () => {
    window.history.pushState({}, "", "/admin/auth/callback#access_token=token&type=magiclink");
    const session = { access_token: "admin-token", user: { id: "1" } };
    mockGetSession.mockResolvedValue({
      data: { session },
    });
    mockRefreshAdmin.mockResolvedValue({ isAdmin: true, role: "admin" });

    renderWithProviders(<AuthCallbackPage />);

    await waitFor(() => {
      expect(mockRefreshAdmin).toHaveBeenCalledWith(session);
      expect(navigateMock).toHaveBeenCalledWith("/admin", { replace: true });
    });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("enters admin for a magic-link callback even after the hash was stripped (uses the type captured at client init)", async () => {
    // Repro of the field bug: detectSessionInUrl already consumed + stripped the
    // `#…&type=magiclink` hash before this lazy route mounted, so the live URL has
    // no `type`. Without the init-time snapshot the flow falls through to the
    // password-set form instead of signing the admin in.
    window.history.pushState({}, "", "/admin/auth/callback#");
    mockInitialType.value = "magiclink";
    const session = { access_token: "admin-token", user: { id: "1" } };
    mockGetSession.mockResolvedValue({ data: { session } });
    mockRefreshAdmin.mockResolvedValue({ isAdmin: true, role: "admin" });

    renderWithProviders(<AuthCallbackPage />);

    await waitFor(() => {
      expect(mockRefreshAdmin).toHaveBeenCalledWith(session);
      expect(navigateMock).toHaveBeenCalledWith("/admin", { replace: true });
    });
    expect(screen.queryByText("Ustaw hasło do panelu")).not.toBeInTheDocument();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("signs out and rejects magic-link callbacks without admin authorization", async () => {
    window.history.pushState({}, "", "/admin/auth/callback?type=magiclink");
    const session = { access_token: "customer-token", user: { id: "1" } };
    mockGetSession.mockResolvedValue({
      data: { session },
    });
    mockRefreshAdmin.mockResolvedValue({ isAdmin: false, role: null });
    mockSignOut.mockResolvedValue({ error: null });

    renderWithProviders(<AuthCallbackPage />);

    expect(await screen.findByText("Nie masz dostępu do panelu admina.")).toBeInTheDocument();
    expect(mockSignOut).toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });
});
