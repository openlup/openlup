import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { getCustomerAuthPort } from '@/lib/auth/customerAuthPortFactory';
import type { AuthSession, AuthUser, OAuthProviderKind } from '@/domains/auth/types';
import { getCustomerMe } from '@/domains/customers/customerMeClient';
import { reconcileCustomerAccount } from '@/domains/customers/customerReconcileClient';
import {
  CustomerAuthContext,
  customerCallbackOutcomeFromLocation,
  settleCustomerCallbackOutcome,
  type CustomerAuthCallbackOutcome,
  type CustomerProfile,
} from '@/lib/customerAuthContext';
import { clearAuthScopedQueryCache } from '@/lib/queryClient';
import { setCustomerJourneyAuthContext } from '@/lib/diagnostics/customerJourneyAuthContext';
import { createCustomerDiagnosticActionKeyWhenEnabled, loadCustomerDiagnosticReporterWhenEnabled } from '@/lib/flags';

// Faza A W12.1 — hidden passwordless customer auth provider.
//
// Mirrors `useAuth.tsx` (admin) but PASSWORDLESS: the only sign-in path requests
// a magic link via the customers BFF. There is NO admin check. The provider uses
// the separate customer Supabase client for session/callback handling only.
//
// The BFF uses `shouldCreateUser: false` on purpose: customer auth users are
// provisioned server-side at checkout (linkClientAuthUser, email_confirm), so
// the magic-link flow only authenticates EXISTING identities and never silently
// creates an unlinked auth.users row from this hidden surface.
//
// Route-scoped: mounted ONLY around /konto* and /zaloguj-sie in App.tsx, and only
// when the build-time VITE_COMMERCE_V2_W12_CUSTOMER_AUTH_UI flag is on.

export const CUSTOMER_AUTH_BOOTSTRAP_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs = CUSTOMER_AUTH_BOOTSTRAP_TIMEOUT_MS): Promise<T> {
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = globalThis.setTimeout(() => {
      reject(new Error('customer_auth_bootstrap_timeout'));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) globalThis.clearTimeout(timeoutId);
  });
}

async function loadCustomerProfile(accessToken: string): Promise<CustomerProfile | null> {
  const reconcilePromise = reconcileCustomerAccount(accessToken).catch(() => undefined);
  const readProfile = async (): Promise<CustomerProfile | null> => {
    try {
      return await getCustomerMe(accessToken);
    } catch {
      return null;
    }
  };

  const profile = await readProfile();
  if (profile) return profile;

  await reconcilePromise;
  return readProfile();
}

