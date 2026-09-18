import { createContext, useContext } from 'react';
import type { Session, User } from '@supabase/supabase-js';

export type AdminRole = 'admin' | 'distributor' | null;

export interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  isAdmin: boolean;
  role: AdminRole;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  /**
   * Verify the one-time code from the magic-link email (the `Nie działa link?`
   * fallback) and establish an admin session. Mirrors `signIn`: rejects + signs
   * out a non-admin principal.
   */
  signInWithOtpCode: (email: string, code: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshAdmin: (nextSession?: Session | null) => Promise<{ isAdmin: boolean; role: AdminRole }>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
