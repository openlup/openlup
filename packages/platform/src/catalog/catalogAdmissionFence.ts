import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { types } from "node:util";

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
  if (error === expired || (locks && (code === "55P03" || code === "40P01"))) {
    return Object.assign(unavailable(), { hint: retry });
  }
  if (locks && code === "40001") return Object.assign(visibilityChanged(), { hint: retry });
  if (locks && code !== "57014" && error instanceof Error && ownerRefusals.has(error.message)) {
    return Object.getPrototypeOf(error) === Error.prototype &&
      Reflect.ownKeys(error).every(key => key === "stack" || key === "message") ? error : new Error(error.message);
  }
  return Object.assign(unavailable(), { hint: checklist });
}

function monitorConnections() {
  const aborted = rejection();
  let failed = false;
  const watched = new Set<FenceConnection>();
  const listeners = new Map<FenceConnection, (error: Error) => void>();
  return {
    abort: aborted.promise,
    get failed() { return failed; },
    watch(client: FenceConnection) {
      const onError = (error: Error) => {
        if (!watched.has(client)) return;
        failed = true;
        aborted.reject(error);
      };
      watched.add(client);
      listeners.set(client, onError);
      client.on?.("error", onError);
    },
    release(client: FenceConnection, discard: boolean) {
      watched.delete(client);
      const onError = listeners.get(client);
      listeners.delete(client);
      try { client.release(discard); } catch { /* Settlement already chose the outcome. */ }
      if (onError) {
        try { client.removeListener?.("error", onError); } catch { /* The connection was released. */ }
      }
    },
  };
}

function fenceBudget(timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  const wall = rejection();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiredNow = () => performance.now() >= deadline;
  function remaining() {
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0) throw expired;
    return ms;
  }
  function tick() {
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0) wall.reject(expired);
    else timer = setTimeout(tick, Math.min(ms, maxTimeoutMs));
  }
  tick();
  return { remaining, expiredNow, wall: wall.promise, stop: () => clearTimeout(timer) };
}

async function reservePair<Connection extends FenceConnection>(
  pool: FencePool<Connection>, budget: ReturnType<typeof fenceBudget>,
  monitor: ReturnType<typeof monitorConnections>, abort: Promise<never>,
): Promise<[Connection, Connection]> {
  const reserved: Connection[] = [];
  let closed = false;
  async function acquire() {
    const client = await pool.connect();
    if (closed || budget.expiredNow()) {
      monitor.release(client, false);
      throw expired;
    }
    reserved.push(client);
    monitor.watch(client);
    return client;
  }
  try {
    const pair = await Promise.race([abort, Promise.all([acquire(), acquire()])]);
    budget.remaining();
    return pair;
  } catch (error) {
    closed = true;
    for (const client of reserved) monitor.release(client, monitor.failed);
    throw fenceRefusal(budget.expiredNow() ? expired : error, false);
  }
}

const snapshotSql = (selected: boolean) => `WITH snap AS MATERIALIZED (SELECT pg_current_snapshot() AS value)
  SELECT pg_snapshot_xmax(value)::text AS xmax,
    ARRAY(SELECT xid::text FROM pg_snapshot_xip(value) xid WHERE xid <> $1::xid8 ORDER BY xid) AS xip,
${selected ? "    current_user::text AS role, session_user::text AS login,\n" : ""}    NOT pg_is_in_recovery() AND EXISTS (
      SELECT 1 FROM pg_locks WHERE locktype='advisory' AND mode='ExclusiveLock' AND granted AND pid=$2
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND classid=$3::oid AND objid=$4::oid AND objsubid=2
    ) AS primary FROM snap`;

type Visibility = { xmax: string; xip: string[]; primary: boolean; role: string; login: string };
type GuardedDispatch = <Row extends Record<string, unknown>>(
  text: string, values?: unknown[], isClosed?: () => boolean,
) => Promise<{ rows: Row[] }>;

