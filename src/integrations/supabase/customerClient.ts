import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { resolveSupabasePublishableKey } from './keyResolution';
import { createMemoryStorage, resolveStorageOrMemory } from '@/lib/browserStorage';

// Separate, lazy customer client; operator sessions use their own namespace.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = resolveSupabasePublishableKey({
  VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
});

export const CUSTOMER_AUTH_STORAGE_KEY = 'customer.auth.managed.v1';
export const CUSTOMER_AUTH_CALLBACK_PATH = '/konto/auth/callback';
export const CUSTOMER_AUTH_CALLBACK_PATH_EN = '/account/auth/callback';

let customerSupabase: SupabaseClient<Database> | null = null;
let customerSessionStorage: Pick<Storage, 'removeItem'> | null = null;

/** Clear the effective store, including its same-document memory fallback. */
export function clearCustomerSessionStorage(): void {
  customerSessionStorage?.removeItem(CUSTOMER_AUTH_STORAGE_KEY);
}

export function shouldDetectCustomerSessionInUrl(url: URL): boolean {
  return url.pathname === CUSTOMER_AUTH_CALLBACK_PATH || url.pathname === CUSTOMER_AUTH_CALLBACK_PATH_EN;
}

export function getCustomerSupabase(): SupabaseClient<Database> {
  if (!customerSupabase) {
    const storage = resolveStorageOrMemory('localStorage');
    const memory = createMemoryStorage();
    const guardedStorage = {
      getItem(key: string) {
        const cached = memory.getItem(key);
        if (cached !== null) return cached;
        try { return storage.getItem(key); } catch { return null; }
      },
      setItem(key: string, value: string) {
        try { storage.setItem(key, value); memory.removeItem(key); }
        catch { memory.setItem(key, value); }
      },
      removeItem(key: string) {
        memory.removeItem(key);
        try { storage.removeItem(key); } catch { /* Best effort. */ }
      },
    };
    customerSessionStorage = guardedStorage;
    customerSupabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        // ⛔ NEVER `localStorage` here. Reading the global throws `SecurityError`
        // in a webview with site data denied, and this constructor runs inside the
        // header's session-presence effect — so the throw took every page down
        // through `RouteErrorBoundary`, not just the account surface.
        storage: guardedStorage,
        storageKey: CUSTOMER_AUTH_STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: shouldDetectCustomerSessionInUrl,
      },
    });
  }

  return customerSupabase;
}

/** SDK-owned descriptors: shared pages do not know provider names. */
export function customerSocialProviders(enabled: readonly string[]) {
  return enabled.includes('google') ? [{ kind: 'google' as const, displayName: 'Google' }] : [];
}
