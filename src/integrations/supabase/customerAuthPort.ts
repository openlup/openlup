import type { Session } from '@supabase/supabase-js';
import { clearCustomerSessionStorage, getCustomerSupabase } from './customerClient';
import { requestCustomerMagicLink } from '@/domains/customers/customerMagicLinkClient';
import type { CustomerAuthPort } from '@/domains/auth/ports';
import type { AuthSession, AuthStateListener, OAuthProviderKind } from '@/domains/auth/types';
import { readCustomerReturnTo } from '@/lib/customerRecoverySession';

// Supabase adapter for the generic `CustomerAuthPort`. This is the ONLY place in
// `src/` allowed to call `supabase.auth.*` (enforced by authBoundary.test.ts) —
// it confines the Supabase coupling so the OSS core (src/domains/auth) and the
// UI/session code depend only on the provider-agnostic port.
//
// Magic-link delivery is a BFF call (`requestCustomerMagicLink`), not a
// client auth call; it lives here so the hook depends only on the port.

// Email is always requested so accounts can be deduplicated server-side by
// verified email. Google returns it by default; Facebook/Apple need it explicit.
const OAUTH_SCOPES: Record<OAuthProviderKind, string | undefined> = {
  google: undefined,
  facebook: 'email',
  apple: 'email name',
};

function toAuthSession(session: Session | null): AuthSession | null {
  if (!session?.user) return null;
  return {
    accessToken: session.access_token,
    user: { id: session.user.id, email: session.user.email ?? null },
  };
}

export function createSupabaseCustomerAuthPort(): CustomerAuthPort {
  const supabase = getCustomerSupabase();
  return {
    async getSession() {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      return toAuthSession(data.session);
    },

    onAuthStateChange(listener: AuthStateListener) {
      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, session) => {
        listener(toAuthSession(session));
      });
      return () => subscription.unsubscribe();
    },

    async signInWithOtp({ email, locale }) {
      try {
        await requestCustomerMagicLink(email, locale === 'en' ? 'en' : 'pl', {
          returnTo: readCustomerReturnTo(),
        });
        return { error: null };
      } catch {
        return { error: 'magic_link_send_failed' };
      }
    },

    async verifyOtpCode({ email, token }) {
      const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
      return { error: error?.message ?? null };
    },

    async signInWithOAuth({ provider, redirectTo }) {
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo, scopes: OAUTH_SCOPES[provider] },
      });
      return { error: error?.message ?? null };
    },

    async linkIdentity({ provider, redirectTo }) {
      const { error } = await supabase.auth.linkIdentity({
        provider,
        options: { redirectTo, scopes: OAUTH_SCOPES[provider] },
      });
      return { error: error?.message ?? null };
    },

    async signOut() {
      try {
        await supabase.auth.signOut();
      } catch { /* Local logout must complete even if remote revocation throws. */ }
      // With the stored session removed, SDK cleanup has no bearer to send remotely.
      clearCustomerSessionStorage();
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
    },
  };
}
