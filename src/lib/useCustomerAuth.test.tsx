import { act, render, screen, waitFor } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";

import type { AuthSession, AuthStateListener } from "@/domains/auth/types";

const mockAuthPort = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<AuthSession | null>>(),
  onAuthStateChange: vi.fn<(listener: AuthStateListener) => () => void>(),
  signInWithOtp: vi.fn(),
  verifyOtpCode: vi.fn(),
  signInWithOAuth: vi.fn(),
  linkIdentity: vi.fn(),
  signOut: vi.fn(),
}));
const mockGetCustomerMe = vi.hoisted(() => vi.fn());
const mockReconcileCustomerAccount = vi.hoisted(() => vi.fn());
const mockClearAuthScopedQueryCache = vi.hoisted(() => vi.fn());
const diagnosticReporter = vi.hoisted(() => ({ reportCustomerJourneyDiagnostic: vi.fn() }));

vi.mock("@/lib/auth/customerAuthPortFactory", () => ({
  getCustomerAuthPort: () => mockAuthPort,
}));

vi.mock("@/domains/customers/customerMeClient", () => ({
  getCustomerMe: mockGetCustomerMe,
}));

vi.mock("@/domains/customers/customerReconcileClient", () => ({
  reconcileCustomerAccount: mockReconcileCustomerAccount,
}));

vi.mock("@/lib/queryClient", () => ({
  clearAuthScopedQueryCache: mockClearAuthScopedQueryCache,
}));
vi.mock("@/lib/flags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/flags")>(),
  createCustomerDiagnosticActionKeyWhenEnabled: () => "11111111-1111-4111-8111-111111111111",
  loadCustomerDiagnosticReporterWhenEnabled: () => Promise.resolve(diagnosticReporter),
}));

import CustomerProtectedRoute from "@/components/account/CustomerProtectedRoute";
import { CustomerAuthContext, type CustomerAuthContextValue } from "@/lib/customerAuthContext";
import { CUSTOMER_AUTH_BOOTSTRAP_TIMEOUT_MS, CustomerAuthProvider } from "@/lib/useCustomerAuth";

const SESSION: AuthSession = {
  accessToken: "customer-token",
  user: { id: "customer-user-1", email: "buyer@example.com" },
};

const PROFILE = {
  clientId: "11111111-1111-1111-1111-111111111111",
  email: "buyer@example.com",
  firstName: "Bart",
  lastName: null,
  lifecycleStage: "customer" as const,
};

let authStateListener: AuthStateListener | null = null;
let authActions: CustomerAuthContextValue | null = null;

function AuthActionsCapture() {
  authActions = useContext(CustomerAuthContext);
  return null;
}

function renderProtected(ui: ReactNode = <div>dashboard-body</div>) {
  return render(
    <CustomerAuthProvider>
      <MemoryRouter initialEntries={["/konto"]}>
        <Routes>
          <Route
            path="/konto"
            element={
              <CustomerProtectedRoute>
                {ui}
              </CustomerProtectedRoute>
            }
          />
          <Route path="/zaloguj-sie" element={<div>login-redirect-target</div>} />
        </Routes>
      </MemoryRouter>
    </CustomerAuthProvider>,
  );
}

