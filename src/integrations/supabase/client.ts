import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { resolveSupabasePublishableKey } from './keyResolution';
import { resolveStorageOrMemory } from '@/lib/browserStorage';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = resolveSupabasePublishableKey({
  VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
});

export const ADMIN_AUTH_CALLBACK_PATH = '/admin/auth/callback';

export function shouldDetectAdminSessionInUrl(url: URL): boolean {
  return url.pathname === ADMIN_AUTH_CALLBACK_PATH;
}

/** Read the auth-callback `type` (magiclink / recovery / invite) from a URL. */
export function readAuthCallbackTypeFrom(search: string, hash: string): string | null {
  const fromSearch = new URLSearchParams(search).get('type');
  if (fromSearch) return fromSearch;
  return new URLSearchParams(hash.replace(/^#/, '')).get('type');
}

// Captured at module load — BEFORE `createClient` below runs `detectSessionInUrl`,
// which consumes and STRIPS the `#access_token=…&type=magiclink` hash. The admin
// callback route is lazy-loaded and mounts only AFTER that strip, so by the time
// `AuthCallbackPage` reads the URL the `type` is already gone and the magic-link
// flow was misclassified as a password set/recovery. Snapshotting here preserves
// it for the callback. (No-op off the callback path; safe on every page load.)
export const initialAuthCallbackType =
  typeof window === 'undefined'
    ? null
    : readAuthCallbackTypeFrom(window.location.search, window.location.hash);

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // Module scope: a bare `localStorage` here throws on IMPORT in a webview
    // with site data denied, taking down every chunk that pulls this module in.
    storage: resolveStorageOrMemory('localStorage'),
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: shouldDetectAdminSessionInUrl,
  }
});
