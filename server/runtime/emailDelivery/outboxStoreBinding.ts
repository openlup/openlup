import {
  createPostgresOutboxStore,
  type PostgresOutboxStore,
} from "../../adapters/postgres/outboxStore.js";
import { createPostgresPlatformJobTransactionLane } from "../../adapters/postgres/dataGateway.js";
import { createPostgresPlatformJobRunLedger } from "../../adapters/postgres/platformJobRunLedger.js";
import type { PgQueryExecutor } from "../../adapters/postgres/queryBuilder.js";
import {
  createManagedOutboxQueueDiagnostics,
  createManagedOutboxStore,
} from "../../adapters/supabase/outboxStore.js";
import { createSupabaseDataGateway as createManagedDataGateway } from "../../adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv as readManagedDataGatewayEnv,
  type SupabaseDataGatewayEnv as ManagedDataGatewayEnv,
} from "../../adapters/supabase/dataGatewayClientFactory.js";
import type {
  OutboxQueueDiagnostics,
  OutboxStore,
} from "../../domains/commerce/outboxDispatchContracts.js";
import {
  getBundleDescriptor,
  resolveBundleId,
} from "../../domains/platform-runtime/platformKernel.js";
import type { PlatformJobRunLedgerPort } from "../../domains/platform/platformJobRunLedger.js";

export type Env = Record<string, string | undefined>;

type ManagedServiceGateway = {
  asService<T>(work: (gateway: unknown) => Promise<T>): Promise<T>;
};

export type GatewayFactory = (env: ManagedDataGatewayEnv) => ManagedServiceGateway;
type PostgresStoreFactory = (connectionString: string) => PostgresOutboxStore;

export interface OutboxStoreBindingContext {
  readonly store: OutboxStore;
  readonly diagnostics?: OutboxQueueDiagnostics;
  /** Present only on the managed bundle for managed-only handler composition. */
  readonly managedClient?: unknown;
  /** Present only on the direct bundle; its public rail is role-free. */
  readonly jobRunLedger?: PlatformJobRunLedgerPort;
}

export interface OutboxStoreBinding {
  run<T>(work: (context: OutboxStoreBindingContext) => Promise<T>): Promise<T>;
}

export type OutboxStoreBindingResolution =
  | { readonly binding: OutboxStoreBinding; readonly error?: undefined }
  | { readonly binding?: undefined; readonly error: string };

/** Resolve the named outbox capability without exposing a generic data client. */
export function resolveOutboxStoreBinding(
  env: Env,
  options: {
    previewRunId?: string;
    gatewayFactory?: GatewayFactory;
    postgresStoreFactory?: PostgresStoreFactory;
  } = {},
): OutboxStoreBindingResolution {
  const dataKind = getBundleDescriptor(resolveBundleId(env)).capabilities.data;
  if (dataKind === "postgres") {
    const connectionString = env.DATABASE_URL?.trim() ?? "";
    if (!connectionString) return { error: "database_url_required" };
    const factory = options.postgresStoreFactory ?? ((url) => createPostgresOutboxStore({ connectionString: url }));
    return {
      binding: {
        async run(work) {
          const store = factory(connectionString);
          const jobLane = createPostgresPlatformJobTransactionLane({ connectionString });
          const executor: PgQueryExecutor = {
            query: (text, values) => jobLane.run((client) => (client as PgQueryExecutor).query(text, values)),
          };
          try {
            // The adapter owns per-operation transactions; this scopes only the pool lifetime.
            return await work({
              store,
              jobRunLedger: createPostgresPlatformJobRunLedger(executor, env),
            });
          } finally {
            await Promise.all([store.close(), jobLane.close()]);
          }
        },
      },
    };
  }

  const gatewayEnv = readManagedDataGatewayEnv(env);
  if (!gatewayEnv) return { error: "supabase_env_required" };
  return {
    binding: {
      run: (work) => (options.gatewayFactory ?? createManagedDataGateway)(gatewayEnv)
        .asService((client) => work({
          store: createManagedOutboxStore(client as never, { previewRunId: options.previewRunId }),
          diagnostics: createManagedOutboxQueueDiagnostics(client as never),
          managedClient: client,
        })),
    },
  };
}
