import { createContext, useContext, type Dispatch, type SetStateAction } from 'react';
import type { AuthSession, AuthUser, OAuthProviderKind } from '@/domains/auth/types';
import type { CustomerMeResponse } from '@/domains/customers/contracts';

// Faza A W12.1 — hidden passwordless customer auth context.
// Mirrors `authContext.ts` but for the customer session. There is NO admin check
// here: customer auth and admin auth are fully independent. Session/user are the
// provider-agnostic shapes from the auth domain, not Supabase types.

export type CustomerProfile = CustomerMeResponse;
export type CustomerAuthCallbackOutcome =
  | "succeeded"
  | "callback_invalid"
  | "callback_expired"
  | "failed"
  | "unknown"
  | "timeout"
  | "transport_uncertain";

export interface CustomerAuthContextValue {
  user: AuthUser | null;
  session: AuthSession | null;
  loading: boolean;
  profile: CustomerProfile | null;
  /** Closed callback result only; the raw callback input stays inside auth setup. */
  callbackOutcome?: CustomerAuthCallbackOutcome | null;
  signInWithOtp: (email: string) => Promise<{ error: string | null }>;
  /**
   * Verify the one-time code from the magic-link email (the "link doesn't
   * work?" fallback) and establish a customer session.
   */
  signInWithOtpCode: (email: string, code: string) => Promise<{ error: string | null }>;
  // Starts a social OAuth redirect; `redirectTo` is the absolute callback URL.
  // On success the browser navigates away, so a resolved value means failure.
  signInWithOAuth: (
    provider: OAuthProviderKind,
    redirectTo: string,
  ) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

export const CustomerAuthContext = createContext<CustomerAuthContextValue | null>(null);

export function useCustomerAuth() {
  const ctx = useContext(CustomerAuthContext);
  if (!ctx) throw new Error('useCustomerAuth must be used within CustomerAuthProvider');
  return ctx;
}

/**
 * ⛔ The only read of `window.location` in the customer auth path.
 *
 * An extension, a hardened page or a torn-down jsdom can make the accessor
 * itself throw. Both callers below run inside the auth bootstrap, so a throw
 * there aborts the bootstrap and signs a signed-in customer out — a diagnostic
 * read taking down a session. Unreadable is therefore `null`, and the callers
 * degrade to "unknown"/no-op. Only the read is wrapped; never the state update.
 */
function readLocation(): Location | null {
  try {
    return typeof window === "undefined" ? null : window.location ?? null;
  } catch {
    return null;
  }
}

export function customerCallbackOutcomeFromLocation(): CustomerAuthCallbackOutcome {
  const location = readLocation();
  if (!location) return "unknown";
  const search = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const code = search.get("error_code") ?? hash.get("error_code");
  if (code === "otp_expired" || code === "flow_state_expired") return "callback_expired";
  if (code === "bad_code_verifier" || code === "bad_jwt" || code === "validation_failed") return "callback_invalid";
  return "unknown";
}

export function settleCustomerCallbackOutcome(
  setOutcome: Dispatch<SetStateAction<CustomerAuthCallbackOutcome | null>>,
  hint: CustomerAuthCallbackOutcome,
  session: AuthSession | null,
  error?: unknown,
  authoritative = false,
): void {
  const location = readLocation();
  if (!location || !["/konto/auth/callback", "/account/auth/callback"].includes(location.pathname)) return;
  const failure = error instanceof Error && error.message === "customer_auth_bootstrap_timeout"
    ? "timeout" : error instanceof TypeError ? "transport_uncertain" : "failed";
  const terminal = hint !== "unknown" ? hint : error ? failure : session?.user ? "succeeded" : hint;
  setOutcome((current) => current === null || (authoritative && current === "unknown") ? terminal : current);
}
