// Platform-runtime bundle composition.
//
// Resolves the active bundle from the environment and returns its descriptor and port table. Each
// port slot is filled by one binder, keyed by the bundle's declared capability for that slot. A
// slot without a binder, or whose binder declines the capability, stays null: callers treat an
// unbound port as "use the deployment's direct path", never as a silent substitute.
//
// The package supplies a default binder for the blob slot. The HTTP, scheduler, data, migrations,
// analytics and transactional slots carry deployment values (route tables, jobs, the database
// client factory, migration catalogue, analytics provider, delivery runtime), so the deployment
// supplies them; `createDataBindings` builds the data binder.

import type {
  AnalyticsPort,
  BlobStoragePort,
  DataGatewayPort,
  HttpRuntimePort,
  MigrationRunnerPort,
  SchedulerPort,
  TransactionalRuntimePort,
} from "@openlup/core/platform-runtime";

import { bindBlobPort, type SupabaseStorageClient } from "../blob/index.js";
import { createServiceClient, readSupabaseDataGatewayEnv } from "../data/index.js";
import {
  getBundleDescriptor,
  resolveBlobCapability,
  resolveBundleId,
  type PlatformBundleDescriptor,
  type PlatformBundleId,
} from "../kernel/index.js";

// Structural, so the composer declares no edge to the payments module; createPaymentServices satisfies it.
interface PaymentServices {
  run<T>(work: (port: unknown) => Promise<T>): Promise<T>;
}

type Env = Record<string, string | undefined>;

export interface PlatformBundlePorts {
  payments?: PaymentServices | null;
  http: HttpRuntimePort | null;
  scheduler: SchedulerPort | null;
  blob: BlobStoragePort | null;
  data: DataGatewayPort | null;
  migrations: MigrationRunnerPort | null;
  analytics: AnalyticsPort | null;
  transactional: TransactionalRuntimePort | null;
}

export interface PlatformBundle {
  id: PlatformBundleId;
  descriptor: PlatformBundleDescriptor;
  ports: PlatformBundlePorts;
}

/**
 * One binder per port slot. Each receives the slot's capability and the environment; the blob
 * binder receives the selected blob capability (`PLATFORM_BLOB`, else the bundle's own), and the
 * transactional binder also receives the bundle's data capability.
 */
export interface PlatformBundleBinders {
  /** Explicit host selection only; no default payment executor. */
  payments?: (env: Env) => PaymentServices | null;
  /**
   * The supabase-js `createClient` used by the default Supabase Storage blob binder. Declared
   * structurally here so the composition entry's declarations reference no data-module type.
   */
  createSupabaseClient?: (
    url: string,
    key: string,
    options?: { auth?: { persistSession?: boolean; autoRefreshToken?: boolean } },
  ) => unknown;
  http?: (capability: string, env: Env) => HttpRuntimePort | null;
  scheduler?: (capability: string, env: Env) => SchedulerPort | null;
  /** Defaults to `bindBlobPort`. */
  blob?: (capability: string, env: Env) => BlobStoragePort | null;
  /** For example `createDataBindings(...).bindDataPort`. */
  data?: (capability: string, env: Env) => DataGatewayPort | null;
  migrations?: (capability: string, env: Env) => MigrationRunnerPort | null;
  analytics?: (capability: string, env: Env) => AnalyticsPort | null;
  transactional?: (capability: string, dataCapability: string, env: Env) => TransactionalRuntimePort | null;
}

export type ComposeBundle = (env: Env) => PlatformBundle;

/** Build the deployment's composition root from its port binders. */
export function createBundleComposer(binders: PlatformBundleBinders = {}): ComposeBundle {
  const bindBlob = binders.blob ?? ((capability: string, env: Env) => {
    const settings = capability === "supabase" ? readSupabaseDataGatewayEnv({
      ...env,
      SUPABASE_URL: env.SUPABASE_URL?.trim() || env.VITE_SUPABASE_URL?.trim(),
    }) : null;
    const createSupabaseClient = binders.createSupabaseClient;
    return bindBlobPort(capability, env, {
      supabaseStorageClient: settings && createSupabaseClient
        ? () => createServiceClient(settings, createSupabaseClient) as SupabaseStorageClient
        : undefined,
    });
  });
  return function composeBundle(env: Env): PlatformBundle {
    const id = resolveBundleId(env);
    const descriptor = getBundleDescriptor(id);
    const { capabilities } = descriptor;
    const ports: PlatformBundlePorts = {
      http: binders.http?.(capabilities.http, env) ?? null,
      scheduler: null,
      blob: bindBlob(resolveBlobCapability(descriptor, env), env),
      data: binders.data?.(capabilities.data, env) ?? null,
      migrations: binders.migrations?.(capabilities.migrations, env) ?? null,
      analytics: binders.analytics?.(capabilities.analytics, env) ?? null,
      transactional: binders.transactional?.(capabilities.transactional, capabilities.data, env) ?? null,
    };
    if (binders.payments) ports.payments = binders.payments(env);
    ports.scheduler = binders.scheduler?.(capabilities.scheduler, env) ?? null;
    return { id, descriptor, ports };
  };
}
