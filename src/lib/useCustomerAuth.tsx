import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { getCustomerAuthBinding, type CustomerAuthBinding } from '@/lib/auth/customerAuthPortFactory';
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

// One customer session owner for login, callback and account.

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

async function loadCustomerProfile(accessToken: string, reconcile: boolean): Promise<CustomerProfile | null> {
  const reconcilePromise = reconcile ? reconcileCustomerAccount(accessToken).catch(() => undefined) : Promise.resolve();
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
  const [binding, setBinding] = useState<CustomerAuthBinding | null>(null);
  const authPort = binding?.port;
  const revision = useRef(0);
  const sessionEventsBlocked = useRef(false);
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

  const setProfileState = useCallback((nextProfile: CustomerProfile | null) => {
    profileRef.current = nextProfile;
    setProfile(nextProfile);
  }, []);

  const setProfileLoadingState = useCallback((nextLoading: boolean) => {
    setProfileLoading(nextLoading);
  }, []);

  const applySession = useCallback((nextSession: AuthSession | null, forceClear = false) => {
    const nextPrincipal = nextSession?.user?.id ?? null;
    if (forceClear || principalRef.current !== nextPrincipal) {
      clearAuthScopedQueryCache();
      principalRef.current = nextPrincipal;
      setProfileState(null);
    }
    sessionRef.current = nextSession;
    setCustomerJourneyAuthContext(nextSession?.accessToken ?? null);
    setSession(nextSession);
    setUser(nextSession?.user ?? null);
  }, [setProfileState]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const initialRevision = revision.current;
    const receive = (next: AuthSession | null) => {
      if (cancelled || (next && sessionEventsBlocked.current)) return;
      const previous = sessionRef.current;
      if (next || previous) revision.current += 1;
      applySession(next);
      if (next && (previous?.accessToken !== next.accessToken || !profileRef.current)) {
        setProfileLoadingState(true);
        setProfileLoadRevision((value) => value + 1);
      } else if (!next) {
        setProfileState(null);
        setProfileLoadingState(false);
      }
      setSessionLoading(false);
      settleCustomerCallbackOutcome(setCallbackOutcome, callbackOutcomeHint, next);
    };
    void (async () => {
      try {
        const selected = await withTimeout(getCustomerAuthBinding());
        if (cancelled) return;
        // A logout during adapter loading must also discard its persisted session.
        if (revision.current !== initialRevision) {
          await selected.port.signOut();
          if (cancelled) return;
        }
        setBinding(selected);
        unsubscribe = selected.port.onAuthStateChange(receive);
        const bootstrapRevision = revision.current;
        const next = await withTimeout(selected.port.getSession());
        if (cancelled || revision.current !== bootstrapRevision || bootstrapRevision !== initialRevision) return;
        receive(next);
        settleCustomerCallbackOutcome(setCallbackOutcome, callbackOutcomeHint, next, undefined, true);
        reportAuthDiagnostic("auth_bootstrap", "settled", next ? "session_present" : "session_absent", next?.accessToken ?? null);
      } catch (error) {
        if (cancelled || revision.current !== initialRevision) return;
        reportAuthDiagnostic("auth_bootstrap", "settled", error instanceof Error && error.message === "customer_auth_bootstrap_timeout" ? "timeout" : "failed", null);
        receive(null);
        settleCustomerCallbackOutcome(setCallbackOutcome, callbackOutcomeHint, null, error, true);
      } finally {
        // The SDK consumes callback input before this cleanup. Never retain credentials or descriptions.
        try {
          if (!cancelled && ["/account/auth/callback", "/konto/auth/callback"].includes(window.location.pathname)) {
            window.history.replaceState(window.history.state, "", window.location.pathname);
          }
        } catch { /* A denied location accessor cannot invalidate a session. */ }
      }
    })();
    return () => { cancelled = true; unsubscribe?.(); };
  }, [applySession, callbackOutcomeHint, setProfileLoadingState, setProfileState]);

  // Profile reads cannot survive logout or a newer session.
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
        const expectedRevision = revision.current;
        const p = await withTimeout(loadCustomerProfile(accessToken, binding?.reconcileAccount ?? false));
        if (expectedRevision !== revision.current || sessionRef.current?.accessToken !== accessToken) return;
        if (!p) reportAuthDiagnostic("auth_bootstrap", "settled", "profile_unavailable", accessToken);
        if (!cancelled) setProfileState(p);
      } catch {
        reportAuthDiagnostic("auth_bootstrap", "settled", "profile_unavailable", accessToken);
        if (!cancelled && sessionRef.current?.accessToken === accessToken) setProfileState(null);
      } finally {
        if (!cancelled && sessionRef.current?.accessToken === accessToken) setProfileLoadingState(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, binding, profileLoadRevision, setProfileLoadingState, setProfileState]);

  const signInWithOtp = useCallback(
    async (email: string): Promise<{ error: string | null }> => {
      const clientActionKey = createAuthDiagnosticActionKey();
      reportAuthDiagnostic("auth_magic_link", "attempted", "observed", sessionRef.current?.accessToken ?? null, clientActionKey);
      if (!authPort) return { error: t("account:login.sendError") };
      sessionEventsBlocked.current = false;
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
      if (!authPort) return { error: t("account:login.codeError") };
      sessionEventsBlocked.current = false;
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
      if (!authPort) return { error: t("account:login.social.error") };
      sessionEventsBlocked.current = false;
      const { error } = await authPort.signInWithOAuth({ provider, redirectTo });
      reportAuthDiagnostic("auth_oauth", "settled", error ? "rejected" : "succeeded", sessionRef.current?.accessToken ?? null, clientActionKey);
      return { error: error ? t("account:login.social.error") : null };
    },
    [authPort, t],
  );

  const signOut = useCallback(async () => {
    sessionEventsBlocked.current = true;
    revision.current += 1;
    applySession(null, true);
    setProfileState(null);
    setProfileLoadingState(false);
    setSessionLoading(false);
    await authPort?.signOut();
  }, [applySession, authPort, setProfileLoadingState, setProfileState]);

  return (
    <CustomerAuthContext.Provider
      value={{
        signInOptions: binding?.signInOptions,
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
