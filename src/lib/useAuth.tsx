import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { loadManagedAdminAuth } from '@/integrations/supabase/adminAuthPort';
import { createPostgresOperatorAuthPort } from '@/integrations/postgres/operatorAuthPort';
import { isDirectOperatorAuth, type AdminSession as Session } from '@/domains/auth/adminAuth';
type User = Session['user'];


import { AuthContext, type AdminRole } from '@/lib/authContext';
import { getAdminPlatformMe } from '@/domains/platform/adminMeClient';
import { clearAuthScopedQueryCache } from '@/lib/queryClient';

export function AuthProvider({ children, providerKind }: { children: ReactNode; providerKind?: string }) {
  const [directPort] = useState(() => isDirectOperatorAuth(providerKind) ? createPostgresOperatorAuthPort() : null);
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [role, setRole] = useState<AdminRole>(null);
  const principalRef = useRef<string | null>(null);
  const sessionRef = useRef<Session | null>(null);

  const checkAdmin = useCallback(async (accessToken: string | null | undefined): Promise<{ isAdmin: boolean; role: AdminRole }> => {
    if (!accessToken) return { isAdmin: false, role: null };

    try {
      const result = await getAdminPlatformMe(accessToken);
      return { isAdmin: result.isAdmin === true, role: result.role ?? null };
    } catch {
      return { isAdmin: false, role: null };
    }
  }, []);

  const applySession = useCallback((nextSession: Session | null, forceClear = false) => {
    const nextPrincipal = nextSession?.user?.id ?? null;
    if (forceClear || principalRef.current !== nextPrincipal) {
      clearAuthScopedQueryCache();
      principalRef.current = nextPrincipal;
    }
    sessionRef.current = nextSession;
    setSession(nextSession);
    setUser(nextSession?.user ?? null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    let revision = 0;
    async function accept(next: Session | null) {
      const current = ++revision;
      const result = await checkAdmin(next?.access_token);
      if (cancelled || current !== revision) return;
      applySession(next);
      setIsAdmin(result.isAdmin);
      setRole(result.role);
      setLoading(false);
    }
    if (directPort) {
      unsubscribe = directPort.onAuthStateChange(next => {
        if (!cancelled) void accept(next ? { access_token: next.accessToken, user: next.user } : null);
      });
      void directPort.getSession().then(next => accept(next ? { access_token: next.accessToken, user: next.user } : null));
    } else {
      void loadManagedAdminAuth().then(({ supabase }) => {
        if (cancelled) return;
        void supabase.auth.getSession().then(({ data }) => accept(data.session));
        const { data } = supabase.auth.onAuthStateChange((_event, next) => {
          applySession(next);
          if (!next) { setIsAdmin(false); setRole(null); }
        });
        unsubscribe = () => data.subscription.unsubscribe();
      });
    }
    const focused = () => { if (directPort) void directPort.getSession(); };
    window.addEventListener('focus', focused);
    return () => { cancelled = true; unsubscribe(); window.removeEventListener('focus', focused); };
  }, [applySession, checkAdmin, directPort]);

  async function signIn(email: string, password: string): Promise<{ error: string | null }> {
    if (directPort) return { error: 'Password authentication unavailable' };
    try {
      const { supabase } = await loadManagedAdminAuth();
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return { error: error.message };
      if (!data.user) return { error: 'No user returned' };

      // Set state immediately
      applySession(data.session, true);

      // Check admin
      const result = await checkAdmin(data.session?.access_token);
      setIsAdmin(result.isAdmin);
      setRole(result.role);

      if (!result.isAdmin) {
        await supabase.auth.signOut();
        applySession(null, true);
        setIsAdmin(false);
        setRole(null);
        return { error: 'You are not an admin' };
      }

      return { error: null };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : 'Connection error' };
    }
  }

  async function signInWithOtpCode(email: string, code: string): Promise<{ error: string | null }> {
    try {
      if (directPort) {
        await directPort.verifyChallenge(code);
        return { error: null };
      }
      const { supabase } = await loadManagedAdminAuth();
      // The magic-link email's `Nie działa link?` code fallback is an `email`-OTP
      // code; `magiclink` is the action type Supabase sent it under.
      const { data, error } = await supabase.auth.verifyOtp({
        email,
        token: code,
        type: 'magiclink',
      });
      if (error) return { error: error.message };
      if (!data.user) return { error: 'No user returned' };

      applySession(data.session, true);

      const result = await checkAdmin(data.session?.access_token);
      setIsAdmin(result.isAdmin);
      setRole(result.role);

      if (!result.isAdmin) {
        await supabase.auth.signOut();
        applySession(null, true);
        setIsAdmin(false);
        setRole(null);
        return { error: 'You are not an admin' };
      }

      return { error: null };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : 'Connection error' };
    }
  }

  async function signOut() {
    if (directPort) await directPort.signOut();
    else { const { supabase } = await loadManagedAdminAuth(); await supabase.auth.signOut(); }
    applySession(null, true);
    setIsAdmin(false);
    setRole(null);
  }

  const refreshAdmin = useCallback(async (nextSession?: Session | null) => {
    const sessionToCheck = nextSession === undefined ? sessionRef.current : nextSession;
    if (nextSession !== undefined) {
      applySession(nextSession, true);
    }
    if (!sessionToCheck) {
      setIsAdmin(false);
      setRole(null);
      return { isAdmin: false, role: null };
    }

    const result = await checkAdmin(sessionToCheck.access_token);
    setIsAdmin(result.isAdmin);
    setRole(result.role);
    return result;
  }, [applySession, checkAdmin]);

  return (
    <AuthContext.Provider value={{ directOperatorAuth: !!directPort, user, session, loading, isAdmin, role, signIn, signInWithOtpCode, signOut, refreshAdmin }}>
      {children}
    </AuthContext.Provider>
  );
}
