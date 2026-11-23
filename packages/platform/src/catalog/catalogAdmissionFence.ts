import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

interface FenceLockWriter {
  query<Row extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

interface FenceConnection extends FenceLockWriter {
  query<Row extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  query<Row extends Record<string, unknown>>(request: {
    text: string;
    values: unknown[];
    query_timeout?: number;
    queryMode?: "extended";
  }): Promise<{ rows: Row[] }>;
  on?(event: "error", listener: (error: Error) => void): unknown;
  removeListener?(event: "error", listener: (error: Error) => void): unknown;
  release(discard?: boolean): void;
}

interface FencePool<Connection extends FenceConnection> {
  connect(): Promise<Connection>;
}

const unavailableCode = "catalog_admission_fence_unavailable";
const unavailable = () => new Error(unavailableCode);
// Safe owner identities recognized at the checkout boundary. The fence owns its own refusal.
const ownerRefusals = new Set([
  "catalog_admission_quote_authority_required", "catalog_admission_evidence_binding_mismatch", "catalog_admission_quote_projection_moved",
  "catalog_publication_head_moved", "catalog_admission_membership_authority_unavailable", "catalog_admission_line_ineligible",
  "catalog_admission_price_context_required", "catalog_admission_roster_archived",
  "catalog_acceptance_receipt_mismatch", "catalog_acceptance_line_mismatch", "catalog_acceptance_immutable",
]);
const retry = "Retry the same request with the same idempotency key.";
const checklist = "Check the native binding, connection/TLS, privileges and migrations.";
const expired = Symbol("fence_budget_expired");
const unfinished = Symbol("prelock_query_unfinished");
const wallMarginMs = 50;
const maxTimeoutMs = 2_147_483_647;
const visibilityChanged = () => Object.assign(new Error("catalog_admission_visibility_changed"), { code: "40001" });

function rejection() {
  let reject!: (error: unknown) => void;
  const promise = new Promise<never>((_, fail) => { reject = fail; });
  return { promise, reject };
}

function fenceRefusal(error: unknown, locks: boolean) {
  const code = (error as { code?: unknown } | null)?.code;
  if (locks && code === "40001") return Object.assign(visibilityChanged(), { hint: retry });
  const contention = locks && (code === "55P03" || code === "40P01");
  if (locks && !contention && code !== "57014" && error instanceof Error && ownerRefusals.has(error.message)) {
    return Object.getPrototypeOf(error) === Error.prototype &&
      Reflect.ownKeys(error).every(key => key === "stack" || key === "message") ? error : new Error(error.message);
  }
  return Object.assign(unavailable(), { hint: error === expired || contention ? retry : checklist });
}

function monitorConnections() {
  const aborted = rejection();
  let failed = false;
  const onError = (error: Error) => { failed = true; aborted.reject(error); };
  return {
    abort: aborted.promise,
    get failed() { return failed; },
    watch(client: FenceConnection) { client.on?.("error", onError); },
    release(client: FenceConnection, discard: boolean) {
      client.release(discard);
      client.removeListener?.("error", onError);
    },
  };
}

async function reservePair<Connection extends FenceConnection>(
  pool: FencePool<Connection>, timeoutMs: number, monitor?: ReturnType<typeof monitorConnections>,
): Promise<[Connection, Connection]> {
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
    monitor?.watch(client);
    return client;
  }
  try {
    return await Promise.race([
      Promise.all([acquire(), acquire()]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(expired), timeoutMs); }),
      ...(monitor ? [monitor.abort] : []),
    ]);
  } catch (error) {
    cancelled = true;
    for (const client of reserved) {
      if (monitor) monitor.release(client, monitor.failed);
      else client.release();
    }
    throw monitor ? fenceRefusal(error, false) : unavailable();
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

async function runPrelock(
  writer: FenceConnection, prelock: (writer: FenceLockWriter) => Promise<void>,
  deadline: number, abort: Promise<never>,
) {
  const aborted = rejection();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false, closed = false;
  function remaining() {
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0) throw expired;
    return ms;
  }
  function expireAtWall() {
    const ms = Math.ceil(deadline + wallMarginMs - performance.now());
    if (ms <= 0) {
      closed = true;
      aborted.reject(expired);
    } else timer = setTimeout(expireAtWall, Math.min(ms, maxTimeoutMs));
  }
  let originalLockMs = 0;
  function setDispatchTimeouts() {
    const ms = remaining();
    const lockMs = originalLockMs > 0 ? Math.min(ms, originalLockMs) : ms;
    return writer.query(`SET LOCAL lock_timeout = ${lockMs}; SET LOCAL statement_timeout = ${ms + wallMarginMs}`);
  }
  const lockWriter: FenceLockWriter = {
    query<Row extends Record<string, unknown>>(text: string, values: unknown[] = []) {
      const work = (async () => {
        if (closed || pending) throw new Error("Prelock must await one statement at a time");
        pending = true;
        try {
          await setDispatchTimeouts();
          if (closed) throw unfinished;
          if (performance.now() >= deadline) throw expired;
          // The extended protocol accepts exactly one SQL statement per request.
          return await writer.query<Row>({ text, values, queryMode: "extended" });
        } catch (error) {
          aborted.reject(error);
          throw error;
        } finally {
          pending = false;
        }
      })();
      void work.catch(() => {});
      return work;
    },
  };
  expireAtWall();
  try {
    await Promise.race([aborted.promise, abort, (async () => {
      remaining();
      const { rows: [settings] } = await writer.query<{ statement: string; lock_ms: number }>(
        "SELECT current_setting('statement_timeout') AS statement, setting::int AS lock_ms FROM pg_settings WHERE name='lock_timeout'",
      );
      originalLockMs = settings!.lock_ms;
      // At the input ceiling, wait inside the budget until PostgreSQL can represent the backstop.
      const overflow = Math.ceil(deadline + wallMarginMs - performance.now() - maxTimeoutMs);
      if (overflow > 0) await delay(overflow + 1);
      if (closed) throw expired;
      await setDispatchTimeouts();
      if (closed) throw expired;
      remaining();
      try {
        await prelock(Object.freeze(lockWriter));
      } finally {
        closed = true;
        if (pending) aborted.reject(unfinished);
      }
      if (pending) throw unfinished;
      remaining();
      await writer.query("SELECT set_config('lock_timeout',$1,true), set_config('statement_timeout',$2,true)",
        [`${originalLockMs}ms`, settings!.statement]);
    })()]);
  } finally {
    closed = true;
    clearTimeout(timer);
  }
}

