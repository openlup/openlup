import {
  createPostgresSubscriberRetentionPort,
  type SubscriberRetentionRoutineClient,
} from "../../adapters/postgres/subscriberRetention.js";
import {
  createSubscriberRetentionMessaging,
  type SubscriberRetentionMessaging,
} from "../../domains/subscription/subscriberRetentionMessaging.js";
import { resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";
import {
  resolveTransactionalDeliveryBinding,
  type TransactionalDeliveryBinding,
  type TransactionalDeliveryBindingOptions,
} from "../communications/transactionalBinding.js";

type Env = Record<string, string | undefined>;

interface PoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export interface SubscriberRetentionMessagingBinding {
  readonly identity: "node-postgres";
  run<T>(work: (messaging: SubscriberRetentionMessaging) => Promise<T>): Promise<T>;
}

export interface SubscriberRetentionMessagingBindingOptions {
  createPool?: (options: { connectionString: string }) => Promise<PoolLike> | PoolLike;
  deliveryBinding?: TransactionalDeliveryBinding;
  deliveryOptions?: TransactionalDeliveryBindingOptions;
}

export type SubscriberRetentionMessagingBindingResolution =
  | { binding: SubscriberRetentionMessagingBinding; error?: undefined }
  | { binding?: undefined; error: string };

/** Production composition for the direct bundle; managed runtimes keep their shipped owners. */
export function resolveSubscriberRetentionMessagingBinding(
  env: Env = process.env,
  options: SubscriberRetentionMessagingBindingOptions = {},
): SubscriberRetentionMessagingBindingResolution {
  if (resolveBundleId(env) !== "node-postgres") {
    return { error: "subscriber_retention_bundle_unbound" };
  }
  const connectionString = env.DATABASE_URL?.trim() ?? "";
  if (!connectionString) return { error: "database_url_required" };
  const deliveryResolution = options.deliveryBinding
    ? { binding: options.deliveryBinding }
    : resolveTransactionalDeliveryBinding(env, options.deliveryOptions);
  if (!deliveryResolution.binding) return { error: deliveryResolution.error };
  const deliveryBinding = deliveryResolution.binding;

  return {
    binding: {
      identity: "node-postgres",
      async run(work) {
        const pool = await (options.createPool ?? defaultPool)({ connectionString });
        const retention = createPostgresSubscriberRetentionPort(routineClient(pool));
        try {
          return await deliveryBinding.run((delivery) => work(
            createSubscriberRetentionMessaging({ retention, delivery }),
          ));
        } finally {
          await pool.end();
        }
      },
    },
  };
}

function routineClient(pool: PoolLike): SubscriberRetentionRoutineClient {
  return {
    async rpc(name, args) {
      try {
        const { rows } = await pool.query(routineSql(name, args), Object.values(args));
        return { data: unwrap(rows, name), error: null };
      } catch (error) {
        const value = error as { code?: string; message?: string };
        return { data: null, error: { code: value.code, message: value.message } };
      }
    },
  };
}

async function defaultPool({ connectionString }: { connectionString: string }): Promise<PoolLike> {
  const pg = await import("pg");
  return new pg.default.Pool({ connectionString }) as unknown as PoolLike;
}

function routineSql(name: string, args: Record<string, unknown>): string {
  if (name !== "subscription_auto_resume_due"
    && !/^subscriber_(?:profile|retention)_[a-z0-9_]+$/.test(name)) {
    throw new Error("subscriber retention routine invalid");
  }
  const keys = Object.keys(args);
  if (keys.some((key) => !/^p_[a-z0-9_]+$/.test(key))) {
    throw new Error("subscriber retention argument invalid");
  }
  const named = keys.map((key, index) => `"${key}" => $${index + 1}`).join(",");
  return `SELECT public."${name}"(${named}) AS result`;
}

function unwrap(rows: Record<string, unknown>[], name: string): unknown {
  if (rows.length !== 1 || !("result" in rows[0]!)) throw new Error(`${name} response invalid`);
  return rows[0]!.result;
}
