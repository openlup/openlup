import { createPostgresPaymentTruthPort } from "../../adapters/postgres/paymentTruth.js";
import type { PgQueryExecutor } from "../../adapters/postgres/queryBuilder.js";
import type { PaymentTruthPort } from "../../domains/payment/paymentTruth.js";
import { resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";

type Env = Record<string, string | undefined>;

interface PoolLike extends PgQueryExecutor {
  end(): Promise<void>;
}

const DIRECT_PAYMENT_TRUTH_OPTIONS = {
  dunningTemplateSlug: "payment_failed",
  recoveryUrlPath: "/recover-payment",
  recoveryTemplateSlug: "payment_recovered",
} as const;

export interface PaymentTruthBindingDeps {
  createPool?: (options: { connectionString: string }) => PoolLike | Promise<PoolLike>;
}

export interface PaymentTruthBinding {
  run<T>(work: (port: PaymentTruthPort) => Promise<T>): Promise<T>;
}

/**
 * Production entrypoint for the direct bundle. Managed payment webhooks keep
 * their named Supabase composition; only `node-postgres` enters this public
 * truth rail, so no unused managed connection or provider DTO crosses it.
 */
export function resolvePaymentTruthBinding(
  env: Env = process.env,
  deps: PaymentTruthBindingDeps = {},
): PaymentTruthBinding | null {
  if (resolveBundleId(env) !== "node-postgres") return null;
  const connectionString = env.DATABASE_URL?.trim() ?? "";
  if (!connectionString) return null;
  return {
    async run(work) {
      const pool = await (deps.createPool ?? defaultPool)({ connectionString });
      try {
        return await work(createPostgresPaymentTruthPort(pool, DIRECT_PAYMENT_TRUTH_OPTIONS));
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