describe("CustomerAuthProvider", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    authStateListener = null;
    mockAuthPort.getSession.mockResolvedValue(null);
    mockAuthPort.onAuthStateChange.mockImplementation((listener) => {
      authStateListener = listener;
      return () => {};
    });
    mockAuthPort.signInWithOtp.mockResolvedValue({ error: null });
    mockAuthPort.verifyOtpCode.mockResolvedValue({ error: null });
    mockAuthPort.signInWithOAuth.mockResolvedValue({ error: null });
    mockAuthPort.linkIdentity.mockResolvedValue({ error: null });
    mockAuthPort.signOut.mockResolvedValue(undefined);
    mockGetCustomerMe.mockResolvedValue(PROFILE);
    mockReconcileCustomerAccount.mockResolvedValue({
      accountId: PROFILE.clientId,
      created: false,
      linked: true,
    });
    mockClearAuthScopedQueryCache.mockClear();
    diagnosticReporter.reportCustomerJourneyDiagnostic.mockClear();
    authActions = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("settles to login when the initial session resolves to null", async () => {
    renderProtected();

    expect(await screen.findByText("login-redirect-target")).toBeInTheDocument();
    expect(screen.queryByText("dashboard-body")).not.toBeInTheDocument();
  });

  it("records closed bootstrap and sign-in action lifecycles", async () => {
    render(<CustomerAuthProvider><AuthActionsCapture /></CustomerAuthProvider>);
    await waitFor(() => expect(authActions).not.toBeNull());
    await act(async () => {
      await authActions!.signInWithOtp("buyer@example.com");
      await authActions!.signInWithOtpCode("buyer@example.com", "123456");
      await authActions!.signInWithOAuth("google", "https://example.test/callback");
    });

    await waitFor(() => expect(diagnosticReporter.reportCustomerJourneyDiagnostic.mock.calls.map(([event]) => event))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "auth_bootstrap", phase: "settled", code: "session_absent" }),
        expect.objectContaining({ action: "auth_magic_link", phase: "attempted", code: "observed" }),
        expect.objectContaining({ action: "auth_magic_link", phase: "settled", code: "succeeded" }),
        expect.objectContaining({ action: "auth_otp", phase: "attempted", code: "observed" }),
        expect.objectContaining({ action: "auth_otp", phase: "settled", code: "succeeded" }),
        expect.objectContaining({ action: "auth_oauth", phase: "attempted", code: "observed" }),
        expect.objectContaining({ action: "auth_oauth", phase: "settled", code: "succeeded" }),
      ])));
  });

  it.each([
    ["/konto/auth/callback?error_code=otp_expired", "callback_expired"],
    ["/account/auth/callback#error_code=bad_code_verifier", "callback_invalid"],
  ] as const)("keeps recognized callback failure %s when a session already exists", async (entry, expected) => {
    window.history.replaceState({}, "", entry);
    mockAuthPort.getSession.mockResolvedValueOnce(SESSION);

    render(<CustomerAuthProvider><AuthActionsCapture /></CustomerAuthProvider>);

    await waitFor(() => expect(authActions?.callbackOutcome).toBe(expected));
  });

  it("upgrades a provisional callback outcome after the authoritative session lookup succeeds", async () => {
    window.history.replaceState({}, "", "/konto/auth/callback");
    let resolveSession: (session: AuthSession) => void = () => {};
    mockAuthPort.getSession.mockReturnValueOnce(new Promise<AuthSession | null>((resolve) => {
      resolveSession = resolve;
    }));
    render(<CustomerAuthProvider><AuthActionsCapture /></CustomerAuthProvider>);
    await waitFor(() => expect(authStateListener).not.toBeNull());

    act(() => authStateListener?.(null));
    await waitFor(() => expect(authActions?.callbackOutcome).toBe("unknown"));
    await act(async () => resolveSession(SESSION));

    await waitFor(() => expect(authActions?.callbackOutcome).toBe("succeeded"));
  });

  it("keeps the authoritative unknown callback outcome after a later session event", async () => {
    window.history.replaceState({}, "", "/konto/auth/callback");

    render(<CustomerAuthProvider><AuthActionsCapture /></CustomerAuthProvider>);

    await waitFor(() => expect(authActions).toMatchObject({ loading: false, callbackOutcome: "unknown" }));
    act(() => authStateListener?.(SESSION));
    await waitFor(() => expect(authActions?.session).toEqual(SESSION));
    expect(authActions?.callbackOutcome).toBe("unknown");
  });

  /**
   * `window.location` is read only to classify the auth callback, but the
   * accessor itself can throw (a hardened page, an extension, a torn-down
   * document). Both readers run inside the bootstrap, so an unguarded throw
   * there aborts it and signs a signed-in customer out. Unreadable must degrade
   * to "no classification", never to "no session".
   */
  it("keeps the session and leaves the callback outcome unset when the location accessor throws", async () => {
    mockAuthPort.getSession.mockResolvedValueOnce(SESSION);
    const originalLocation = Object.getOwnPropertyDescriptor(window, "location")!;
    Object.defineProperty(window, "location", {
      configurable: true,
      get() { throw new Error("location blocked"); },
    });

    try {
      render(<CustomerAuthProvider><AuthActionsCapture /></CustomerAuthProvider>);

      await waitFor(() => expect(authActions?.session).toEqual(SESSION));
      expect(authActions?.loading).toBe(false);
      expect(authActions?.callbackOutcome ?? null).toBeNull();
    } finally {
      Object.defineProperty(window, "location", originalLocation);
    }
  });

  it("settles to login when the initial session lookup rejects", async () => {
    mockAuthPort.getSession.mockRejectedValueOnce(new Error("refresh failed"));

    renderProtected();

    expect(await screen.findByText("login-redirect-target")).toBeInTheDocument();
    expect(screen.queryByText("dashboard-body")).not.toBeInTheDocument();
  });

  it("settles to login when the initial session lookup never resolves", async () => {
    vi.useFakeTimers();
    mockAuthPort.getSession.mockReturnValueOnce(new Promise(() => {}));

    renderProtected();

    expect(document.querySelector(".animate-spin")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CUSTOMER_AUTH_BOOTSTRAP_TIMEOUT_MS + 1);
    });

    expect(screen.getByText("login-redirect-target")).toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).not.toBeInTheDocument();
  });

  it("settles to login when profile bootstrap never resolves", async () => {
    vi.useFakeTimers();
    mockAuthPort.getSession.mockResolvedValueOnce(SESSION);
    mockGetCustomerMe.mockReturnValueOnce(new Promise(() => {}));

    renderProtected();

    expect(document.querySelector(".animate-spin")).toBeInTheDocument();
    await act(async () => {});
    expect(mockGetCustomerMe).toHaveBeenCalledWith("customer-token");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CUSTOMER_AUTH_BOOTSTRAP_TIMEOUT_MS + 1);
    });

    expect(screen.getByText("login-redirect-target")).toBeInTheDocument();
    expect(screen.queryByText("dashboard-body")).not.toBeInTheDocument();
  });

  it("settles to login when profile lookup rejects", async () => {
    mockAuthPort.getSession.mockResolvedValueOnce(SESSION);
    mockGetCustomerMe.mockRejectedValue(new Error("profile failed"));

    renderProtected();

    expect(await screen.findByText("login-redirect-target")).toBeInTheDocument();
    expect(screen.queryByText("dashboard-body")).not.toBeInTheDocument();
  });

  it("renders protected content after a session and linked profile load", async () => {
    mockAuthPort.getSession.mockResolvedValueOnce(SESSION);

    renderProtected();

    expect(await screen.findByText("dashboard-body")).toBeInTheDocument();
    expect(mockReconcileCustomerAccount).toHaveBeenCalledWith("customer-token");
    expect(mockGetCustomerMe).toHaveBeenCalledWith("customer-token");
  });

  it("ignores repeated same-session auth events after the linked profile is loaded", async () => {
    mockAuthPort.getSession.mockResolvedValueOnce(SESSION);

    renderProtected();

    expect(await screen.findByText("dashboard-body")).toBeInTheDocument();
    expect(mockGetCustomerMe).toHaveBeenCalledTimes(1);

    act(() => {
      authStateListener?.(SESSION);
    });

    expect(screen.getByText("dashboard-body")).toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).not.toBeInTheDocument();
    expect(mockGetCustomerMe).toHaveBeenCalledTimes(1);
  });

  it("reloads the linked profile when the customer access token changes", async () => {
    mockAuthPort.getSession.mockResolvedValueOnce(SESSION);
    const refreshedSession: AuthSession = {
      ...SESSION,
      accessToken: "customer-token-2",
    };

    renderProtected();

    expect(await screen.findByText("dashboard-body")).toBeInTheDocument();
    expect(mockGetCustomerMe).toHaveBeenCalledTimes(1);

    act(() => {
      authStateListener?.(refreshedSession);
    });

    await waitFor(() => expect(mockGetCustomerMe).toHaveBeenCalledTimes(2));
    expect(mockGetCustomerMe).toHaveBeenLastCalledWith("customer-token-2");
    expect(await screen.findByText("dashboard-body")).toBeInTheDocument();
  });

  it("does not re-enter loading when a late initial session repeats the loaded listener session", async () => {
    let resolveSession: (session: AuthSession) => void = () => {};
    mockAuthPort.getSession.mockReturnValueOnce(
      new Promise<AuthSession | null>((resolve) => {
        resolveSession = resolve;
      }),
    );

    renderProtected();

    act(() => {
      authStateListener?.(SESSION);
    });

    await waitFor(() => expect(mockGetCustomerMe).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(document.querySelector(".animate-spin")).toBeInTheDocument();

    await act(async () => {
      resolveSession(SESSION);
    });

    expect(await screen.findByText("dashboard-body")).toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).not.toBeInTheDocument();
    expect(mockGetCustomerMe).toHaveBeenCalledTimes(1);
  });

  it("does not wait for reconcile when the first profile read is linked", async () => {
    mockAuthPort.getSession.mockResolvedValueOnce(SESSION);
    mockReconcileCustomerAccount.mockReturnValueOnce(new Promise(() => {}));
    mockGetCustomerMe.mockResolvedValueOnce(PROFILE);

    renderProtected();

    expect(await screen.findByText("dashboard-body")).toBeInTheDocument();
    expect(mockGetCustomerMe).toHaveBeenCalledTimes(1);
    expect(mockReconcileCustomerAccount).toHaveBeenCalledTimes(1);
  });

  it("awaits reconcile and re-reads the profile when the first read is unlinked", async () => {
    mockAuthPort.getSession.mockResolvedValueOnce(SESSION);
    mockGetCustomerMe.mockResolvedValueOnce(null).mockResolvedValueOnce(PROFILE);

    renderProtected();

    expect(await screen.findByText("dashboard-body")).toBeInTheDocument();
    expect(mockReconcileCustomerAccount).toHaveBeenCalledTimes(1);
    expect(mockGetCustomerMe).toHaveBeenCalledTimes(2);
  });

  it("settles to login when reconcile cannot provision an unlinked principal", async () => {
    mockAuthPort.getSession.mockResolvedValueOnce(SESSION);
    mockReconcileCustomerAccount.mockRejectedValueOnce(new Error("self-service-off"));
    mockGetCustomerMe.mockRejectedValue(new Error("profile missing"));

    renderProtected();

    expect(await screen.findByText("login-redirect-target")).toBeInTheDocument();
    expect(screen.queryByText("dashboard-body")).not.toBeInTheDocument();
  });
});
