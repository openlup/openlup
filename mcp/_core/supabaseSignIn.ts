import { createClient } from "@supabase/supabase-js";

import type { SignIn } from "./session.js";

/**
 * MCP agent head — generic `_core` (domain-neutral).
 *
 * The concrete `signIn` for the service-admin identity: Supabase
 * `signInWithPassword` over the project anon key. FAIL-CLOSED — it throws on any
 * auth error or missing session, and (critically) it NEVER uses the service-role
 * key, so the machine actor remains a normal authenticated user whose
 * `is_machine_actor` row the write RPC re-derives and the publish gate honours.
 */
export interface SupabaseSignInDeps {
  readonly url: string;
  readonly anonKey: string;
  readonly email: string;
  readonly password: string;
}

export function createSupabaseSignIn(deps: SupabaseSignInDeps): SignIn {
  return async () => {
    const client = createClient(deps.url, deps.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.signInWithPassword({
      email: deps.email,
      password: deps.password,
    });
    if (error || !data.session) {
      throw new Error(`service-admin sign-in failed: ${error?.message ?? "no session returned"}`);
    }
    const expiresAtMs = data.session.expires_at
      ? data.session.expires_at * 1000
      : now() + 3_600_000;
    return { accessToken: data.session.access_token, expiresAtMs };
  };
}

function now(): number {
  return Date.now();
}
