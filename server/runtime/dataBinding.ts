// DataGatewayPort binding for composeBundle (Platform Portability, W6).
//
// Maps a bundle's declared `data` capability to a concrete DataGatewayPort. Kept out of
// composeBundle so that file stays a thin one-line-per-slot registry (its #1 conflict-magnet
// status). The supabase gateway is constructed eagerly (pure factory; no client/network until a
// port method runs work), so the default vercel-supabase path binds the slot with no secrets needed
// — env is read with empty-string fallbacks and validated lazily inside asActor/asService, matching
// the lazy null-is-no-op convention W1 established and keeping the default byte-identical.
//
// The `postgres` capability (node-postgres) uses the existing direct-PG DataGatewayPort. Its
// PgGatewayClient exposes the same narrow RPC surface used by Supabase-backed domain ports.

import {
  getBundleDescriptor,
  resolveBundleId,
} from "../domains/platform-runtime/platformKernel.js";
import { createSupabaseDataGateway } from "../adapters/supabase/dataGateway.js";
import {
  createPostgresDataGateway,
  resolvePostgresDataGatewayEnv,
} from "../adapters/postgres/dataGateway.js"; // W10
import type { DataGatewayPort } from "../../src/domains/platform-runtime/ports.js";

type Env = Record<string, string | undefined>;
type ActorClaims = { sub?: string; role?: string } | null;
type ActorOnlyDataPort = {
  asActor: <T>(
    claims: ActorClaims,
    work: (gateway: unknown) => Promise<T>,
  ) => Promise<T>;
};
interface DataPortBindingOptions {
  createClientImpl?: unknown;
  resolveAccessToken?: (claims: ActorClaims) => string | null;
}

interface CachedBundleDataPort {
  cacheKey: string;
  port: DataGatewayPort | null;
}

let cachedBundleDataPort: CachedBundleDataPort | null = null;

/** Resolve the DataGatewayPort for a bundle's declared data capability kind. */
export function bindDataPort(
  dataKind: string,
  env: Env = process.env,
  requestOptions: DataPortBindingOptions = {},
): DataGatewayPort | null {
  switch (dataKind) {
    case "supabase":
      // Construct from env with empty-string fallbacks; the actual supabase client is created
      // lazily when asActor/asService runs work, so the slot binds even before secrets are present
      // (same as the blob/transactional/analytics slots — keeps composeBundle({}) non-null).
      return createSupabaseDataGateway({
        url: env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? "",
        anonKey:
    env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    env.VITE_SUPABASE_ANON_KEY ??
          env.SUPABASE_ANON_KEY ??
          "",
        serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      }, requestOptions as never);
    case "postgres":
      // W10: direct-PG gateway (pg.Pool, tx-per-request RLS via SET LOCAL). Pure factory — no pool
      // until asActor/asService runs work, so the slot binds even before DATABASE_URL is present
      // (matches the supabase case's lazy null-is-no-op convention; keeps composeBundle non-null).
      return createPostgresDataGateway(resolvePostgresDataGatewayEnv(env));
    default:
      return null;
  }
}

/**
 * Bind one request to actor-only data access.
 *
 * HTTP-backed bundles receive a fresh gateway so the raw bearer resolver cannot
 * cross request boundaries. The direct database bundle reuses the existing
 * cached port (and therefore its lazy pool); only this actor-only facade is new.
 */
export function bindRequestActorDataPort(
  accessToken: string,
  env: Env = process.env,
  requestOptions: DataPortBindingOptions = {},
): ActorOnlyDataPort | null {
  const bundleId = resolveBundleId(env);
  const dataKind = getBundleDescriptor(bundleId).capabilities.data;
  const port = dataKind === "postgres"
    ? bindBundleDataPort(env)
    : bindDataPort(dataKind, env, {
        ...requestOptions,
        resolveAccessToken: () => accessToken,
      });
  if (!port) return null;
  return {
    asActor: (claims, work) => port.asActor(claims, work),
  };
}

/** Resolve and bind the active bundle's data gateway without composing the whole runtime. */
export function bindBundleDataPort(env: Env = process.env): DataGatewayPort | null {
  const bundleId = resolveBundleId(env);
  const descriptor = getBundleDescriptor(bundleId);
  const cacheKey = bundleDataPortCacheKey(bundleId, descriptor.capabilities.data, env);
  if (cachedBundleDataPort?.cacheKey === cacheKey) {
    return cachedBundleDataPort.port;
  }

  const port = bindDataPort(descriptor.capabilities.data, env);
  cachedBundleDataPort = { cacheKey, port };
  return port;
}

function bundleDataPortCacheKey(bundleId: string, dataKind: string, env: Env): string {
  const dataConfig = dataKind === "postgres"
    ? [env.DATABASE_URL ?? ""]
    : dataKind === "supabase"
      ? [
          env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? "",
    env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    env.VITE_SUPABASE_ANON_KEY ??
            env.SUPABASE_ANON_KEY ??
            "",
          env.SUPABASE_SERVICE_ROLE_KEY ?? "",
        ]
      : [];
  return JSON.stringify([bundleId, dataKind, ...dataConfig]);
}
