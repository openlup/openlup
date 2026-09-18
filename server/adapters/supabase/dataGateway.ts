// Supabase adapter for the platform-runtime DataGatewayPort (Platform Portability, W6).
//
// Centralizes the two persistence access modes the BFF handlers build inline today:
//   - asService(work): elevated, RLS-bypassing — a service-role client (the default bundle's path).
//   - asActor(claims, work): RLS-bound — an anon client carrying the actor's Bearer access token, so
//     RLS evaluates the request as that principal (UUID-keep: claims.sub IS the supabase auth uuid).
// The work callback receives the concrete supabase client (typed `unknown` per the port contract;
// consumers cast to their narrow read/write surface). Behavior is byte-identical to the inline
// `createClient(...)` sites this replaces — same option shape, same Authorization header — so the
// default vercel-supabase bundle stays unchanged (golden-master byte-identical).
//
// POOLING SEMANTICS (documented, no behavior change):
//   - Serverless (vercel-supabase): each invocation is short-lived; supabase-js talks to PostgREST
//     over HTTP (PgBouncer in transaction-mode behind the scenes), so there is no long-lived pool to
//     manage — a fresh client per asActor/asService call matches the current per-request creation and
//     is correct for transaction-pooled connections (no session-level state assumed).
//   - Long-running Node (node-supabase): the same supabase-js HTTP path applies; a direct-PG gateway
//     (W10, node-postgres) would instead hold a standard `pg.Pool` and run asActor work inside a
//     `BEGIN; SET LOCAL request.jwt.claims = ...; ... COMMIT` tx-per-request for RLS. That is the
//     MigrationRunner/postgres band's concern; this supabase adapter stays HTTP-pooled either way.
//
// asActor honors the access token supplied via `options.resolveAccessToken(claims)` (defaults to the
// claims' own bearer if present) so RLS is enforced; when no token resolves it falls back to an anon
// client (RLS still applies, just unauthenticated) rather than silently elevating — fail-safe.

import type { DataGatewayPort } from "../../../src/domains/platform-runtime/ports.js";
import {
  createActorClient,
  createServiceClient,
  type SupabaseCreateClient,
  type SupabaseDataGatewayEnv,
} from "./dataGatewayClientFactory.js";

type ActorClaims = { sub?: string; role?: string } | null;

export interface SupabaseDataGatewayOptions {
  /** Injection seam for the supabase-js client factory (tests pass a stub; default = real). */
  createClientImpl?: SupabaseCreateClient;
  /**
   * Resolve an actor's Bearer access token from their claims. The port contract carries only
   * `{ sub, role }`, but RLS needs the raw JWT; call sites that have the request token bind it here.
   * Returns null → anon (RLS-bound but unauthenticated) client.
   */
  resolveAccessToken?: (claims: ActorClaims) => string | null;
}

/**
 * Build a supabase-backed DataGatewayPort from resolved env. Pure: no client is created until a
 * port method runs work (matches the per-request creation the inline sites do today).
 */
export function createSupabaseDataGateway(
  env: SupabaseDataGatewayEnv,
  options: SupabaseDataGatewayOptions = {},
): DataGatewayPort {
  const resolveAccessToken = options.resolveAccessToken ?? defaultResolveAccessToken;

  return {
    async asService<T>(work: (gateway: unknown) => Promise<T>): Promise<T> {
      const client = createServiceClient(env, options.createClientImpl);
      return work(client);
    },

    async asActor<T>(claims: ActorClaims, work: (gateway: unknown) => Promise<T>): Promise<T> {
      const accessToken = resolveAccessToken(claims);
      const client = createActorClient(env, accessToken, options.createClientImpl);
      return work(client);
    },
  };
}

// Default token resolver: the port's claims shape doesn't carry a raw JWT, so without an injected
// resolver an actor request maps to an anon (unauthenticated, still RLS-bound) client. Call sites
// that hold the request bearer inject `resolveAccessToken` to make RLS see the real principal.
function defaultResolveAccessToken(_claims: ActorClaims): string | null {
  return null;
}
