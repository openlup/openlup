/** @vitest-environment jsdom -- exercises the browser mount/redirect order and storage carrier. */
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import CustomerPaymentRecoveryRoute from "@/components/account/CustomerPaymentRecoveryRoute";
import {
  CustomerAuthContext,
  type CustomerAuthContextValue,
} from "@/lib/customerAuthContext";
import {
  clearPaymentRecoverySession,
  readPaymentRecoveryToken,
  PAYMENT_RECOVERY_TOKEN_STORAGE_KEY,
} from "@/lib/customerRecoverySession";

const RECOVERY_PATH = "/konto/platnosc/napraw";
const TOKEN = "a".repeat(64);

function authValue(authenticated: boolean): CustomerAuthContextValue {
  return {
    user: authenticated ? ({ id: "auth-user-1" } as never) : null,
    session: authenticated ? ({ accessToken: "acc-token" } as never) : null,
    profile: authenticated
      ? ({
          clientId: "11111111-1111-1111-1111-111111111111",
          email: "buyer@example.com",
          firstName: "Bart",
          lastName: null,
          lifecycleStage: "customer",
        } as never)
      : null,
    loading: false,
    signInWithOtp: vi.fn(),
    signInWithOtpCode: vi.fn(),
    signInWithOAuth: vi.fn(),
    signOut: vi.fn(),
  } as unknown as CustomerAuthContextValue;
}

/**
 * Reads the carrier at page-render time — exactly what RecoverPaymentPage does
 * with `useState(() => readPaymentRecoveryToken())`.
 */
function TokenProbe() {
  return <div data-testid="page-token">{readPaymentRecoveryToken() ?? "no-token"}</div>;
}

function renderAt(url: string, authenticated: boolean) {
  window.history.replaceState(null, "", url);
  return render(
    <CustomerAuthContext.Provider value={authValue(authenticated)}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path={RECOVERY_PATH}
            element={
              <CustomerPaymentRecoveryRoute>
                <TokenProbe />
              </CustomerPaymentRecoveryRoute>
            }
          />
          <Route path="*" element={<div data-testid="login-page">login</div>} />
        </Routes>
      </MemoryRouter>
    </CustomerAuthContext.Provider>,
  );
}

afterEach(() => {
  clearPaymentRecoverySession();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

/**
 * The dunning email's CTA is the only way most customers ever reach this page,
 * and it lands on a session-gated route while they are logged out. The token
 * survives that bounce only because the capture happens in the wrapper's render
 * body, ahead of the guard's `<Navigate>`; `returnTo` deliberately cannot carry
 * it. Nothing pinned that ordering before, so a refactor that moved the capture
 * into an effect — the reflex tidy-up — would have broken every recovery link
 * while leaving the whole suite green.
 */
describe("CustomerPaymentRecoveryRoute token continuity across the login redirect", () => {
  it("captures the token into the carrier before bouncing a logged-out visitor to login", () => {
    renderAt(`${RECOVERY_PATH}?token=${TOKEN}`, false);

    expect(screen.getByTestId("login-page")).toBeInTheDocument();
    expect(screen.queryByTestId("page-token")).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(PAYMENT_RECOVERY_TOKEN_STORAGE_KEY)).toBe(TOKEN);
    expect(window.location.search).not.toContain("token=");
  });

  it("serves the return visit from the carrier when the URL no longer carries the token", () => {
    window.sessionStorage.setItem(PAYMENT_RECOVERY_TOKEN_STORAGE_KEY, TOKEN);

    renderAt(RECOVERY_PATH, true);

    expect(screen.getByTestId("page-token")).toHaveTextContent(TOKEN);
  });

  it("leaves a logged-in visit with a URL token on the page with that token", () => {
    renderAt(`${RECOVERY_PATH}?token=${TOKEN}`, true);

    expect(screen.getByTestId("page-token")).toHaveTextContent(TOKEN);
    expect(window.sessionStorage.getItem(PAYMENT_RECOVERY_TOKEN_STORAGE_KEY)).toBe(TOKEN);
  });

  it("shows the invalid-token state once the carrier is cleared after redeem", () => {
    window.sessionStorage.setItem(PAYMENT_RECOVERY_TOKEN_STORAGE_KEY, TOKEN);
    clearPaymentRecoverySession();

    renderAt(RECOVERY_PATH, true);

    expect(screen.getByTestId("page-token")).toHaveTextContent("no-token");
  });
});
