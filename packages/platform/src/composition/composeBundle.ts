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

import { bindBlobPort } from "../blob/index.js";
import {
  getBundleDescriptor,
  resolveBundleId,
  type PlatformBundleDescriptor,
  type PlatformBundleId,
} from "../kernel/index.js";

type Env = Record<string, string | undefined>;

export interface PlatformBundlePorts {
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
 * One binder per port slot. Each receives the slot's declared capability and the environment;
 * the transactional binder also receives the bundle's data capability.
 */
export interface PlatformBundleBinders {
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
  const bindBlob = binders.blob ?? ((capability: string, env: Env) => bindBlobPort(capability, env));
  return function composeBundle(env: Env): PlatformBundle {
    const id = resolveBundleId(env);
    const descriptor = getBundleDescriptor(id);
    const { capabilities } = descriptor;
    const ports: PlatformBundlePorts = {
      http: binders.http?.(capabilities.http, env) ?? null,
      scheduler: null,
      blob: bindBlob(capabilities.blob, env),
      data: binders.data?.(capabilities.data, env) ?? null,
      migrations: binders.migrations?.(capabilities.migrations, env) ?? null,
      analytics: binders.analytics?.(capabilities.analytics, env) ?? null,
      transactional: binders.transactional?.(capabilities.transactional, capabilities.data, env) ?? null,
    };
    ports.scheduler = binders.scheduler?.(capabilities.scheduler, env) ?? null;
    return { id, descriptor, ports };
  };
}
