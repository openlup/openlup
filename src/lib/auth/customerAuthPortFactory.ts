import type { CustomerAuthPort, OAuthProviderKind } from '@openlup/platform/identity/contracts';
import { getEnabledSocialProviders } from './socialProviders';
import { removeStorageItem } from '@/lib/browserStorage';

export interface CustomerSignInOptions {
  codeFormat: 'numeric' | 'opaque';
  socialProviders: readonly { kind: OAuthProviderKind; displayName: string }[];
}
export interface CustomerAuthBinding {
  port: CustomerAuthPort;
  signInOptions: CustomerSignInOptions;
  reconcileAccount: boolean;
}

export async function getCustomerAuthBinding(): Promise<CustomerAuthBinding> {
  // Discard superseded customer encodings; they are never authentication evidence.
  for (const key of ['openlup-customer', 'openlup.customer.session.v1', 'openlup-last-login']) {
    removeStorageItem('localStorage', key);
  }
  for (const key of ['openlup.reference.customerToken', 'openlup.reference.accountId']) {
    removeStorageItem('sessionStorage', key);
  }
  const kind = import.meta.env.VITE_COMMERCE_AUTH_PROVIDER_KIND;
  if (kind === 'postgres' || kind === 'node-postgres') {
    const { createPostgresCustomerAuthPort } = await import('@/integrations/postgres/customerAuthPort');
    return { port: createPostgresCustomerAuthPort(), reconcileAccount: false,
      signInOptions: { codeFormat: 'opaque', socialProviders: [] } };
  }
  const [{ createSupabaseCustomerAuthPort }, { customerSocialProviders }] = await Promise.all([
    import('@/integrations/supabase/customerAuthPort'), import('@/integrations/supabase/customerClient'),
  ]);
  return { port: createSupabaseCustomerAuthPort(), reconcileAccount: true,
    signInOptions: { codeFormat: 'numeric', socialProviders: customerSocialProviders(getEnabledSocialProviders()) } };
}

/** Preserve synchronous port construction for existing session-presence consumers. */
export function getCustomerAuthPort(): CustomerAuthPort {
  const binding = getCustomerAuthBinding();
  return {
    getSession: async () => (await binding).port.getSession(),
    onAuthStateChange(listener) {
      let cancelled = false;
      let unsubscribe: (() => void) | undefined;
      void binding.then(({ port }) => { if (!cancelled) unsubscribe = port.onAuthStateChange(listener); }).catch(() => undefined);
      return () => { cancelled = true; unsubscribe?.(); };
    },
    signInWithOtp: async (input) => (await binding).port.signInWithOtp(input),
    verifyOtpCode: async (input) => (await binding).port.verifyOtpCode(input),
    signInWithOAuth: async (input) => (await binding).port.signInWithOAuth(input),
    linkIdentity: async (input) => (await binding).port.linkIdentity(input),
    signOut: async () => (await binding).port.signOut(),
  };
}