export function CustomerAuthProvider({ children }: { children: ReactNode }) {
  const { i18n, t } = useTranslation("account");
  // The provider is the last safe owner of callback input: the adapter may
  // consume it while it initializes, so retain only the closed classification
  // before creating that adapter and never expose the source value.
  const callbackOutcomeHint = useMemo(() => customerCallbackOutcomeFromLocation(), []);
  const authPort = useMemo(() => getCustomerAuthPort(), []);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileLoadRevision, setProfileLoadRevision] = useState(0);
  const [callbackOutcome, setCallbackOutcome] = useState<CustomerAuthCallbackOutcome | null>(null);
  const principalRef = useRef<string | null>(null);
  const sessionRef = useRef<AuthSession | null>(null);
  const profileRef = useRef<CustomerProfile | null>(null);
  const profileLoadingRef = useRef(false);

  const setProfileState = useCallback((nextProfile: CustomerProfile | null) => {
    profileRef.current = nextProfile;
    setProfile(nextProfile);
  }, []);

  const setProfileLoadingState = useCallback((nextLoading: boolean) => {
    profileLoadingRef.current = nextLoading;
    setProfileLoading(nextLoading);
  }, []);

  const applySession = useCallback((nextSession: AuthSession | null, forceClear = false) => {
    const nextPrincipal = nextSession?.user?.id ?? null;
    if (forceClear || principalRef.current !== nextPrincipal) {
      clearAuthScopedQueryCache();
      principalRef.current = nextPrincipal;
    }
    sessionRef.current = nextSession;
    setCustomerJourneyAuthContext(nextSession?.accessToken ?? null);
    setSession(nextSession);
    setUser(nextSession?.user ?? null);
  }, []);

  // Session lifecycle. When a user is present we immediately mark the profile as
  // loading so the combined `loading` stays true until the profile resolves —
  // closing the race where a logged-in-but-unlinked user is briefly treated as
  // "ready" and bounced by CustomerProtectedRoute.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const s = await withTimeout(authPort.getSession());
        if (cancelled) return;
        const previousSession = sessionRef.current;
        const previousToken = previousSession?.accessToken ?? null;
        const previousPrincipal = previousSession?.user?.id ?? null;
        const nextToken = s?.accessToken ?? null;
        const nextPrincipal = s?.user?.id ?? null;
        applySession(s);
        if (s?.user) {
          const shouldLoadProfile =
            nextToken !== previousToken ||
            nextPrincipal !== previousPrincipal ||
            (!profileRef.current && !profileLoadingRef.current);

          if (shouldLoadProfile) {
            setProfileLoadingState(true);
            if (nextToken === previousToken) {
              setProfileLoadRevision((revision) => revision + 1);
            }
          }
        } else {
          setProfileState(null);
          setProfileLoadingState(false);
        }
        settleCustomerCallbackOutcome(setCallbackOutcome, callbackOutcomeHint, s, undefined, true);
        reportAuthDiagnostic("auth_bootstrap", "settled", s?.user ? "session_present" : "session_absent", s?.accessToken ?? null);
      } catch (error) {
        if (cancelled) return;
        reportAuthDiagnostic(
          "auth_bootstrap",
          "settled",
          error instanceof Error && error.message === "customer_auth_bootstrap_timeout" ? "timeout" : "failed",
          null,
        );
        applySession(null, true);
        setProfileState(null);
        setProfileLoadingState(false);
        settleCustomerCallbackOutcome(setCallbackOutcome, callbackOutcomeHint, null, error, true);
      } finally {
        if (!cancelled) setSessionLoading(false);
      }
    })();

    const unsubscribe = authPort.onAuthStateChange((s) => {
      const previousSession = sessionRef.current;
      const previousToken = previousSession?.accessToken ?? null;
      const previousPrincipal = previousSession?.user?.id ?? null;
      const nextToken = s?.accessToken ?? null;
      const nextPrincipal = s?.user?.id ?? null;
      applySession(s);
      if (s?.user) {
        const shouldLoadProfile =
          nextToken !== previousToken ||
          nextPrincipal !== previousPrincipal ||
          (!profileRef.current && !profileLoadingRef.current);

        if (shouldLoadProfile) {
          setProfileLoadingState(true);
          if (nextToken === previousToken) {
            setProfileLoadRevision((revision) => revision + 1);
          }
        }
      } else {
        setProfileState(null);
        setProfileLoadingState(false);
      }
      settleCustomerCallbackOutcome(setCallbackOutcome, callbackOutcomeHint, s);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applySession, authPort, callbackOutcomeHint, setProfileLoadingState, setProfileState]);

  // Profile lifecycle — runs whenever the access token changes (incl. right
  // after a magic-link or OAuth callback establishes a session).
  //
  // Reconcile (provisioning a brand-new social user / relinking an existing
  // customer) runs in parallel with the profile read instead of strictly before
  // it. Returning customers are already provisioned, so `getCustomerMe` resolves
  // a linked profile on the first read and gates `CustomerProtectedRoute`
  // immediately while reconcile finishes in the background, saving one serial
  // round-trip on the hot login→/konto path. Only a not-yet-linked principal
  // reads back null; for that case we await reconcile and read once more,
  // preserving the prior "never observe an unprovisioned user as ready" behavior.
  // The whole bootstrap still runs under `withTimeout` so the route cannot hang.
  const accessToken = session?.accessToken ?? null;
  useEffect(() => {
    let cancelled = false;
    if (!accessToken) {
      setProfileState(null);
      setProfileLoadingState(false);
      return;
    }
    setProfileLoadingState(true);
    (async () => {
      try {
        const p = await withTimeout(loadCustomerProfile(accessToken));
        if (!p) reportAuthDiagnostic("auth_bootstrap", "settled", "profile_unavailable", accessToken);
        if (!cancelled) setProfileState(p);
      } catch {
        reportAuthDiagnostic("auth_bootstrap", "settled", "profile_unavailable", accessToken);
        if (!cancelled) setProfileState(null);
      } finally {
        if (!cancelled) setProfileLoadingState(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, profileLoadRevision, setProfileLoadingState, setProfileState]);

  const signInWithOtp = useCallback(
    async (email: string): Promise<{ error: string | null }> => {
      const clientActionKey = createAuthDiagnosticActionKey();
      reportAuthDiagnostic("auth_magic_link", "attempted", "observed", sessionRef.current?.accessToken ?? null, clientActionKey);
      const { error } = await authPort.signInWithOtp({ email, locale: i18n.language });
      reportAuthDiagnostic("auth_magic_link", "settled", error ? "rejected" : "succeeded", sessionRef.current?.accessToken ?? null, clientActionKey);
      return { error: error ? t("account:login.sendError") : null };
    },
    [authPort, i18n.language, t],
  );

  const signInWithOtpCode = useCallback(
    async (email: string, code: string): Promise<{ error: string | null }> => {
      const clientActionKey = createAuthDiagnosticActionKey();
      reportAuthDiagnostic("auth_otp", "attempted", "observed", sessionRef.current?.accessToken ?? null, clientActionKey);
      const { error } = await authPort.verifyOtpCode({ email, token: code });
      reportAuthDiagnostic("auth_otp", "settled", error ? "rejected" : "succeeded", sessionRef.current?.accessToken ?? null, clientActionKey);
      return { error: error ? t("account:login.codeError") : null };
    },
    [authPort, t],
  );

  const signInWithOAuth = useCallback(
    async (
      provider: OAuthProviderKind,
      redirectTo: string,
    ): Promise<{ error: string | null }> => {
      const clientActionKey = createAuthDiagnosticActionKey();
      reportAuthDiagnostic("auth_oauth", "attempted", "observed", sessionRef.current?.accessToken ?? null, clientActionKey);
      const { error } = await authPort.signInWithOAuth({ provider, redirectTo });
      reportAuthDiagnostic("auth_oauth", "settled", error ? "rejected" : "succeeded", sessionRef.current?.accessToken ?? null, clientActionKey);
      return { error: error ? t("account:login.social.error") : null };
    },
    [authPort, t],
  );

  const signOut = useCallback(async () => {
    await authPort.signOut();
    applySession(null, true);
    setProfileState(null);
    setProfileLoadingState(false);
  }, [applySession, authPort, setProfileLoadingState, setProfileState]);

  return (
    <CustomerAuthContext.Provider
      value={{
        user,
        session,
        loading: sessionLoading || profileLoading,
        profile,
        callbackOutcome,
        signInWithOtp,
        signInWithOtpCode,
        signInWithOAuth,
        signOut,
      }}
    >
      {children}
    </CustomerAuthContext.Provider>
  );
}

function reportAuthDiagnostic(action: "auth_bootstrap" | "auth_magic_link" | "auth_otp" | "auth_oauth", phase: "attempted" | "settled", code: "observed" | "succeeded" | "rejected" | "session_present" | "session_absent" | "profile_unavailable" | "timeout" | "failed", accessToken: string | null, clientActionKey?: string): void {
  try {
    void loadCustomerDiagnosticReporterWhenEnabled?.()?.then((reporter) => {
      try { reporter?.reportCustomerJourneyDiagnostic({ action, phase, code, ...(clientActionKey ? { clientActionKey } : {}) }, accessToken); } catch { /* best effort */ }
    }).catch(() => undefined);
  } catch { /* Diagnostics never affect authentication. */ }
}

function createAuthDiagnosticActionKey(): string | undefined {
  try { return createCustomerDiagnosticActionKeyWhenEnabled?.(); } catch { return undefined; }
}
