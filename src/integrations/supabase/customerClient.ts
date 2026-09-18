import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { resolveSupabasePublishableKey } from './keyResolution';
import { resolveStorageOrMemory } from '@/lib/browserStorage';

// HIDDEN customer (passwordless) auth client — Faza A W12.1.
//
// This is a SEPARATE Supabase client instance from the admin singleton in
// `./client.ts`. It MUST NOT share the admin session: it uses a DISTINCT
// `storageKey` ('openlup-customer') so the customer's magic-link session is
// persisted under its own localStorage namespace and can never collide with,
// overwrite, or read the live admin session (`sb-<ref>-auth-token`). The two
// clients run side by side; signing a customer in/out never touches admin auth.
//
// detectSessionInUrl is restricted to the customer callback route. The client is
// a lazy singleton so importing App.tsx never auto-initializes a second Supabase
// auth client on public/live pages.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = resolveSupabasePublishableKey({
  VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
});

export const CUSTOMER_AUTH_STORAGE_KEY = 'openlup-customer';
export const CUSTOMER_AUTH_CALLBACK_PATH = '/konto/auth/callback';
export const CUSTOMER_AUTH_CALLBACK_PATH_EN = '/account/auth/callback';

let customerSupabase: SupabaseClient<Database> | null = null;

export function shouldDetectCustomerSessionInUrl(url: URL): boolean {
  return url.pathname === CUSTOMER_AUTH_CALLBACK_PATH || url.pathname === CUSTOMER_AUTH_CALLBACK_PATH_EN;
}

export function getCustomerSupabase(): SupabaseClient<Database> {
  if (!customerSupabase) {
    customerSupabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        // ⛔ NEVER `localStorage` here. Reading the global throws `SecurityError`
        // in a webview with site data denied, and this constructor runs inside the
        // header's session-presence effect — so the throw took every page down
        // through `RouteErrorBoundary`, not just the account surface.
        storage: resolveStorageOrMemory('localStorage'),
        storageKey: CUSTOMER_AUTH_STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: shouldDetectCustomerSessionInUrl,
      },
    });
  }

  return customerSupabase;
}
