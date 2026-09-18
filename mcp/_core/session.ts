/**
 * MCP agent head — generic `_core` (domain-neutral).
 *
 * `createServiceAdminSession` turns a `signIn` thunk into a cached, single-flight
 * Bearer-token source for the BFF client. It is the ONLY identity the MCP head
 * carries: a service-admin user signed in with `signInWithPassword`. It is
 * FAIL-CLOSED by construction — a failed sign-in propagates and the session
 * yields nothing; it never falls back to a service-role key (which would bypass
 * the publish gate). The concrete `signIn` (Supabase) lives in `supabaseSignIn.ts`
 * so this module stays creds-agnostic and unit-testable.
 */

/** What a successful sign-in returns. */
export interface SignInResult {
  readonly accessToken: string;
  /** Absolute expiry in epoch ms; the session re-auths before this minus skew. */
  readonly expiresAtMs: number;
}

/** A bound sign-in thunk (creds captured in the closure — the session never sees them). */
export type SignIn = () => Promise<SignInResult>;

export interface SessionDeps {
  readonly signIn: SignIn;
  /** Injectable clock (tests); defaults to `Date.now`. */
  readonly now?: () => number;
  /** Re-auth this many ms before the token's stated expiry. Default 30s. */
  readonly skewMs?: number;
}

export interface ServiceAdminSession {
  /** Resolve a valid Bearer; `forceRefresh` discards any cached token first. */
  getBearer(opts?: { forceRefresh?: boolean }): Promise<string>;
}

export function createServiceAdminSession(deps: SessionDeps): ServiceAdminSession {
  const now = deps.now ?? (() => Date.now());
  const skewMs = deps.skewMs ?? 30_000;

  let cached: { token: string; expiresAtMs: number } | null = null;
  let pending: Promise<string> | null = null;

  function validToken(): string | null {
    if (cached && now() < cached.expiresAtMs - skewMs) return cached.token;
    return null;
  }

  async function refresh(): Promise<string> {
    try {
      // FAIL-CLOSED: a rejected sign-in propagates to the caller. There is no
      // service-role fallback — without a resolved user the head cannot write.
      const result = await deps.signIn();
      cached = { token: result.accessToken, expiresAtMs: result.expiresAtMs };
      return result.accessToken;
    } catch (error) {
      cached = null;
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      pending = null;
    }
  }

  return {
    getBearer(opts) {
      if (opts?.forceRefresh) {
        cached = null;
      } else {
        const token = validToken();
        if (token) return Promise.resolve(token);
      }
      // Single-flight: concurrent callers share one in-flight sign-in.
      if (!pending) pending = refresh();
      return pending;
    },
  };
}
