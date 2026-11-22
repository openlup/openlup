import { randomInt } from "node:crypto";

interface FenceConnection {
  query<Row extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  query<Row extends Record<string, unknown>>(request: {
    text: string;
    values: unknown[];
    query_timeout: number;
  }): Promise<{ rows: Row[] }>;
  release(discard?: boolean): void;
}

interface FencePool<Connection extends FenceConnection> {
  connect(): Promise<Connection>;
}

const unavailable = () => new Error("catalog_admission_fence_unavailable");

async function reservePair<Connection extends FenceConnection>(pool: FencePool<Connection>, timeoutMs: number): Promise<[Connection, Connection]> {
  const reserved: Connection[] = [];
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function acquire() {
    const client = await pool.connect();
    if (cancelled) {
      client.release();
      throw unavailable();
    }
    reserved.push(client);
    return client;
  }
  try {
    return await Promise.race([
      Promise.all([acquire(), acquire()]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), timeoutMs); }),
    ]);
  } catch {
    cancelled = true;
    for (const client of reserved) client.release();
    throw unavailable();
  } finally {
    clearTimeout(timer);
  }
}

const snapshotSql = `WITH snap AS MATERIALIZED (SELECT pg_current_snapshot() AS value)
  SELECT pg_snapshot_xmax(value)::text AS xmax,
    ARRAY(SELECT xid::text FROM pg_snapshot_xip(value) xid WHERE xid <> $1::xid8 ORDER BY xid) AS xip,
    NOT pg_is_in_recovery() AND EXISTS (
      SELECT 1 FROM pg_locks WHERE locktype='advisory' AND mode='ExclusiveLock' AND granted AND pid=$2
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND classid=$3::oid AND objid=$4::oid AND objsubid=2
    ) AS primary FROM snap`;

type Visibility = { xmax: string; xip: string[]; primary: boolean };

/** Component lane for bound owner reads. Its checkout-owner login stays ungranted. */
export async function withCatalogAdmissionFence<T, Connection extends FenceConnection>(
  pool: FencePool<Connection>,
  input: { key: string; clientId: string; skuIds: string[]; revisionIds: string[]; priceListId: string; timeoutMs: number },
  read: (db: Connection, effectInstant: string) => Promise<T>,
): Promise<T> {
  const [writer, probe] = await reservePair(pool, input.timeoutMs);
  let writerFailed = false;
  let probeFailed = false;
  try {
    await writer.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const nonce = [randomInt(1, 2 ** 31), randomInt(1, 2 ** 31)];
    const identity = (await writer.query<{ xid: string; pid: number }>(`SELECT pg_current_xact_id()::text AS xid, pg_backend_pid() AS pid
      FROM pg_advisory_xact_lock($1::integer,$2::integer)`, nonce)).rows[0]!;
    const scope = [identity.xid, identity.pid, ...nonce];
    await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [input.key]);
    await writer.query("SELECT order_id FROM public.commerce_order_draft_receipts WHERE idempotency_key=$1 FOR UPDATE", [input.key]);
    await writer.query("SELECT id FROM public.clients WHERE id=$1 FOR KEY SHARE", [input.clientId]);
    await writer.query("SELECT id FROM public.catalog_skus WHERE id=ANY($1::uuid[]) ORDER BY id FOR KEY SHARE", [input.skuIds]);
    await writer.query("SELECT id FROM public.catalog_sku_revisions WHERE id=ANY($1::uuid[]) ORDER BY id FOR KEY SHARE", [input.revisionIds]);
    await writer.query("SELECT public.catalog_admission_lock_shared()");
    await writer.query("SELECT public.catalog_admission_lock_checkout_price($1,$2)", [input.priceListId, input.skuIds]);
    const frozen = (await writer.query<Visibility>(snapshotSql, scope)).rows[0]!;
    const current = (await probe.query<Visibility>({
      text: snapshotSql, values: scope, query_timeout: input.timeoutMs,
    }).catch(() => {
      probeFailed = true;
      throw unavailable();
    })).rows[0]!;
    if (!frozen.primary || !current.primary) throw unavailable();
    if (frozen.xmax !== current.xmax || frozen.xip.join(",") !== current.xip.join(",")) {
      throw Object.assign(new Error("catalog_admission_visibility_changed"), { code: "40001" });
    }
    const instant = (await writer.query<{ instant: string }>("SELECT clock_timestamp()::text AS instant")).rows[0]!.instant;
    const result = await read(writer, instant);
    await writer.query("COMMIT");
    return result;
  } catch (error) {
    try { await writer.query("ROLLBACK"); } catch { writerFailed = true; }
    throw error;
  } finally {
    writer.release(writerFailed);
    probe.release(probeFailed);
  }
}
