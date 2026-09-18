import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { User, Session } from '@supabase/supabase-js';
import { AuthContext, type AdminRole } from '@/lib/authContext';
import { getAdminPlatformMe } from '@/domains/platform/adminMeClient';
import { clearAuthScopedQueryCache } from '@/lib/queryClient';

export function AuthProvider({ children }: { children: ReactNode }) {
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

  // On mount: check existing session
  useEffect(() => {
    let cancelled = false;

    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      if (cancelled) return;
      applySession(s);
      if (s?.user) {
        const result = await checkAdmin(s.access_token);
        if (!cancelled) {
          setIsAdmin(result.isAdmin);
          setRole(result.role);
        }
      }
      if (!cancelled) setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, s) => {
        // Only update session/user synchronously — don't do async admin check here
        // to avoid race conditions
        applySession(s);
        if (!s?.user) {
          setIsAdmin(false);
          setRole(null);
        }
      }
    );

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [applySession, checkAdmin]);

  async function signIn(email: string, password: string): Promise<{ error: string | null }> {
    try {
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
    await supabase.auth.signOut();
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
    <AuthContext.Provider value={{ user, session, loading, isAdmin, role, signIn, signInWithOtpCode, signOut, refreshAdmin }}>
      {children}
    </AuthContext.Provider>
  );
}
