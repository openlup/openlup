// DataGatewayPort bindings for bundle composition.
//
// Maps a bundle's declared `data` capability to a concrete DataGatewayPort. The supabase gateway is
// constructed eagerly (pure factory; no client/network until a port method runs work), so the
// default vercel-supabase path binds the slot with no secrets needed: env is read with
// empty-string fallbacks and validated lazily inside asActor/asService. The application supplies
// the supabase-js `createClient` once, when it creates its bindings.
//
// The `postgres` capability (node-postgres) uses the existing direct-PG DataGatewayPort. Its
// PgGatewayClient exposes the same narrow RPC surface used by Supabase-backed domain ports.

import {
  getBundleDescriptor,
  resolveBundleId,
} from "../kernel/index.js";
import { createSupabaseDataGateway } from "./supabaseGateway.js";
import {
  createPostgresDataGateway,
  resolvePostgresDataGatewayEnv,
  type PostgresDataGatewayEnv,
} from "./postgresGateway.js";
import type { DataGatewayPort } from "@openlup/core/platform-runtime";
import type { SupabaseCreateClient } from "./supabaseClientFactory.js";

type Env = Record<string, string | undefined>;
type ActorClaims = { sub?: string; role?: string } | null;
/** Actor-only data access for one request. */
export type ActorOnlyDataPort = {
  asActor: <T>(
    claims: ActorClaims,
    work: (gateway: unknown) => Promise<T>,
  ) => Promise<T>;
};
export interface DataPortBindingOptions {
  /** Replaces the bindings' supabase-js `createClient` for this call (tests). */
  createClientImpl?: SupabaseCreateClient;
  resolveAccessToken?: (claims: ActorClaims) => string | null;
}

interface CachedBundleDataPort {
  cacheKey: string;
  port: DataGatewayPort | null;
}

export interface DataBindingDependencies {
  /** The supabase-js `createClient` used by every supabase gateway these bindings build. */
  createSupabaseClient: SupabaseCreateClient;
  /** Builds the direct-PostgreSQL gateway; defaults to `createPostgresDataGateway`. */
  createPostgresGateway?: (env: PostgresDataGatewayEnv) => DataGatewayPort;
}

export interface DataBindings {
  /** Resolve the DataGatewayPort for a bundle's declared data capability kind. */
  bindDataPort(dataKind: string, env: Env, requestOptions?: DataPortBindingOptions): DataGatewayPort | null;
  /** Bind one request to actor-only data access. */
  bindRequestActorDataPort(
    accessToken: string,
    env: Env,
    requestOptions?: DataPortBindingOptions,
  ): ActorOnlyDataPort | null;
  /** Resolve and bind the active bundle's data gateway, cached per bundle and data configuration. */
  bindBundleDataPort(env: Env): DataGatewayPort | null;
}

/** Create one set of data bindings; the bundle data port cache belongs to this set. */
export function createDataBindings(deps: DataBindingDependencies): DataBindings {
  let cachedBundleDataPort: CachedBundleDataPort | null = null;
  const createPostgresGateway = deps.createPostgresGateway ?? ((env: PostgresDataGatewayEnv) => createPostgresDataGateway(env));

  /** Resolve the DataGatewayPort for a bundle's declared data capability kind. */
  function bindDataPort(
    dataKind: string,
    env: Env,
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
        }, { ...requestOptions, createClientImpl: requestOptions.createClientImpl ?? deps.createSupabaseClient });
      case "postgres":
        // Direct-PG gateway (pg.Pool, tx-per-request RLS via SET LOCAL). Pure factory — no pool
        // until asActor/asService runs work, so the slot binds even before DATABASE_URL is present
        // (matches the supabase case's lazy null-is-no-op convention; keeps composeBundle non-null).
        return createPostgresGateway(resolvePostgresDataGatewayEnv(env));
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
  function bindRequestActorDataPort(
    accessToken: string,
    env: Env,
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
  function bindBundleDataPort(env: Env): DataGatewayPort | null {
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

  return { bindDataPort, bindRequestActorDataPort, bindBundleDataPort };
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
