import {
  createPostgresSubscriptionActivationAdapter,
  type PostgresSubscriptionActivationAdapter,
} from "../../adapters/postgres/subscriptionActivation.js";
import { resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";

// Production binding for the subscription-activation spine. It answers `null`
// for every bundle but `node-postgres`, so a deployment running the managed
// composition never reaches this code path and never opens a connection it does
// not use. The pool's lifetime is this binding's: it is created when a caller
// enters `run` and closed when that caller leaves, which is the same boundary
// the request-scoped adapters in this folder use.
//
// The routine call is built here rather than in the adapter because the adapter
// must stay a plain routine caller: it is the same module the managed
// composition would talk to through its own client.

type Env = Record<string, string | undefined>;

interface PoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export interface SubscriptionActivationBindingDeps {
  createPool?: (options: { connectionString: string }) => PoolLike;
}

export interface SubscriptionActivationBinding {
  run<T>(work: (adapter: PostgresSubscriptionActivationAdapter) => Promise<T>): Promise<T>;
}

export function resolveSubscriptionActivationBinding(
  env: Env = process.env,
  deps: SubscriptionActivationBindingDeps = {},
): SubscriptionActivationBinding | null {
  if (resolveBundleId(env) !== "node-postgres") return null;
  const connectionString = env.DATABASE_URL?.trim() ?? "";
  if (!connectionString) return null;

  return {
    async run(work) {
      const pool = await (deps.createPool ?? defaultPool)({ connectionString });
      try {
        return await work(createPostgresSubscriptionActivationAdapter({
          async rpc(name, args) {
            const { rows } = await pool.query(routineSql(name, args), Object.values(args ?? {}));
            return { data: unwrap(rows, name), error: null };
          },
        }));
      } finally {
        await pool.end();
      }
    },
  };
}

async function defaultPool({ connectionString }: { connectionString: string }): Promise<PoolLike> {
  const pg = await import("pg");
  return new pg.default.Pool({ connectionString }) as unknown as PoolLike;
}

/**
 * Named arguments, so a routine that gained a defaulted parameter keeps
 * answering an older caller. The name and every argument key are checked
 * against a fixed shape before they reach the statement; the values themselves
 * are always bound.
 */
function routineSql(name: string, args: Record<string, unknown> | undefined): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("subscription activation routine invalid");
  const keys = Object.keys(args ?? {});
  if (keys.some((key) => !/^p_[a-z0-9_]+$/.test(key))) {
    throw new Error("subscription activation argument invalid");
  }
  const named = keys.map((key, index) => `"${key}" => $${index + 1}`).join(",");
  return `SELECT public."${name}"(${named}) AS result`;
}

function unwrap(rows: Record<string, unknown>[], name: string): unknown {
  if (rows.length !== 1 || !("result" in rows[0]!)) throw new Error(`${name} response invalid`);
  return rows[0]!.result;
}
