// Vanilla-Postgres DataGatewayPort plus capability-local role-free transaction
// lanes. Actor/service role changes use SET LOCAL; every call owns one pooled
// BEGIN/COMMIT|ROLLBACK/release lifecycle, so claims never leak between calls.
import type { Pool, PoolClient } from "pg";
import type { DataGatewayPort } from "../../../src/domains/platform-runtime/ports.js";
import { PgGatewayClient } from "./queryBuilder.js";

type ActorClaims = { sub?: string; role?: string } | null;

export interface PostgresDataGatewayEnv {
  /** Postgres connection string (DATABASE_URL). Empty until a node-postgres deploy supplies it. */
  connectionString: string;
}

export interface PostgresDataGatewayOptions {
  /** Injection seam: tests pass a stub pool; production lazily builds a real pg.Pool from env. */
  poolFactory?: (env: PostgresDataGatewayEnv) => Pool | Promise<Pool>;
}
/** Convert node-postgres timestamptz text to lossless RFC 3339. */
export function postgresTimestampTzToRfc3339(value: string): string {
  const parts = /^(\d{4,}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-])(\d{2})(?::?(\d{2}))?$/.exec(value);
  if (!parts) return value;
  const [, date, time, sign, offsetHours, offsetMinutes = "00"] = parts;
  return `${date}T${time}${sign}${offsetHours}:${offsetMinutes}`;
}
/** Keep PostgREST-compatible, lossless timestamp strings at the gateway edge. */
export function createPostgresGatewayTypeOverrides(
  TypeOverridesCtor: typeof import("pg").TypeOverrides,
): import("pg").TypeOverrides {
  const overrides = new TypeOverridesCtor();
  // node-postgres otherwise turns timestamptz into a millisecond Date and drops
  // PostgreSQL microseconds, making an immediate schedule round-trip look stale.
  overrides.setTypeParser(1184, "text", postgresTimestampTzToRfc3339);
  return overrides;
}

/**
 * Capability-local transaction lane for the authored Postgres outbox adapter.
 *
 * The platform manifest intentionally creates no service role. This is not an
 * alternate DataGatewayPort access mode: it is available only to the outbox
 * adapter, which calls one rail RPC per transaction. Its lifecycle deliberately
 * reuses the same pooled BEGIN/callback/COMMIT|ROLLBACK/release implementation
 * as the public gateway below, but it never changes the connection role.
 */