/** Component lane for bound owner reads. Its checkout-owner login stays ungranted. */
export async function withCatalogAdmissionFence<T, Connection extends FenceConnection>(
  pool: FencePool<Connection>,
  input: { key: string; clientId: string; skuIds: string[]; revisionIds: string[]; priceListId: string; timeoutMs: number },
  read: (db: Connection, effectInstant: string) => Promise<T>,
  options?: {
    /** Locks only, on the writer after the key advisory lock and before receipt locking. */
    prelock?: (writer: FenceLockWriter) => Promise<void>;
  },
): Promise<T> {
  const entry = { timeoutMs: input.timeoutMs, prelock: options?.prelock };
  const { prelock, timeoutMs } = entry;
  if (prelock !== undefined) {
    if (typeof prelock !== "function") throw new TypeError("prelock must be a function");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeoutMs) {
      throw new TypeError("timeoutMs must be an integer from 1 to 2147483647");
    }
  }
  const deadline = prelock ? performance.now() + timeoutMs : 0;
  const monitor = prelock ? monitorConnections() : undefined;
  const [writer, probe] = await reservePair(pool, timeoutMs, monitor);
  let writerFailed = false;
  let probeFailed = false;
  let reading = false;
  async function transact() {
    await writer.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const nonce = [randomInt(1, 2 ** 31), randomInt(1, 2 ** 31)];
    const identity = (await writer.query<{ xid: string; pid: number }>(`SELECT pg_current_xact_id()::text AS xid, pg_backend_pid() AS pid
      FROM pg_advisory_xact_lock($1::integer,$2::integer)`, nonce)).rows[0]!;
    const scope = [identity.xid, identity.pid, ...nonce];
    await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [input.key]);
    if (prelock && monitor) await runPrelock(writer, prelock, deadline, monitor.abort);
    await writer.query("SELECT order_id FROM public.commerce_order_draft_receipts WHERE idempotency_key=$1 FOR UPDATE", [input.key]);
    await writer.query("SELECT id FROM public.clients WHERE id=$1 FOR KEY SHARE", [input.clientId]);
    await writer.query("SELECT id FROM public.catalog_skus WHERE id=ANY($1::uuid[]) ORDER BY id FOR KEY SHARE", [input.skuIds]);
    await writer.query("SELECT id FROM public.catalog_sku_revisions WHERE id=ANY($1::uuid[]) ORDER BY id FOR KEY SHARE", [input.revisionIds]);
    await writer.query("SELECT public.catalog_admission_lock_shared()");
    await writer.query("SELECT public.catalog_admission_lock_checkout_price($1,$2)", [input.priceListId, input.skuIds]);
    const frozen = (await writer.query<Visibility>(snapshotSql, scope)).rows[0]!;
    const current = (await probe.query<Visibility>({
      text: snapshotSql, values: scope, query_timeout: prelock ? timeoutMs : input.timeoutMs,
    }).catch(error => {
      probeFailed = true;
      throw prelock ? error : unavailable();
    })).rows[0]!;
    if (!frozen.primary || !current.primary) throw unavailable();
    if (frozen.xmax !== current.xmax || frozen.xip.join(",") !== current.xip.join(",")) {
      throw visibilityChanged();
    }
    const instant = (await writer.query<{ instant: string }>("SELECT clock_timestamp()::text AS instant")).rows[0]!.instant;
    reading = true;
    const result = await read(writer, instant);
    await writer.query("COMMIT");
    return result;
  }
  try {
    const work = transact();
    return await (monitor ? Promise.race([work, monitor.abort]) : work);
  } catch (error) {
    writerFailed = error === expired || error === unfinished || monitor?.failed === true;
    if (!writerFailed) {
      try {
        const rollback = writer.query("ROLLBACK");
        await (monitor ? Promise.race([rollback, monitor.abort]) : rollback);
      } catch { writerFailed = true; }
    }
    throw prelock && (!reading || monitor?.failed)
      ? fenceRefusal(error, !probeFailed && !monitor?.failed)
      : error;
  } finally {
    const release = (client: FenceConnection, discard: boolean) => {
      if (monitor) monitor.release(client, discard || monitor.failed);
      else client.release(discard);
    };
    release(writer, writerFailed);
    release(probe, probeFailed);
  }
}
