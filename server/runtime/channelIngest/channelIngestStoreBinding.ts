import {
  createPostgresChannelIngestStore,
  type PostgresChannelIngestStore,
} from "../../adapters/postgres/channelIngestStore.js";
import { createPostgresChannelIngestRails } from "../../adapters/postgres/channelIngestRails.js";
import { createPostgresChannelIngestTransactionLane } from "../../adapters/postgres/dataGateway.js";
import {
  createManagedChannelIngestChannelRead,
  createManagedChannelIngestStore,
  type ManagedChannelIngestClient,
} from "../../adapters/supabase/channelIngestStore.js";
import {
  createManagedChannelIngestRails,
  type ManagedChannelRailsClient,
} from "../../adapters/supabase/channelIngestRails.js";
import type { ChannelIngestRails } from "./channelIngestComposition.js";
import { createSupabaseDataGateway as createManagedDataGateway } from "../../adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv as readManagedDataGatewayEnv,
  type SupabaseDataGatewayEnv as ManagedDataGatewayEnv,
} from "../../adapters/supabase/dataGatewayClientFactory.js";
import type {
  ChannelIngestChannelReadPort,
  ChannelIngestStorePort,
} from "../../../src/domains/channels/channelIngestStorePort.js";
import {
  getBundleDescriptor,
  resolveBundleId,
} from "../../domains/platform-runtime/platformKernel.js";

// Resolve the named channel-ingest capability for one run, without handing anybody a generic data
// client. Same shape as the outbox store binding, and for the same reason: a capability that can
// write orders and clients should be reachable only through the port that names those writes, not
// through a gateway that happens to be in scope.
//
// There is deliberately NO `composeBundle` slot. The saga has no route and no schedule in this
// wave, so nothing in the request or job path needs it wired; adding a slot now would advertise a
// capability that no entrypoint can reach.

export type Env = Record<string, string | undefined>;

type ManagedServiceGateway = {
  asService<T>(work: (gateway: unknown) => Promise<T>): Promise<T>;
};

export type GatewayFactory = (env: ManagedDataGatewayEnv) => ManagedServiceGateway;
type PostgresStoreFactory = (connectionString: string) => PostgresChannelIngestStore;

export interface ChannelIngestBindingContext {
  readonly store: ChannelIngestStorePort;
  /**
   * Absent on the direct-Postgres lane. The platform catalogue registers channels but authors no
   * connection embed for this read, and the saga's admission step needs the connector kind that
   * embed carries — so a caller on that lane must supply its own channel read rather than be
   * handed one that would answer with half a row.
   */
  readonly channels?: ChannelIngestChannelReadPort;
  /**
   * The three rails the saga borrows. Always present now — B5 left this slot named but unbound and
   * every ORDER answered `channel_ingest_rails_unbound`. On the direct-Postgres lane the rails
   * object is still honest about the two capabilities that catalogue does not author: it binds the
   * order-item read and refuses reservations and payment control BY NAME, exactly as the store on
   * that lane already refuses the buyer and order writers.
   */
  readonly rails: ChannelIngestRails;
}

export interface ChannelIngestStoreBinding {
  run<T>(work: (context: ChannelIngestBindingContext) => Promise<T>): Promise<T>;
}

export type ChannelIngestStoreBindingResolution =
  | { readonly binding: ChannelIngestStoreBinding; readonly error?: undefined }
  | { readonly binding?: undefined; readonly error: string };

export function resolveChannelIngestStoreBinding(
  env: Env,
  options: {
    gatewayFactory?: GatewayFactory;
    postgresStoreFactory?: PostgresStoreFactory;
  } = {},
): ChannelIngestStoreBindingResolution {
  const dataKind = getBundleDescriptor(resolveBundleId(env)).capabilities.data;

  if (dataKind === "postgres") {
    const connectionString = env.DATABASE_URL?.trim() ?? "";
    if (!connectionString) return { error: "database_url_required" };
    const factory =
      options.postgresStoreFactory ??
      ((url) => createPostgresChannelIngestStore({ connectionString: url }));
    return {
      binding: {
        async run(work) {
          const store = factory(connectionString);
          const lane = createPostgresChannelIngestTransactionLane({ connectionString });
          const rails = createPostgresChannelIngestRails((railWork) =>
            lane.run((gateway) => railWork(gateway as ManagedChannelRailsClient)),
          );
          try {
            // The adapter owns per-operation transactions; this scopes only the pool lifetime.
            return await work({ store, rails });
          } finally {
            await Promise.all([store.close(), lane.close()]);
          }
        },
      },
    };
  }

  const gatewayEnv = readManagedDataGatewayEnv(env);
  if (!gatewayEnv) return { error: "supabase_env_required" };
  return {
    binding: {
      run: (work) =>
        (options.gatewayFactory ?? createManagedDataGateway)(gatewayEnv).asService((client) =>
          work({
            store: createManagedChannelIngestStore(client as ManagedChannelIngestClient),
            channels: createManagedChannelIngestChannelRead(client as ManagedChannelIngestClient),
            rails: createManagedChannelIngestRails(client as ManagedChannelRailsClient),
          }),
        ),
    },
  };
}