async function runPrelock(
  dispatch: GuardedDispatch, prelock: (writer: FenceLockWriter) => Promise<void>, abort: Promise<never>,
) {
  const aborted = rejection();
  let pending = false, closed = false;
  let queriedAfterSettlement = false;
  const lockWriter: FenceLockWriter = {
    query<Row extends Record<string, unknown>>(text: string, values: unknown[] = []) {
      const work = (async () => {
        if (closed || pending) {
          if (closed) queriedAfterSettlement = true;
          else aborted.reject(unfinished);
          throw new Error("Prelock must await one statement at a time");
        }
        pending = true;
        try {
          return await dispatch<Row>(text, values, () => closed);
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
  try {
    await Promise.race([aborted.promise, abort, (async () => {
      try {
        await prelock(Object.freeze(lockWriter));
      } finally {
        closed = true;
      }
      if (pending) throw unfinished;
    })()]);
    if (queriedAfterSettlement) throw unfinished;
  } finally {
    closed = true;
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
  const prelock = options?.prelock;
  if (prelock !== undefined && typeof prelock !== "function") throw new TypeError("prelock must be a function");
  const { timeoutMs, key, clientId, skuIds, revisionIds, priceListId } = input;
  validateTimeout(timeoutMs);
  return runFence(pool, { timeoutMs, key, clientId }, { kind: "legacy", prelock, read, priceListId,
    skuIds: Array.isArray(skuIds) ? [...skuIds] : skuIds,
    revisionIds: Array.isArray(revisionIds) ? [...revisionIds] : revisionIds });
}

type FenceInput = { key: string; clientId: string; timeoutMs: number };
type SelectedScope = { skuIds: readonly [string, string]; skuRevisionId: string; priceListId: string };
const dispatchSelected = "SELECT public.catalog_admission_runtime_checkout($1::text,$2::text,$3::uuid,$4::jsonb) AS result";
const canonicalUuid = (value: unknown) => typeof value === "string" && value.length === 36 &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);

/** The server supplies scope only for an evaluation covered by these guards.
 * @internal
 */
export async function withSelectedCatalogAdmissionFence<T, Connection extends FenceConnection>(
  pool: FencePool<Connection>, input: FenceInput, scope: SelectedScope | undefined,
  read: (db: FenceLockWriter, effectInstant: string, receiptPresent: boolean) => Promise<T>,
  authorizeFresh: () => void,
): Promise<T> {
  const { key, clientId, timeoutMs } = input;
  validateTimeout(timeoutMs);
  if (typeof key !== "string" || key.length < 8 || key.length > 120 || /[^!-~]/u.test(key) || !canonicalUuid(clientId)) {
    throw new TypeError("Use the original printable checkout key and canonical client ID");
  }
  let payload: string | undefined;
  if (scope !== undefined) {
    const { skuIds, skuRevisionId, priceListId } = scope;
    if (Object.keys(scope).length !== 3 || !Array.isArray(skuIds) || skuIds.length !== 2 ||
      !canonicalUuid(skuIds[0]) || !canonicalUuid(skuIds[1]) || skuIds[0] === skuIds[1] ||
      !canonicalUuid(skuRevisionId) || !canonicalUuid(priceListId)) throw new TypeError("Invalid selected catalogue scope");
    payload = JSON.stringify({ skuIds: [...skuIds], skuRevisionId, priceListId });
  }
  if (typeof authorizeFresh !== "function") throw new TypeError("authorizeFresh must be a function");
  return runFence(pool, { key, clientId, timeoutMs }, { kind: "selected", payload, read, authorizeFresh });
}

function validateTimeout(timeoutMs: number) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeoutMs) {
    throw new TypeError("timeoutMs must be an integer from 1 to 2147483647");
  }
}

async function runFence<T, Connection extends FenceConnection>(
  pool: FencePool<Connection>, { timeoutMs, key, clientId }: FenceInput,
  mode: { kind: "legacy"; prelock?: (writer: FenceLockWriter) => Promise<void>;
    read: (db: Connection, instant: string) => Promise<T>; skuIds: string[]; revisionIds: string[]; priceListId: string } |
  { kind: "selected"; payload?: string; read: (db: FenceLockWriter, instant: string, receipt: boolean) => Promise<T>;
    authorizeFresh: () => void },
): Promise<T> {
  const selected = mode.kind === "selected";
  const budget = fenceBudget(timeoutMs);
  const monitor = monitorConnections();
  const abort = Promise.race([budget.wall, monitor.abort]);
  try {
    const [writer, probe] = await reservePair(pool, budget, monitor, abort);
    let writerFailed = false, probeFailed = false, probePending = false, probeReleased = false;
    let preparing = true, reading = false, writerPending = false;
    let committing = false, receiptPresent = false;
    let authorizationFailure: { error: unknown } | undefined;
    let originalLockMs = 0;
    let originalStatement = "";

    function releaseProbe(destroy = false) {
      if (probeReleased) return;
      probeReleased = true;
      monitor.release(probe, destroy || probePending || probeFailed || monitor.failed);
    }

    function activeRemaining() {
      const ms = budget.remaining();
      if (!preparing || monitor.failed) throw unfinished;
      return ms;
    }

    function transport<Row extends Record<string, unknown>>(text: string, values: unknown[] = [], extended = false) {
      if (!selected && !extended) return writer.query<Row>(text);
      return writer.query<Row>({ text, values, ...(extended ? { queryMode: "extended" } : {}),
        ...(selected ? { query_timeout: activeRemaining() } : {}) });
    }

    async function dispatch<Row extends Record<string, unknown>>(text: string, values: unknown[] = [], isClosed?: () => boolean) {
      const ms = activeRemaining();
      if (isClosed?.()) throw unfinished;
      const lockMs = originalLockMs > 0 ? Math.min(ms, originalLockMs) : ms;
      writerPending = true;
      try {
        await transport(`SET LOCAL lock_timeout = ${lockMs}; SET LOCAL statement_timeout = ${ms + wallMarginMs}`);
        activeRemaining();
        if (isClosed?.()) throw unfinished;
        return await transport<Row>(text, values, true);
      } finally {
        writerPending = false;
      }
    }

    const restoreSettings = () => dispatch("SELECT set_config('lock_timeout',$1,true), set_config('statement_timeout',$2,true)",
      [`${originalLockMs}ms`, originalStatement]);

    async function prepare() {
      activeRemaining();
      // Capture settings outside the transaction so the nonce still pins its snapshot.
      const { rows: [settings] } = await transport<{ statement: string; lock_ms: number }>(
        "SELECT current_setting('statement_timeout') AS statement, setting::int AS lock_ms FROM pg_settings WHERE name='lock_timeout'",
      );
      originalLockMs = settings!.lock_ms;
      originalStatement = settings!.statement;
      activeRemaining();
      await transport("BEGIN ISOLATION LEVEL REPEATABLE READ");
      // At the input ceiling, wait inside the budget for a representable server timeout.
      let overflow = activeRemaining() + wallMarginMs - maxTimeoutMs;
      while (overflow > 0) {
        await delay(overflow);
        overflow = activeRemaining() + wallMarginMs - maxTimeoutMs;
      }
      const nonce = [randomInt(1, 2 ** 31), randomInt(1, 2 ** 31)];
      const identity = (await dispatch<{ xid: string; pid: number }>(`SELECT pg_current_xact_id()::text AS xid, pg_backend_pid() AS pid
      FROM pg_advisory_xact_lock($1::integer,$2::integer)`, nonce)).rows[0]!;
      const scope = [identity.xid, identity.pid, ...nonce];
      await dispatch("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [key]);
      if (mode.kind === "legacy" && mode.prelock) {
        activeRemaining();
        await runPrelock(dispatch, mode.prelock, abort);
      }
      const receipt = await dispatch("SELECT order_id FROM public.commerce_order_draft_receipts WHERE idempotency_key=$1 FOR UPDATE", [key]);
      receiptPresent = receipt.rows.length !== 0;
      if (mode.kind === "legacy") {
        await dispatch("SELECT id FROM public.clients WHERE id=$1 FOR KEY SHARE", [clientId]);
        await dispatch("SELECT id FROM public.catalog_skus WHERE id=ANY($1::uuid[]) ORDER BY id FOR KEY SHARE", [mode.skuIds]);
        await dispatch("SELECT id FROM public.catalog_sku_revisions WHERE id=ANY($1::uuid[]) ORDER BY id FOR KEY SHARE", [mode.revisionIds]);
        await dispatch("SELECT public.catalog_admission_lock_shared()");
        await dispatch("SELECT public.catalog_admission_lock_checkout_price($1,$2)", [mode.priceListId, mode.skuIds]);
      } else if (!receiptPresent) {
        activeRemaining();
        try {
          const result: unknown = mode.authorizeFresh();
          if (result !== undefined) {
            if (types.isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
            throw new TypeError("authorizeFresh must return undefined");
          }
        } catch (error) { authorizationFailure = { error }; }
        if (!authorizationFailure && mode.payload) {
          const { rows } = await dispatch<{ result: unknown }>(dispatchSelected, ["prelock", key, clientId, mode.payload]);
          const result = rows[0]?.result;
          if (rows.length !== 1 || !result || typeof result !== "object" ||
            Reflect.ownKeys(result).length !== 1 || !Object.hasOwn(result, "kind") || Reflect.get(result, "kind") !== "locked") throw unavailable();
        }
      }
      const snapshot = snapshotSql(selected);
      const frozen = (await dispatch<Visibility>(snapshot, scope)).rows[0]!;
      const probeMs = activeRemaining();
      probePending = true;
      let current: Visibility | undefined;
      try {
        const result = await probe.query<Visibility>({ text: snapshot, values: scope, query_timeout: probeMs });
        [current] = result.rows;
      } catch (error) {
        probeFailed = true;
        throw error;
      } finally {
        probePending = false;
        releaseProbe(probeFailed);
      }
      activeRemaining();
      if (!frozen.primary || !current?.primary) throw unavailable();
      if (selected && (frozen.role !== current.role || frozen.login !== current.login)) throw unavailable();
      if (frozen.xmax !== current.xmax || frozen.xip.join(",") !== current.xip.join(",")) throw visibilityChanged();
      // A receipt inserted while the key was blocked is invisible to the writer's snapshot.
      if (authorizationFailure) throw authorizationFailure.error;
      if (mode.kind === "selected" && !receiptPresent && !mode.payload) throw new Error("catalog_admission_line_ineligible");
      const instant = (await dispatch<{ instant: string }>("SELECT clock_timestamp()::text AS instant")).rows[0]!.instant;
      await restoreSettings();
      return instant;
    }

    try {
      const instant = await Promise.race([abort, prepare()]);
      activeRemaining();
      reading = true;
      let result: T;
      if (mode.kind === "selected") {
        let closed = false, pending = 0;
        let queue = Promise.resolve();
        const db: FenceLockWriter = Object.freeze({ query<Row extends Record<string, unknown>>(text: string, values?: unknown[]) {
          pending++;
          const query = queue.then(() => dispatch<Row>(text, values, () => closed)).finally(() => { pending--; });
          queue = query.then(() => {}, () => {});
          return query;
        } });
        try {
          result = await Promise.race([mode.read(db, instant, receiptPresent), budget.wall]);
          budget.remaining();
          if (pending) throw unfinished;
        } finally { closed = true; }
        if (monitor.failed) throw fenceRefusal(undefined, false);
        try { await Promise.race([restoreSettings(), abort]); budget.remaining(); }
        catch (error) { throw fenceRefusal(budget.expiredNow() ? expired : error, !monitor.failed); }
      } else {
        preparing = false;
        budget.stop();
        result = await mode.read(writer, instant);
      }
      if (monitor.failed) throw fenceRefusal(undefined, false);
      preparing = false;
      budget.stop();
      committing = true;
      await writer.query("COMMIT");
      return result;
    } catch (error) {
      preparing = false;
      writerFailed = monitor.failed || writerPending || committing || error === unfinished || ((selected || !reading) && budget.expiredNow());
      if (!writerFailed) {
        try {
          // ROLLBACK must also work in a failed transaction, where SET LOCAL is refused.
          const rollback = writer.query("ROLLBACK");
          await Promise.race([reading && !selected ? monitor.abort : abort, rollback]);
        } catch { writerFailed = true; }
      }
      if (!reading && budget.expiredNow()) {
        writerFailed = true;
        throw fenceRefusal(expired, false);
      }
      if (!reading && authorizationFailure && authorizationFailure.error === error) throw error;
      if (!reading) throw fenceRefusal(error, !probeFailed && !monitor.failed);
      if (selected && (error === expired || error === unfinished)) throw fenceRefusal(error, false);
      throw error;
    } finally {
      monitor.release(writer, writerFailed || monitor.failed);
      releaseProbe();
    }
  } finally {
    budget.stop();
  }
}
