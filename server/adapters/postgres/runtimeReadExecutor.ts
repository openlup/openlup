import type { PgQueryExecutor } from "./queryBuilder.js";

/** The one shared, role-free direct-Postgres read pool for runtime consumers. */
let pooledExecutor: { key: string; executor: PgQueryExecutor; close: () => Promise<void> } | null = null;

/** Graceful local-worker/proof shutdown for the one shared role-free pool. */
export async function closeRuntimeDatabaseReadExecutor(): Promise<void> {
  const current = pooledExecutor;
  pooledExecutor = null;
  await current?.close();
}

export function resolveRuntimeDatabaseReadExecutor(
  env: Record<string, string | undefined>,
): PgQueryExecutor | null {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) return null;
  if (pooledExecutor?.key === connectionString) return pooledExecutor.executor;
  const pool = (async () => {
    const pg = await import("pg");
    const PoolCtor = (pg.default?.Pool ?? pg.Pool) as typeof import("pg").Pool;
    return new PoolCtor({ connectionString });
  })();
  const executor: PgQueryExecutor = {
    async query(text, values) {
      return (await pool).query(text, values);
    },
  };
  pooledExecutor = { key: connectionString, executor, close: async () => (await pool).end() };
  return executor;
}