export interface PostgresOutboxTransactionLane {
  run<T>(work: (gateway: unknown) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// Capability names are the access rule. Identical lanes alias the shared shape;
// any lane whose contract diverges gets its own interface.
/** Role-free transaction lane for only the public platform job-control adapter. */
export type PostgresPlatformJobTransactionLane = PostgresOutboxTransactionLane;
/** Role-free transaction lane for only the direct transactional-delivery receipt adapter. */
export type PostgresTransactionalDeliveryTransactionLane = PostgresOutboxTransactionLane;
/** Role-free transaction lane for only the paid-order accounting document adapter. */
export type PostgresAccountingTransactionLane = PostgresOutboxTransactionLane;
/** Role-free transaction lane for only the direct channel-ingest ledger adapter. */
export type PostgresChannelIngestTransactionLane = PostgresOutboxTransactionLane;
/** Role-free transaction lane for only the public fulfillment shipment-spine adapter. */
export interface PostgresFulfillmentTransactionLane {
  run<T>(work: (gateway: unknown) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
/** Role-free transaction lane for only the communications control-plane adapter. */
export type PostgresCommunicationsControlPlaneTransactionLane = PostgresOutboxTransactionLane;
export type PostgresPlatformControlPlaneTransactionLane = PostgresOutboxTransactionLane;
/** Role-free transaction lane for only the direct bundle admin-write adapter. */
export type PostgresBundleAdminWriteTransactionLane = PostgresOutboxTransactionLane;
export type PostgresCustomerRecoveryTransactionLane = PostgresOutboxTransactionLane;
export type PostgresAutomaticRenewalTransactionLane = PostgresOutboxTransactionLane;
export type PostgresAdminInventoryTransactionLane = PostgresOutboxTransactionLane;
export type PostgresDunningLifecycleTransactionLane = PostgresOutboxTransactionLane;
export type PostgresPromotionClaimTransactionLane = PostgresOutboxTransactionLane;
export type PostgresCheckoutRecoveryOperationsTransactionLane = PostgresOutboxTransactionLane;
/**
 * Build a node-postgres-backed DataGatewayPort. Pure: NO pool/connection is created until a port
 * method runs work (lazy, like the supabase adapter), so the slot binds even before DATABASE_URL is
 * present (keeps composeBundle({}) non-null). The pool is created once and reused across calls.
 */
export function createPostgresDataGateway(
  env: PostgresDataGatewayEnv,
  options: PostgresDataGatewayOptions = {},
): DataGatewayPort {
  const transactions = createPooledPostgresTransactions(env, options);

  return {
    async asService<T>(work: (gateway: unknown) => Promise<T>): Promise<T> {
      return transactions.run(async (client) => {
        await client.query("SET LOCAL ROLE service_role");
      }, work);
    },

    async asActor<T>(claims: ActorClaims, work: (gateway: unknown) => Promise<T>): Promise<T> {
      return transactions.run(async (client) => {
        const jwtClaims = buildJwtClaims(claims);
        if (jwtClaims) {
          // Parameterized: the claims JSON is bound as $1, never interpolated into the SET statement.
          await client.query("SELECT set_config('request.jwt.claims', $1, true)", [jwtClaims]);
          await client.query("SET LOCAL ROLE authenticated");
        } else {
          // No usable principal → drop to the `anon` role so RLS evaluates the request as
          // unauthenticated. CRITICAL: the connection's own login role may be a superuser/owner
          // (which BYPASSes RLS), so we MUST switch roles rather than leave the default — otherwise an
          // unauthenticated actor would silently see everything. Fail-safe: anon is RLS-bound, never
          // elevated. (No request.jwt.claims is set, so auth.uid() returns NULL.)
          await client.query("SET LOCAL ROLE anon");
        }
      }, work);
    },
  };
}

/**
 * Build the role-free, per-operation outbox lane. Do not use this for generic
 * service work: DataGatewayPort.asService remains the mandatory service_role
 * boundary. Only the named owner-authority capability aliases below may reuse it.
 */
export function createPostgresOutboxTransactionLane(
  env: PostgresDataGatewayEnv,
  options: PostgresDataGatewayOptions = {},
): PostgresOutboxTransactionLane {
  const transactions = createPooledPostgresTransactions(env, options);
  return { run: (work) => transactions.run(async () => {}, work), close: transactions.close };
}

/**
 * Build the role-free platform job-control lane. The public manifest owns the
 * job-control RPCs and intentionally does not create a service role.
 */
export function createPostgresPlatformJobTransactionLane(
  env: PostgresDataGatewayEnv,
  options: PostgresDataGatewayOptions = {},
): PostgresPlatformJobTransactionLane {
  const transactions = createPooledPostgresTransactions(env, options);
  return { run: (work) => transactions.run(async () => {}, work), close: transactions.close };
}

/**
 * Build the role-free, per-operation transactional-delivery receipt lane. This
 * is capability-local; DataGatewayPort.asService remains the sole generic
 * service-role boundary and the concrete receipt adapter is the only importer.
 */
export function createPostgresTransactionalDeliveryTransactionLane(
  env: PostgresDataGatewayEnv,
  options: PostgresDataGatewayOptions = {},
): PostgresTransactionalDeliveryTransactionLane {
  const transactions = createPooledPostgresTransactions(env, options);
  return { run: (work) => transactions.run(async () => {}, work), close: transactions.close };
}

/**
 * Build the role-free paid-order accounting lane. The public accounting rail is
 * authored for the database owner and the manifest intentionally has no
 * `service_role`; generic DataGatewayPort.asService therefore remains forbidden.
 */
export function createPostgresAccountingTransactionLane(
  env: PostgresDataGatewayEnv,
  options: PostgresDataGatewayOptions = {},
): PostgresAccountingTransactionLane {
  const transactions = createPooledPostgresTransactions(env, options);
  return { run: (work) => transactions.run(async () => {}, work), close: transactions.close };
}

/**
 * Build the role-free, per-operation channel-ingest lane. Capability-local in the same way:
 * `DataGatewayPort.asService` remains the sole generic service-role boundary, and the concrete
 * channel-ingest adapter is the only importer.
 */
export function createPostgresChannelIngestTransactionLane(
  env: PostgresDataGatewayEnv,
  options: PostgresDataGatewayOptions = {},
): PostgresChannelIngestTransactionLane {
  const transactions = createPooledPostgresTransactions(env, options);
  return { run: (work) => transactions.run(async () => {}, work), close: transactions.close };
}

/**
 * Build the role-free fulfillment shipment-spine lane. The public fulfillment
 * rail is authored for the database owner, so it must not enter the generic
 * service-role gateway used by the managed bundle.
 */
export function createPostgresFulfillmentTransactionLane(
  env: PostgresDataGatewayEnv,
  options: PostgresDataGatewayOptions = {},
): PostgresFulfillmentTransactionLane {
  const transactions = createPooledPostgresTransactions(env, options);
  return { run: (work) => transactions.run(async () => {}, work), close: transactions.close };
}

export function createPostgresCommunicationsControlPlaneTransactionLane(
  env: PostgresDataGatewayEnv,
  options: PostgresDataGatewayOptions = {},
): PostgresCommunicationsControlPlaneTransactionLane {
  const transactions = createPooledPostgresTransactions(env, options);
  return { run: (work) => transactions.run(async () => {}, work), close: transactions.close };
}

export function createPostgresPlatformControlPlaneTransactionLane(
  env: PostgresDataGatewayEnv, options: PostgresDataGatewayOptions = {},
): PostgresPlatformControlPlaneTransactionLane {
  const transactions = createPooledPostgresTransactions(env, options);
  return { run: (work) => transactions.run(async () => {}, work), close: transactions.close };
}

/**
 * Build the role-free, per-operation bundle admin-write lane. Capability-local in
 * the same way: DataGatewayPort.asService remains the sole generic service-role
 * boundary, and the bundle write adapter is the only allowed importer.
 */
export function createPostgresBundleAdminWriteTransactionLane(
  env: PostgresDataGatewayEnv,
  options: PostgresDataGatewayOptions = {},
): PostgresBundleAdminWriteTransactionLane {
  const transactions = createPooledPostgresTransactions(env, options);
  return { run: (work) => transactions.run(async () => {}, work), close: transactions.close };
}

export const createPostgresCustomerRecoveryTransactionLane = createPostgresOutboxTransactionLane;
export const createPostgresAutomaticRenewalTransactionLane = createPostgresOutboxTransactionLane;
export const createPostgresAdminInventoryTransactionLane = createPostgresOutboxTransactionLane;
export const createPostgresDunningLifecycleTransactionLane = createPostgresOutboxTransactionLane;
export const createPostgresPromotionClaimTransactionLane = createPostgresOutboxTransactionLane;
export const createPostgresCheckoutRecoveryOperationsTransactionLane = createPostgresOutboxTransactionLane;
export const createPostgresCustomerDiagnosticHistoryTransactionLane = createPostgresOutboxTransactionLane;
function createPooledPostgresTransactions(
  env: PostgresDataGatewayEnv,
  options: PostgresDataGatewayOptions,
): {
  run<T>(setup: (client: PoolClient) => Promise<void>, work: (gateway: unknown) => Promise<T>): Promise<T>;
  close(): Promise<void>;
} {
  let poolPromise: Promise<Pool> | null = null;

  async function getPool(): Promise<Pool> {
    // Cache the in-flight promise (not the resolved Pool) so concurrent first calls share ONE pool
    // rather than racing to build two. Promise.resolve normalizes the factory's Pool | Promise<Pool>.
    if (!poolPromise) {
      const factory = options.poolFactory ?? defaultPoolFactory;
      poolPromise = Promise.resolve(factory(env));
    }
    return poolPromise;
  }

  async function withClient<T>(setup: (client: PoolClient) => Promise<void>, work: (gw: unknown) => Promise<T>): Promise<T> {
    const activePool = await getPool();
    const client = await activePool.connect();
    try {
      await client.query("BEGIN");
      await setup(client);
      const result = await work(new PgGatewayClient(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback failure; surface the original error
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    run: withClient,
    async close(): Promise<void> {
      if (poolPromise) await (await poolPromise).end();
    },
  };
}

/**
 * Build the request.jwt.claims JSON PostgREST would set. Returns null when there is no usable
 * principal (no sub) so the caller stays anon rather than asserting an authenticated-but-empty role.
 */
function buildJwtClaims(claims: ActorClaims): string | null {
  if (!claims || !claims.sub) return null;
  const role = claims.role && claims.role.trim() !== "" ? claims.role : "authenticated";
  return JSON.stringify({ sub: claims.sub, role });
}

// Lazy default: only import `pg` and build the Pool when actually invoked, so typecheck/test paths
// that never run work do not load the driver. SET LOCAL keeps pooled-connection reuse safe.
async function defaultPoolFactory(env: PostgresDataGatewayEnv): Promise<Pool> {
  const pg = await import("pg");
  const PoolCtor = (pg.default?.Pool ?? pg.Pool) as typeof import("pg").Pool;
  const TypeOverridesCtor = (pg.default?.TypeOverrides ?? pg.TypeOverrides) as typeof import("pg").TypeOverrides;
  return new PoolCtor({
    connectionString: env.connectionString,
    types: createPostgresGatewayTypeOverrides(TypeOverridesCtor),
  });
}

/** Resolve the gateway env from process env (DATABASE_URL), mirroring the supabase binding shape. */
export function resolvePostgresDataGatewayEnv(env: Record<string, string | undefined>): PostgresDataGatewayEnv {
  return { connectionString: env.DATABASE_URL ?? "" };
}
