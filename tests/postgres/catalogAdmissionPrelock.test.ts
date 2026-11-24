import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { setImmediate as yieldTurn, setTimeout as delay } from "node:timers/promises";
import { Client, Pool, type PoolClient, type QueryConfig } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { catalogDefinitionDigest, createCatalogProductTypeRegistry, createPostgresCatalogDraftStoreV4,
  createPostgresCatalogPublicationCommands, withCatalogPublicationRules } from "@openlup/platform/catalog";
import { canonicalCatalogDraftJson, type CatalogDraftPayloadV3 } from "@openlup/platform/catalog/contracts";
import { withCatalogAdmissionFence } from "@openlup/platform/catalog/testing";
import { createPostgresNativeCheckoutPersistence } from "@openlup/platform/commerce/server/native-checkout";
import { createCatalogPriceSetupHandler, createPostgresCatalogPriceSetupStore, type CreateQuoteResponse } from "@openlup/platform/pricing";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { actorId, authoredPublicationDocument, hash, installPublicationActors, transaction } from "./catalogPublicationFixture.js";
import { destinationContext, documentTable, readSnapshot, reachDestinationCutoff, selectionTable, snapshot } from "./destinationDocumentFixture.js";
import { receiptArgs, receiptCall, receiptClient } from "./destinationReceiptFixture.js";
import { lifecycleInstallation, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";

let installation: LifecycleInstallation;
let orderingPool: Pool;
let clientId: string, skuId: string, priceListId: string, orderId: string;
const setupTimeout = 6_000;
const wallMarginMs = 50;
const barrierTimeout = setupTimeout - 1_000;
const sameKey = "Retry the same request with the same idempotency key.";
const checklist = "Check the native binding, connection/TLS, privileges and migrations.";
const unavailable = "catalog_admission_fence_unavailable";
const visibility = "catalog_admission_visibility_changed";
const ledgerSql = "LOCK TABLE public.identity_privacy_erasures IN SHARE MODE";
const clientSql = "SELECT id FROM public.clients WHERE id=$1 FOR KEY SHARE";
const ownerSql = "SELECT id FROM public.clients WHERE id=$1 FOR UPDATE";
const orderSql = "SELECT id FROM public.commerce_orders WHERE id=$1 FOR NO KEY UPDATE";

const scope = (timeoutMs = setupTimeout) => ({ key: randomUUID(), clientId, priceListId,
  skuIds: [skuId], revisionIds: [] as string[], timeoutMs });
type Prelock = NonNullable<NonNullable<Parameters<typeof withCatalogAdmissionFence>[3]>["prelock"]>;
const guard: Prelock = async db => {
  await db.query(ledgerSql);
  await db.query(clientSql, [clientId]);
};
function latch<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(ready => { resolve = ready; });
  return { promise, resolve, async wait(...operations: Promise<unknown>[]) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        ...operations.map(operation => operation.then(() => { throw new Error("Operation finished before its barrier"); })),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Barrier did not open")), barrierTimeout); }),
      ]);
    } finally { clearTimeout(timer); }
  } };
}
const pid = async (db: PoolClient) => Number((await db.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);

beforeAll(async () => {
  installation = await lifecycleInstallation("qualified-v2", { freshCluster: true });
  const owner = installation.owner;
  orderingPool = new Pool({ ...owner.options,
    options: `-c deadlock_timeout=200ms -c lock_timeout=${setupTimeout}ms -c statement_timeout=${setupTimeout + wallMarginMs}ms` });
  clientId = (await owner.query("INSERT INTO public.clients(email) VALUES('prelock@example.invalid') RETURNING id")).rows[0]!.id;
  orderId = (await owner.query(`INSERT INTO public.commerce_orders(client_id,status,currency_code,total_amount_minor)
    VALUES($1,'pending_payment','XXX',0) RETURNING id`, [clientId])).rows[0]!.id;
  skuId = randomUUID();
  await owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'prelock-article','Example article')", [skuId]);
  await owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,'PRELOCK','Example article')", [skuId]);
  priceListId = (await owner.query("INSERT INTO public.price_lists(name,region_code,currency) VALUES('Example','ZZ','XXX') RETURNING id")).rows[0]!.id;
  await installPublicationActors(owner);
  await owner.query(`INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_region','ZZ'),('settlement_currency','XXX')
    ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`);
  await owner.query("SELECT public.commerce_capture_offer_policy_v2_legacy_baseline()");
}, postgresSetupTimeoutMs);
afterAll(async () => {
  try { await orderingPool?.end(); } finally { await installation?.close(); }
}, postgresTeardownTimeoutMs);

type ClientObserver = (index: number, db: PoolClient) => Promise<void> | void;
type QueryObserver = (index: number, text: string, request: string | QueryConfig, values?: unknown[]) => Promise<void> | void;
function pair(observeClient: ClientObserver = () => {}, observeQuery: QueryObserver = () => {},
  pool: { connect(): Promise<PoolClient> } = installation.owner, observeError?: (error: unknown) => void,
  observeResult?: (text: string, index: number) => Promise<void> | void,
  observeSettlement?: (text: string, index: number) => void) {
  let index = 0;
  return { async connect() {
    const number = index++;
    const db = await pool.connect();
    try { await observeClient(number, db); } catch (error) { db.release(true); throw error; }
    return {
      query: async (request: string | QueryConfig, values?: unknown[]) => {
        const text = typeof request === "string" ? request : request.text;
        await observeQuery(number, text, request, values);
        try {
          const result = await (typeof request === "string" ? db.query(request, values) : db.query(request));
          await observeResult?.(text, number);
          return result;
        }
        catch (error) { observeError?.(error); throw error; }
        finally { observeSettlement?.(text, number); }
      },
      on: db.on.bind(db), removeListener: db.removeListener.bind(db), release: db.release.bind(db),
    } as PoolClient;
  } };
}

async function waitForBlock(waiter: number, holder: number, locktype: string, relation?: string) {
  const end = performance.now() + barrierTimeout;
  do {
    const { rows } = await installation.owner.query(`SELECT 1 FROM pg_locks
      WHERE pid=$1 AND NOT granted AND locktype=$3 AND $2=ANY(pg_blocking_pids($1))
      AND ($4::text IS NULL OR relation=to_regclass($4))`, [waiter, holder, locktype, relation ?? null]);
    if (rows.length) return;
    await yieldTurn();
  } while (performance.now() < end);
  throw new Error(`Backend ${waiter} never waited on ${locktype} held by ${holder}`);
}

const lockTrace = [
  "BEGIN ISOLATION LEVEL REPEATABLE READ",
  "SELECT pg_current_xact_id()",
  "SELECT pg_advisory_xact_lock(hashtextextended",
  "SELECT order_id FROM public.commerce_order_draft_receipts",
  clientSql,
  "SELECT id FROM public.catalog_skus",
  "SELECT id FROM public.catalog_sku_revisions",
  "SELECT public.catalog_admission_lock_shared()",
  "SELECT public.catalog_admission_lock_checkout_price(",
  "WITH snap AS MATERIALIZED",
  "WITH snap AS MATERIALIZED",
  "SELECT clock_timestamp()",
  "COMMIT",
];
const captureSql = "SELECT current_setting('statement_timeout') AS statement, setting::int AS lock_ms FROM pg_settings WHERE name='lock_timeout'";
const restoreSql = "SELECT set_config('lock_timeout',$1,true), set_config('statement_timeout',$2,true)";
const timeoutSettings = /^SET LOCAL lock_timeout = (\d+); SET LOCAL statement_timeout = (\d+)$/u;

function expectFenceError(error: unknown, fields: { message: string; hint?: string; code?: string }) {
  expect(error).toMatchObject(fields);
  expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
  expect(Reflect.ownKeys(error as object).filter(key => key !== "stack").sort()).toEqual(Object.keys(fields).sort());
}

const traceName = (sql: string) => lockTrace.find(entry => sql.startsWith(entry)) ?? sql;

it("prelock runs once on the writer between the key advisory and receipt locks", async () => {
  const trace: [number, string][] = [];
  const read = vi.fn(async () => "accepted");
  const prelock = vi.fn<Prelock>(async db => { trace.push([0, "hook"]); await guard(db); });
  expect(await withCatalogAdmissionFence(pair(undefined, (index, sql) => { trace.push([index, traceName(sql)]); }),
    scope(), read, { prelock })).toBe("accepted");
  expect(prelock).toHaveBeenCalledTimes(1);
  expect(trace.filter(([, sql]) => [...lockTrace, "hook", ledgerSql].includes(sql))).toEqual([
    ...lockTrace.slice(0, 3).map(sql => [0, sql]), [0, "hook"], [0, ledgerSql], [0, clientSql],
    ...lockTrace.slice(3).map((sql, i) => [i === 7 ? 1 : 0, sql]),
  ]);
});

it("refuses a hook statement queued after callback settlement before dispatch", async () => {
  const read = vi.fn(async () => "unexpected");
  const trace: string[] = [];
  const pool = pair(undefined, (_, sql) => { trace.push(sql); });
  const callback = latch();
  let lateQuery: Promise<unknown> | undefined;
  const result = withCatalogAdmissionFence(pool, scope(), read, {
    prelock(db) {
      queueMicrotask(() => {
        callback.resolve();
        queueMicrotask(() => { lateQuery = db.query(ledgerSql).catch(error => error); });
      });
      return callback.promise;
    },
  });
  const refusal = await result.catch(error => error);
  expect(await lateQuery).toEqual(new Error("Prelock must await one statement at a time"));
  expect(trace).not.toContain(ledgerSql);
  expect(read).not.toHaveBeenCalled();
  expectFenceError(refusal, { message: unavailable, hint: checklist });
});

it("rechecks the hook handle after the timeout settings round trip", async () => {
  const read = vi.fn(async () => "unexpected");
  const trace: string[] = [];
  const settings = latch<{ rows: [] }>();
  let settingsCount = 0;
  const pool = { connect: async () => ({
    query(request: string | QueryConfig) {
      const text = typeof request === "string" ? request : request.text;
      trace.push(text);
      if (text === captureSql) return Promise.resolve({ rows: [{ statement: "0", lock_ms: 0 }] });
      if (text.startsWith(lockTrace[1]!)) return Promise.resolve({ rows: [{ xid: "1", pid: 1 }] });
      if (timeoutSettings.test(text) && ++settingsCount === 3) return settings.promise;
      return Promise.resolve({ rows: [] });
    },
    release() {},
  } as unknown as PoolClient) };
  const callback = latch();
  let rejected: Promise<boolean> | undefined;
  const refusal = await withCatalogAdmissionFence(pool, scope(), read, {
    prelock(db) {
      queueMicrotask(() => {
        rejected = db.query(ledgerSql).then(() => false, () => true);
        callback.resolve();
        settings.resolve({ rows: [] });
      });
      return callback.promise;
    },
  }).catch(error => error);
  expect(await rejected).toBe(true);
  expect(trace).not.toContain(ledgerSql);
  expect(read).not.toHaveBeenCalled();
  expectFenceError(refusal, { message: unavailable, hint: checklist });
});

it("omitted and empty options guard the original statement order and snapshot entry values", async () => {
  // Preserve the exact snapshot SQL and nonce across both handles.
  const snapshot = `WITH snap AS MATERIALIZED (SELECT pg_current_snapshot() AS value)
  SELECT pg_snapshot_xmax(value)::text AS xmax,
    ARRAY(SELECT xid::text FROM pg_snapshot_xip(value) xid WHERE xid <> $1::xid8 ORDER BY xid) AS xip,
    NOT pg_is_in_recovery() AND EXISTS (
      SELECT 1 FROM pg_locks WHERE locktype='advisory' AND mode='ExclusiveLock' AND granted AND pid=$2
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND classid=$3::oid AND objid=$4::oid AND objsubid=2
    ) AS primary FROM snap`;
  for (const options of [undefined, {}]) {
    const input = scope(), entry = structuredClone(input);
    const mutableOptions: { prelock?: Prelock } | undefined = options;
    const lateHook = vi.fn<Prelock>();
    let writerPid = 0;
    const trace: [number, string | QueryConfig, unknown[] | undefined][] = [];
    const pool = pair(async (index, db) => {
      if (index === 0) writerPid = await pid(db);
      else {
        Object.assign(input, { key: randomUUID(), clientId: randomUUID(), priceListId: randomUUID(), timeoutMs: 9_000 });
        input.skuIds.splice(0, 1, randomUUID());
        input.revisionIds.push(randomUUID());
        if (mutableOptions) mutableOptions.prelock = lateHook;
      }
    }, (index, _sql, request, values) => { trace.push([index, request, values]); });
    await withCatalogAdmissionFence(pool, input, async () => "accepted", mutableOptions);
    const guarded = trace.filter(([, request]) => typeof request !== "string") as [number, QueryConfig, undefined][];
    const nonce = guarded[0]?.[1].values;
    expect(nonce).toEqual([expect.any(Number), expect.any(Number)]);
    const snapshotArgs = [expect.stringMatching(/^\d+$/u), writerPid, ...nonce!];
    const writerQueries = [
      [`SELECT pg_current_xact_id()::text AS xid, pg_backend_pid() AS pid
      FROM pg_advisory_xact_lock($1::integer,$2::integer)`, nonce],
      ["SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [entry.key]],
      ["SELECT order_id FROM public.commerce_order_draft_receipts WHERE idempotency_key=$1 FOR UPDATE", [entry.key]],
      [clientSql, [entry.clientId]],
      ["SELECT id FROM public.catalog_skus WHERE id=ANY($1::uuid[]) ORDER BY id FOR KEY SHARE", [entry.skuIds]],
      ["SELECT id FROM public.catalog_sku_revisions WHERE id=ANY($1::uuid[]) ORDER BY id FOR KEY SHARE", [entry.revisionIds]],
      ["SELECT public.catalog_admission_lock_shared()", []],
      ["SELECT public.catalog_admission_lock_checkout_price($1,$2)", [entry.priceListId, entry.skuIds]],
      [snapshot, snapshotArgs],
      ["SELECT clock_timestamp()::text AS instant", []],
      [restoreSql, ["0ms", "0"]],
    ];
    const writerTrace = writerQueries.flatMap(([text, values]) => [
      [0, expect.stringMatching(timeoutSettings), undefined],
      [0, { text, values, queryMode: "extended" }, undefined],
    ]);
    expect(trace).toEqual([
      [0, captureSql, undefined],
      [0, "BEGIN ISOLATION LEVEL REPEATABLE READ", undefined],
      ...writerTrace.slice(0, 18),
      [1, { text: snapshot, values: snapshotArgs, query_timeout: expect.any(Number) }, undefined],
      ...writerTrace.slice(18),
      [0, "COMMIT", undefined],
    ]);
    const allowance = (guarded.find(([index]) => index === 1)![1] as QueryConfig & { query_timeout: number }).query_timeout;
    expect(allowance).toBeGreaterThan(0);
    expect(allowance).toBeLessThanOrEqual(entry.timeoutMs);
    expect(lateHook).not.toHaveBeenCalled();
  }
});

it.each([false, true])("lets the price helper refuse a null SKU list with prelock=%s", async hooked => {
  const input = { ...scope(), skuIds: null as unknown as string[] };
  const read = vi.fn(async () => "unexpected");
  let native: unknown;
  const pool = pair(undefined, undefined, installation.owner, error => { native = error; });
  const refusal = await withCatalogAdmissionFence(pool, input, read, hooked ? { prelock: guard } : undefined)
    .catch(error => error);
  const message = "catalog_admission_price_context_required";
  expect(native).toMatchObject({ message, code: "22023" });
  expectFenceError(refusal, { message });
  expect(read).not.toHaveBeenCalled();
});

const keySql = "SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))";
const refusalStages = [
  { stage: "reservation" },
  { stage: "nonce", prefix: "SELECT pg_current_xact_id()" },
  { stage: "key", prefix: keySql },
  { stage: "hook settlement" },
  { stage: "receipt", prefix: "SELECT order_id FROM public.commerce_order_draft_receipts", table: "commerce_order_draft_receipts" },
  { stage: "client", prefix: clientSql, table: "clients" },
  { stage: "SKU", prefix: "SELECT id FROM public.catalog_skus ", table: "catalog_skus" },
  { stage: "revision", prefix: "SELECT id FROM public.catalog_sku_revisions ", table: "catalog_sku_revisions" },
  { stage: "shared helper", prefix: "SELECT public.catalog_admission_lock_shared()", table: "catalog_products" },
  { stage: "price helper", prefix: "SELECT public.catalog_admission_lock_checkout_price(", table: "price_entries" },
  { stage: "writer snapshot", prefix: "WITH snap AS MATERIALIZED" },
  { stage: "probe", prefix: "WITH snap AS MATERIALIZED" },
  { stage: "clock sample", prefix: "SELECT clock_timestamp()" },
  { stage: "restore", prefix: restoreSql },
  { stage: "rollback", prefix: "ROLLBACK" },
];
const stageCases = refusalStages.flatMap(stage => [true, false]
  .filter(hooked => hooked || stage.stage !== "hook settlement")
  .map(hooked => ({ ...stage, hooked })));

it.each(stageCases)("bounds $stage with prelock=$hooked", async ({ stage, prefix, table, hooked }) => {
  const owner = installation.owner;
  const input = scope(400);
  if (stage === "rollback") input.skuIds = []; // The price helper leaves the transaction failed.
  const read = vi.fn(async () => "unexpected");
  const resume = latch(), reached = latch(), settled = latch();
  const clients: PoolClient[] = [];
  const releases: [number, boolean][] = [];
  const trace: { index: number; text: string; request: string | (QueryConfig & { query_timeout?: number }); at: number }[] = [];
  const blocker = stage === "key" || table ? await owner.connect() : undefined;
  const release = (discard: unknown, db: PoolClient) => {
    const index = clients.indexOf(db);
    if (index >= 0) releases.push([index, Boolean(discard)]);
  };
  owner.on("release", release);
  let writerPid = 0;
  const target = (index: number, text: string) => index === Number(stage === "probe") && !!prefix && text.startsWith(prefix);
  const stall = async () => { reached.resolve(); await resume.wait(); };
  const pool = pair(async (index, db) => {
    clients[index] = db;
    if (index === 0) writerPid = await pid(db);
    if (index === 1 && stage === "reservation") {
      await stall();
      settled.resolve();
    }
    // This independent delay must also reduce the probe's allowance.
    if (index === 1 && stage === "probe") await delay(45);
    if (index === 1 && stage === "rollback") await delay(175);
  }, (index, text, request) => {
    trace.push({ index, text, request, at: performance.now() });
    if (target(index, text) && blocker) reached.resolve();
  }, owner, undefined, async (text, index) => {
    if (target(index, text) && !blocker) await stall();
  }, (text, index) => {
    if (target(index, text)) settled.resolve();
  });
  const options = hooked ? { prelock: vi.fn<Prelock>(async db => {
    if (stage === "hook settlement") {
      await stall();
      try { await expect(db.query(ledgerSql)).rejects.toBeDefined(); }
      finally { settled.resolve(); }
    }
  }) } : undefined;
  let result: Promise<unknown> | undefined;
  try {
    if (blocker) {
      await blocker.query("BEGIN");
      if (table) await blocker.query(`LOCK TABLE public.${table} IN ACCESS EXCLUSIVE MODE`);
      else await blocker.query(keySql, [input.key]);
    }
    const start = performance.now();
    result = withCatalogAdmissionFence(pool, input, read, options).catch(error => error);
    await reached.wait(result);
    if (blocker) await waitForBlock(writerPid, await pid(blocker), table ? "relation" : "advisory", table && `public.${table}`);
    expectFenceError(await result, { message: unavailable, hint: sameKey });
    if (stage === "rollback") expect(performance.now() - start).toBeLessThanOrEqual(input.timeoutMs + wallMarginMs);
    expect(releases).toEqual(stage === "reservation" ? [[0, false]] : [[0, true], [1, stage === "probe"]]);
    const refusedTrace = [...trace];
    resume.resolve();
    await settled.wait();
    await yieldTurn();
    const hits = trace.filter(({ index, text }) => target(index, text));
    expect(hits).toHaveLength(prefix ? 1 : 0);
    if (stage === "probe") {
      const hit = hits[0]!;
      const minRemainingProbe = input.timeoutMs - (hit.at - start);
      const { query_timeout: allowance } = hit.request as QueryConfig & { query_timeout: number };
      expect(allowance).toBeGreaterThanOrEqual(minRemainingProbe - 2);
      expect(allowance).toBeLessThanOrEqual(minRemainingProbe + 3);
      expect(allowance).toBeLessThanOrEqual(input.timeoutMs - 40);
    }
    if (stage === "rollback") {
      expect(hits[0]!.at - start).toBeGreaterThanOrEqual(150);
      expect(trace.at(-1)?.request).toBe("ROLLBACK");
      expect(trace.at(-2)?.text).toBe("SELECT public.catalog_admission_lock_checkout_price($1,$2)");
    }
    expect(options?.prelock.mock.calls.length ?? 0).toBe(Number(hooked && !["reservation", "nonce", "key"].includes(stage)));
    expect(trace.some(({ text }) => text.includes("pg_cancel_backend"))).toBe(false);

    for (const [offset, record] of trace.entries()) {
      if (record.index !== 0 || timeoutSettings.test(record.text) ||
        [captureSql, "BEGIN ISOLATION LEVEL REPEATABLE READ", "ROLLBACK"].includes(record.text)) continue;
      expect(record.request).toEqual({ text: record.text, values: expect.any(Array), queryMode: "extended" });
      const setting = trace[offset - 1]!;
      const [, lock, statement] = timeoutSettings.exec(setting.text) ?? [];
      expect(typeof setting.request).toBe("string");
      expect(setting.index).toBe(0);
      expect(Number(statement) - Number(lock)).toBe(wallMarginMs);
      const expectedMs = input.timeoutMs - (setting.at - start);
      expect(Number(lock)).toBeGreaterThanOrEqual(expectedMs - 2);
      expect(Number(lock)).toBeLessThanOrEqual(expectedMs + 3);
    }

    if (stage === "reservation") expect(releases).toEqual([[0, false], [1, false]]);

    if (stage === "key") {
      // Keep the blocker held until the expired backend has stopped waiting.
      const until = performance.now() + barrierTimeout;
      let waiting: unknown[];
      do {
        waiting = (await owner.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted", [writerPid])).rows;
        if (waiting.length) await yieldTurn();
      } while (waiting.length && performance.now() < until);
      expect(waiting).toEqual([]);
      await blocker!.query("ROLLBACK");
    }
    await transaction(orderingPool, async peer => {
      expect(await pid(peer)).not.toBe(writerPid);
      await peer.query(keySql, [input.key]);
    });
    expect(trace).toEqual(refusedTrace);
    expect(read).not.toHaveBeenCalled();
  } finally {
    resume.resolve();
    await blocker?.query("ROLLBACK").finally(() => blocker.release());
    await result;
    owner.removeListener("release", release);
  }
}, setupTimeout * 2);

it.each(["writer", "restore", "callback", "probe", "read", "COMMIT"] as const)("preserves serialization provenance at %s", async stage => {
  const failure = Object.assign(new Error("private serialization diagnostic"), { code: "40001", extra: "private" });
  const read = vi.fn(async () => { if (stage === "read") throw failure; });
  for (const hooked of stage === "callback" ? [true] : [true, false]) {
    const pool = pair(undefined, (index, sql) => {
      if ((stage === "writer" && sql === clientSql) || (stage === "restore" && sql === restoreSql) ||
        (stage === "probe" && index === 1) || (stage === "COMMIT" && sql === "COMMIT")) {
        throw failure;
      }
    });
    const error = await withCatalogAdmissionFence(pool, scope(), read, hooked ? { prelock: async () => {
      if (stage === "callback") throw failure;
    } } : undefined).catch(error => error);
    if (stage === "read" || stage === "COMMIT") expect(error).toBe(failure);
    else if (stage === "probe") expectFenceError(error, { message: unavailable, hint: checklist });
    else expectFenceError(error, { message: visibility, code: "40001", hint: sameKey });
  }
  expect(read).toHaveBeenCalledTimes(stage === "read" || stage === "COMMIT" ? 2 : 0);
});

it.each([false, true])("waits for a pending read before refusing on a standalone probe error with prelock=%s", async hooked => {
  const owner = installation.owner, clients: PoolClient[] = [];
  const atRead = latch(), resume = latch<string>();
  const trace: string[] = [];
  const pool = pair((index, db) => { clients[index] = db; }, (_, sql) => { trace.push(sql); });
  const release = vi.fn();
  owner.on("release", release);
  const result = withCatalogAdmissionFence(pool, scope(), () => {
    atRead.resolve();
    return resume.promise;
  }, hooked ? { prelock: guard } : undefined).catch(error => error);
  try {
    await atRead.wait(result);
    clients[1]!.emit("error", new Error("private probe connection diagnostic"));
    await yieldTurn();
    await yieldTurn();
    expect(release).not.toHaveBeenCalled();
    resume.resolve("read complete");
    expectFenceError(await result, { message: unavailable, hint: checklist });
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledWith(true, clients[0]);
    expect(release).toHaveBeenCalledWith(true, clients[1]);
  } finally {
    resume.resolve("read complete");
    await result;
    owner.removeListener("release", release);
  }
  await yieldTurn();
  expect(trace).not.toContain("COMMIT");
});

it.each([false, true])("preserves the active read query rejection after asynchronous cleanup with prelock=%s", async hooked => {
  const owner = installation.owner, clients: PoolClient[] = [], trace: string[] = [];
  const pool = pair((index, db) => { clients[index] = db; }, (_, sql) => { trace.push(sql); });
  const failure = Object.assign(new TypeError("connection lost during read"), { code: "ECONNRESET" });
  const keys = Reflect.ownKeys(failure);
  const release = vi.fn(), cleanup = vi.fn();
  let readResult: Promise<unknown> | undefined;
  owner.on("release", release);
  try {
    const error = await withCatalogAdmissionFence(pool, scope(), () => {
      const writer = clients[0]! as PoolClient & Client;
      // Fail the active driver query before it can consume a server response.
      const query = writer.query("SELECT 1");
      readResult = query.finally(async () => { await yieldTurn(); cleanup(); });
      writer.connection.emit("error", failure);
      return readResult;
    }, hooked ? { prelock: guard } : undefined).catch(error => error);
    expect(error).toBe(failure);
    expect(Object.getPrototypeOf(error)).toBe(TypeError.prototype);
    expect(Reflect.ownKeys(error)).toEqual(keys);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(trace).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledWith(true, clients[0]);
  } finally {
    await readResult?.catch(() => {});
    owner.removeListener("release", release);
  }
});

it.each([false, true])("refuses when the writer fails after read resolves with prelock=%s", async hooked => {
  const owner = installation.owner, clients: PoolClient[] = [], trace: string[] = [];
  const release = vi.fn();
  const pool = pair((index, db) => { clients[index] = db; }, (_, sql) => { trace.push(sql); });
  owner.on("release", release);
  try {
    const error = await withCatalogAdmissionFence(pool, scope(), () => new Promise<void>(resolve => {
      queueMicrotask(() => {
        resolve();
        clients[0]!.emit("error", new Error("private writer connection diagnostic"));
      });
    }), hooked ? { prelock: guard } : undefined).catch(error => error);
    expectFenceError(error, { message: unavailable, hint: checklist });
    expect(trace).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledWith(true, clients[0]);
  } finally {
    owner.removeListener("release", release);
  }
});

it.each([
  ["resolves", false], ["resolves", true], ["rejects", false], ["rejects", true],
] as const)("keeps a failed connection from committing when read %s with prelock=%s", async (settlement, hooked) => {
  const owner = installation.owner, clients: PoolClient[] = [], trace: string[] = [];
  const release = vi.fn();
  const pool = pair((index, db) => { clients[index] = db; }, (_, sql) => { trace.push(sql); });
  const failure = new Error("original read rejection");
  owner.on("release", release);
  try {
    const error = await withCatalogAdmissionFence(pool, scope(), async () => {
      clients[0]!.emit("error", new Error("private writer connection diagnostic"));
      await new Promise<void>(resolve => process.nextTick(resolve));
      if (settlement === "rejects") throw failure;
    }, hooked ? { prelock: guard } : undefined).catch(error => error);
    if (settlement === "rejects") expect(error).toBe(failure);
    else expectFenceError(error, { message: unavailable, hint: checklist });
    expect(trace).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledWith(true, clients[0]);
    expect(release).toHaveBeenCalledWith(true, clients[1]);
  } finally {
    owner.removeListener("release", release);
  }
});

it.each([false, true])("propagates the emitted COMMIT error and discards the writer with prelock=%s", async hooked => {
  const owner = installation.owner, clients: PoolClient[] = [];
  const failure = Object.assign(new Error("connection lost during COMMIT"), { code: "ECONNRESET" });
  const read = vi.fn(async () => "read complete");
  const release = vi.fn();
  owner.on("release", release);
  const pool = pair((index, db) => { clients[index] = db; }, (index, sql) => {
    if (sql === "COMMIT") {
      clients[index]!.emit("error", failure);
      throw failure;
    }
  });
  try {
    await expect(withCatalogAdmissionFence(pool, scope(), read, hooked ? { prelock: guard } : undefined)).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true, clients[0]);
  } finally {
    owner.removeListener("release", release);
  }
});

it("ends the fence budget at the synchronous read handoff", async () => {
  const input = scope(400), atRead = latch(), resume = latch();
  const read = vi.fn(async () => {
    atRead.resolve();
    await resume.wait();
    return "committed";
  });
  const result = withCatalogAdmissionFence(installation.owner, input, read);
  void result.catch(() => {});
  try {
    await atRead.wait(result);
    await delay(input.timeoutMs + wallMarginMs);
    resume.resolve();
    await expect(result).resolves.toBe("committed");
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    resume.resolve();
    await result.catch(() => {});
  }
});

it.each([0, 0.25])("uses the same deadline at a remainder of %s ms", async remainder => {
  const time = { now: 1000 };
  const clock = vi.spyOn(performance, "now").mockImplementation(() => time.now);
  const trace: string[] = [];
  const read = vi.fn(async () => "unexpected");
  const pool = { connect: async () => ({
    async query(sql: string) {
      trace.push(sql);
      if (sql === captureSql) return { rows: [{ lock_ms: 0, statement: "0" }] };
      if (sql.startsWith("BEGIN")) time.now = 2000 - remainder;
      if (timeoutSettings.test(sql)) time.now = 2000;
      return { rows: [] };
    },
    release: vi.fn(),
  } as unknown as PoolClient) };
  try {
    expectFenceError(await withCatalogAdmissionFence(pool, scope(1000), read).catch(error => error),
      { message: unavailable, hint: sameKey });
    expect(trace).toEqual([captureSql, lockTrace[0], ...(remainder ? ["SET LOCAL lock_timeout = 1; SET LOCAL statement_timeout = 51"] : [])]);
    expect(read).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

it("waits within the maximum budget before installing a representable server backstop", async () => {
  const ceiling = 2147483647;
  const now = performance.now.bind(performance);
  let beginAt: number | undefined;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => beginAt === undefined ? 1000 : 1000 + now() - beginAt);
  const settings = vi.fn<(sql: string) => void>();
  const pool = { connect: async () => ({
    async query(request: string | QueryConfig) {
      if (request === captureSql) return { rows: [{ lock_ms: 0, statement: "0" }] };
      if (request === lockTrace[0]) beginAt = now();
      else if (typeof request === "string" && timeoutSettings.test(request)) settings(request);
      else throw new Error("stop after the first guarded dispatch");
      return { rows: [] };
    },
    release: vi.fn(),
  } as unknown as PoolClient) };
  try {
    expectFenceError(await withCatalogAdmissionFence(pool, scope(ceiling), async () => "unexpected").catch(error => error),
      { message: unavailable, hint: checklist });
    expect(settings).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(timeoutSettings));
    const [, lock, statement] = timeoutSettings.exec(settings.mock.calls[0]![0])!;
    expect(Number(statement)).toBeLessThanOrEqual(ceiling);
    expect(Number(statement) - Number(lock)).toBe(wallMarginMs);
    expect(now() - beginAt!).toBeGreaterThanOrEqual(wallMarginMs);
  } finally {
    clock.mockRestore();
  }
});

it("a commit while the hook waits on an unchanged guard causes the visibility refusal", async () => {
  const owner = installation.owner;
  const holder = await owner.connect(), started = latch();
  const read = vi.fn(async () => "unexpected");
  let writerPid = 0;
  let attempt: Promise<unknown> | undefined;
  try {
    await holder.query("BEGIN");
    const holderPid = await pid(holder);
    await holder.query(orderSql, [orderId]);
    await holder.query("INSERT INTO public.clients(email) VALUES('snapshot-change@example.invalid')");
    const pool = pair(async (index, db) => { if (index === 0) writerPid = await pid(db); });
    attempt = withCatalogAdmissionFence(pool, scope(), read, { prelock: async db => {
      started.resolve();
      await guard(db);
      await db.query(orderSql, [orderId]);
    } });
    void attempt.catch(() => {});
    await started.wait(attempt);
    await waitForBlock(writerPid, holderPid, "transactionid");
    await holder.query("COMMIT");
    await expect(attempt).rejects.toMatchObject({ message: visibility, code: "40001" });
    expect(read).not.toHaveBeenCalled();
  } finally {
    await holder.query("ROLLBACK").finally(() => holder.release());
    await attempt?.catch(() => {});
  }
});

it("destroys the idle writer, releases the probe and fences late use while the first callback waits", async () => {
  const owner = installation.owner;
  const release = vi.fn();
  owner.on("release", release);
  const finish = latch(), late = latch();
  const read = vi.fn(async () => "unexpected");
  const input = scope(650), clients: PoolClient[] = [];
  let writerPid = 0, pending = false;
  const pool = pair(async (index, db) => {
    clients[index] = db;
    if (index === 0) writerPid = await pid(db);
  });
  try {
    await expect(withCatalogAdmissionFence(pool, input, read, { prelock: async db => {
      await guard(db);
      pending = true;
      await finish.wait();
      pending = false;
      await expect(db.query(ledgerSql)).rejects.toThrow();
      late.resolve();
    } })).rejects.toMatchObject({ message: unavailable, hint: sameKey });
    expect(read).not.toHaveBeenCalled();
    expect(pending).toBe(true);
    expect(release.mock.calls).toEqual([[true, clients[0]], [false, clients[1]]]);
    const retryPid = await withCatalogAdmissionFence(owner, { ...input, timeoutMs: setupTimeout }, async db => {
      const { rows } = await db.query(`SELECT pg_backend_pid() AS pid FROM pg_locks
        WHERE pid=pg_backend_pid() AND locktype='advisory' AND mode='ExclusiveLock' AND granted AND objsubid=1
          AND classid::bigint=(hashtextextended($1,0)>>32)&4294967295
          AND objid::bigint=hashtextextended($1,0)&4294967295`, [input.key]);
      expect(rows).toHaveLength(1);
      return Number(rows[0]?.pid);
    }, { prelock: guard });
    expect(retryPid).not.toBe(writerPid);
    expect(pending).toBe(true);
  } finally {
    owner.removeListener("release", release);
    finish.resolve();
  }
  await late.wait();
});

it("gives a real 55P03 the same-key retry while its blocker and callback remain pending", async () => {
  const owner = installation.owner;
  const stricter = new Pool({ ...owner.options, options: "-c lock_timeout=350ms" });
  const holder = await owner.connect(), finish = latch(), blocked = latch(), pgError = latch();
  const input = scope(1200);
  let writerPid = 0;
  let lockFailure: unknown;
  let attempt: Promise<unknown> | undefined;
  try {
    await holder.query("BEGIN");
    const holderPid = await pid(holder);
    await holder.query(ownerSql, [clientId]);
    const pool = pair(async (index, db) => { if (index === 0) writerPid = await pid(db); }, undefined, stricter, error => {
      lockFailure = error;
      pgError.resolve();
    });
    const start = performance.now();
    attempt = withCatalogAdmissionFence(pool, { ...input, clientId: randomUUID() }, async () => "unexpected", { prelock: async db => {
      for (let n = 0; n < 6; n++) {
        await db.query("SELECT pg_advisory_xact_lock(1917, $1)", [n]);
        while (performance.now() < start + 100 * (n + 1)) await yieldTurn();
      }
      blocked.resolve();
      await db.query(clientSql, [clientId]).catch(() => {});
      await finish.wait();
    } });
    void attempt.catch(() => {});
    await blocked.wait(attempt);
    await waitForBlock(writerPid, holderPid, "transactionid");
    await expect(attempt).rejects.toMatchObject({ message: unavailable, hint: sameKey });
    await pgError.wait();
    expect(lockFailure).toMatchObject({ code: "55P03" });
    expect(await withCatalogAdmissionFence(owner, { ...input, clientId: randomUUID(), timeoutMs: setupTimeout },
      async () => "retried", { prelock: async db => { await db.query(ledgerSql); } })).toBe("retried");
    expect(performance.now() - start).toBeLessThan(input.timeoutMs + 400);
  } finally {
    finish.resolve();
    await holder.query("ROLLBACK").finally(() => holder.release());
    await attempt?.catch(() => {});
    await stricter.end();
  }
});

async function delayedWriterLink(latencyMs: number, onForward: () => void) {
  const address = new URL(installation.owner.options.connectionString!);
  const sockets = new Set<Socket>();
  let oneWayDelay = 0;
  const relay = createServer({ allowHalfOpen: true }, downstream => {
    const upstream = createConnection({ host: address.hostname, port: Number(address.port), allowHalfOpen: true });
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    }
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    function forward(from: Socket, to: Socket, onWrite?: () => void) {
      from.on("data", (bytes: Buffer) => {
        if (!oneWayDelay) { to.write(bytes); return; }
        setTimeout(() => {
          if (to.destroyed) return;
          onWrite?.();
          to.write(bytes);
        }, oneWayDelay).unref();
      });
      // Forward EOF behind the bytes already in transit when the fence discards the writer.
      from.on("end", () => { setTimeout(() => to.end(), oneWayDelay).unref(); });
    }
    forward(downstream, upstream, onForward);
    forward(upstream, downstream);
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const endpoint = relay.address();
  if (!endpoint || typeof endpoint === "string") throw new Error("Expected a TCP listener");
  const proxiedAddress = new URL(address);
  proxiedAddress.hostname = endpoint.address;
  proxiedAddress.port = String(endpoint.port);
  const pool = new Pool({ ...installation.owner.options, connectionString: proxiedAddress.href, max: 1 });
  return {
    pool,
    startDelay() { oneWayDelay = latencyMs; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([pool.end(), new Promise<void>((resolve, reject) =>
        relay.close(error => error ? reject(error) : resolve()))]);
    },
  };
}

it.each([
  { lane: "writer-only latency", writerDelay: 320 },
  { lane: "no injected latency", writerDelay: 0 },
])("releases the fence key with $lane while the blocker remains held", async ({ writerDelay }) => {
  const owner = installation.owner, holder = await owner.connect();
  const input = scope(800), finish = latch(), started = latch();
  const read = vi.fn(async () => "unexpected");
  let writerPid = 0, settingsSentAt = 0, writerRoundTrip = 0, lockSentAt = 0, lockForwardedAt = 0;
  let link: Awaited<ReturnType<typeof delayedWriterLink>> | undefined;
  let attempt: Promise<unknown> | undefined, retry: Promise<unknown> | undefined;
  const cancel = vi.spyOn(Client.prototype as unknown as { cancel(): void }, "cancel");
  const queries: string[] = [];
  try {
    await holder.query("BEGIN");
    const holderPid = await pid(holder);
    await holder.query(ownerSql, [clientId]);
    if (writerDelay) {
      link = await delayedWriterLink(writerDelay, () => {
        if (lockSentAt && !lockForwardedAt) lockForwardedAt = performance.now();
      });
    }
    let connections = 0;
    const pool = pair(async (index, db) => { if (index === 0) writerPid = await pid(db); },
      (index, sql) => {
        queries.push(sql);
        if (index !== 0) return;
        if (sql.startsWith("SET LOCAL lock_timeout")) settingsSentAt = performance.now();
        if (sql === clientSql) lockSentAt = performance.now();
      }, { connect: () => (connections++ === 0 && link ? link.pool : owner).connect() }, undefined, sql => {
        if (sql.startsWith("SET LOCAL lock_timeout")) writerRoundTrip = performance.now() - settingsSentAt;
      });
    const start = performance.now();
    attempt = withCatalogAdmissionFence(pool, input, read, { prelock: async db => {
      link?.startDelay();
      started.resolve();
      try { await db.query(clientSql, [clientId]); } finally { await finish.wait(); }
    } });
    void attempt.catch(() => {});
    await started.wait(attempt);

    let acquiredAt = 0;
    retry = transaction(orderingPool, async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [input.key]);
      acquiredAt = performance.now();
      await delay(2 * wallMarginMs);
      return pid(db);
    });
    void retry.catch(() => {});
    const blocked = waitForBlock(writerPid, holderPid, "transactionid");
    void blocked.catch(() => {});
    expectFenceError(await attempt.catch(error => error), { message: unavailable, hint: sameKey });
    const expiredAt = performance.now();
    await blocked;
    const retryPid = await retry;
    expect(retryPid).not.toBe(writerPid);
    if (writerDelay) {
      expect(writerRoundTrip).toBeGreaterThanOrEqual(2 * writerDelay - 2);
      expect(lockSentAt - start).toBeLessThan(input.timeoutMs);
      expect(expiredAt - start).toBeGreaterThanOrEqual(input.timeoutMs);
      expect(lockForwardedAt).toBeGreaterThan(expiredAt);
    }
    expect(acquiredAt - start).toBeLessThanOrEqual(input.timeoutMs + wallMarginMs + (writerDelay ? 2 * writerRoundTrip : 0));
    expect(read).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(queries.some(sql => sql.includes("pg_cancel_backend"))).toBe(false);
  } finally {
    cancel.mockRestore();
    finish.resolve();
    await holder.query("ROLLBACK").finally(() => holder.release());
    await attempt?.catch(() => {});
    await retry?.catch(() => {});
    await link?.close();
  }
});

it("applies one wall budget to a stream of individually short lock queries", async () => {
  const input = scope(200), read = vi.fn(async () => "unexpected");
  await expect(withCatalogAdmissionFence(installation.owner, input, read, { prelock: async db => {
    for (let i = 0; ; i++) await db.query("SELECT pg_advisory_xact_lock(1918, $1)", [i]);
  } })).rejects.toMatchObject({ message: unavailable, hint: sameKey });
  expect(read).not.toHaveBeenCalled();
});

it.each(["before", "after"] as const)("uses the budget timer as provenance for a translated 57014 %s expiry", async when => {
  const input = scope(450), sent = latch();
  const sql = "SELECT pg_advisory_xact_lock(1917, 19)";
  const message = vi.fn(() => "Anweisung wegen Zeitüberschreitung abgebrochen");
  const translated = Object.defineProperty(Object.assign(new Error(), { code: "57014" }), "message", { get: message });
  let rejectStatement!: (reason: Error) => void;
  const pending = new Promise<never>((_, reject) => { rejectStatement = reject; });
  let index = 0;
  const release = vi.fn();
  const pool = { async connect() {
    const client = index++;
    return {
      async query(request: string | QueryConfig) {
        const text = typeof request === "string" ? request : request.text;
        if (text === sql) { sent.resolve(); return pending; }
        if (text.includes("pg_current_xact_id()")) return { rows: [{ xid: "3", pid: 1 }] };
        if (text.includes("current_setting('statement_timeout')")) return { rows: [{ statement: "0", lock_ms: 0 }] };
        return { rows: [] };
      },
      release(discard: boolean) { release(client, discard); },
    } as unknown as PoolClient;
  } };
  const result = withCatalogAdmissionFence(pool, input, async () => "unexpected", { prelock: async db => { await db.query(sql); } });
  void result.catch(() => {});
  try {
    await sent.wait(result);
    if (when === "before") rejectStatement(translated);
    expectFenceError(await result.catch(error => error), { message: unavailable, hint: when === "before" ? checklist : sameKey });
    expect(release.mock.calls).toEqual([[0, when === "after"], [1, false]]);
  } finally { rejectStatement(translated); }
  await yieldTurn();
  expect(message).not.toHaveBeenCalled();
});

it("runs an uncontended hook statement once with a settings round trip over the wall margin", async () => {
  const input = scope(1_500), settings: string[] = [];
  let statements = 0;
  const pool = pair(undefined, async (_, sql) => {
    if (sql.startsWith("SET LOCAL lock_timeout")) {
      settings.push(sql);
      await delay(wallMarginMs + 25);
    }
    if (sql === ledgerSql) statements++;
  });
  await expect(withCatalogAdmissionFence(pool, input, async () => "accepted", {
    prelock: async db => { await db.query(ledgerSql); },
  })).resolves.toBe("accepted");
  expect(statements).toBe(1);
  expect(settings).toHaveLength(12);
  const [, lock, statement] = timeoutSettings.exec(settings[2]!)!;
  expect(Number(statement) - Number(lock)).toBe(wallMarginMs);
  expect(Number(lock)).toBeLessThan(input.timeoutMs);
});

it("preserves the owner identity and strips the native 22023 diagnostic fields", async () => {
  const ownerRefusal = new Error("catalog_admission_price_context_required");
  const read = vi.fn(async () => "unexpected"), input = scope();
  const query: string[] = [];
  await expect(withCatalogAdmissionFence(pair(undefined, (_, text) => { query.push(text); }), input, read, {
    prelock: async db => { await guard(db); throw ownerRefusal; },
  })).rejects.toBe(ownerRefusal);
  expect(read).not.toHaveBeenCalled();
  expect(query.at(-1)).toBe("ROLLBACK");
  let native: unknown;
  const nativePool = pair(undefined, undefined, installation.owner, error => { native = error; });
  const sanitized = await withCatalogAdmissionFence(nativePool, { ...input, skuIds: [] }, read, { prelock: guard })
    .catch(error => error);
  expect(native).toMatchObject({ message: ownerRefusal.message, code: "22023" });
  expect(sanitized.message).toBe(ownerRefusal.message);
  expect(Object.getPrototypeOf(sanitized)).toBe(Object.getPrototypeOf(ownerRefusal));
  const ownKeys = (error: Error) => Reflect.ownKeys(error).filter(key => key !== "stack");
  expect(ownKeys(sanitized)).toEqual(ownKeys(ownerRefusal));
  expect(read).not.toHaveBeenCalled();
  await expect(withCatalogAdmissionFence(installation.owner, input, async () => "retried", { prelock: guard })).resolves.toBe("retried");
});

it("captures and restores the original settings while retaining a stricter lock limit", async () => {
  const settings = "SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock, current_setting('idle_in_transaction_session_timeout') AS idle";
  const trace: string[] = [];
  const isolated = new Pool({ ...installation.owner.options,
    options: "-c statement_timeout=19s -c lock_timeout=900ms -c idle_in_transaction_session_timeout=17s" });
  const pool = pair(undefined, (_, sql) => { trace.push(sql); }, isolated);
  try {
    await withCatalogAdmissionFence(pool, scope(), async db => {
      expect((await db.query(settings)).rows).toEqual([{ statement: "19s", lock: "900ms", idle: "17s" }]);
    }, { prelock: async db => {
      await guard(db);
      expect((await db.query(settings)).rows[0]).toMatchObject({ lock: "900ms", idle: "17s" });
      const { rows } = await db.query("SELECT setting::int AS ms FROM pg_settings WHERE name='statement_timeout'");
      expect(rows[0]?.ms).toBeGreaterThan(wallMarginMs);
      expect(rows[0]?.ms).toBeLessThanOrEqual(setupTimeout + wallMarginMs);
    } });
    expect(trace.findIndex(sql => sql.includes("current_setting"))).toBeLessThan(trace.findIndex(sql => sql.startsWith("SET LOCAL lock_timeout")));
  } finally { await isolated.end(); }
});

it.each([0, -1, 1.5, NaN, Infinity, -Infinity, 2147483648, "1000"])("refuses invalid timeout %s before reservation", async value => {
  for (const options of [undefined, { prelock: guard }]) {
    const connect = vi.fn(() => installation.owner.connect());
    await expect(withCatalogAdmissionFence({ connect }, scope(value as number), async () => {}, options))
      .rejects.toThrow(new TypeError("timeoutMs must be an integer from 1 to 2147483647"));
    expect(connect).not.toHaveBeenCalled();
  }
});

it.each([null, false, 17, {}])("refuses non-function prelock %s before examining the timeout", async value => {
  const connect = vi.fn(() => installation.owner.connect());
  const input = scope();
  const timeout = vi.fn(() => NaN);
  Object.defineProperty(input, "timeoutMs", { get: timeout });
  await expect(withCatalogAdmissionFence({ connect }, input, async () => {}, { prelock: value as Prelock }))
    .rejects.toThrow(new TypeError("prelock must be a function"));
  expect(timeout).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});

it.each([1, 2147483647])("accepts the inclusive timeout edge %s and starts both reservations", async value => {
  for (const options of [undefined, { prelock: guard }]) {
    const connect = vi.fn(() => Promise.reject(new Error("synthetic connection refusal")));
    await expect(withCatalogAdmissionFence({ connect }, scope(value), async () => {}, options))
      .rejects.toThrow(unavailable);
    expect(connect).toHaveBeenCalledTimes(2);
  }
});

it("uses the checklist for a real external query cancellation and strips the database error", async () => {
  const owner = installation.owner;
  const blocker = await owner.connect(), input = scope();
  let writerPid = 0;
  const starting = latch();
  let result: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN");
    const blockerPid = await pid(blocker);
    await blocker.query(ownerSql, [clientId]);
    const pool = pair(async (index, db) => {
      if (!index) writerPid = await pid(db);
    });
    result = withCatalogAdmissionFence(pool, input, async () => "unexpected", { prelock: async db => {
      starting.resolve();
      await guard(db);
    } });
    void result.catch(() => {});
    await starting.wait(result);
    await waitForBlock(writerPid, blockerPid, "transactionid");
    expect((await owner.query("SELECT pg_cancel_backend($1) AS cancelled", [writerPid])).rows[0]!.cancelled).toBe(true);
    const failure = await result.catch(error => error);
    expectFenceError(failure, { message: unavailable, hint: checklist });
  } finally {
    await blocker.query("ROLLBACK").finally(() => blocker.release());
    await result?.catch(() => {});
  }
});

it.each(["reservation", "probe"] as const)("sanitizes a %s connection failure with the checklist", async phase => {
  let probePid = 0;
  const read = vi.fn(async () => "unexpected");
  const owner = installation.owner;
  const pool = phase === "reservation"
    ? { connect: () => Promise.reject(Object.assign(new Error("private connection diagnostic"), { code: "ECONNRESET" })) }
    : pair(async (index, db) => { if (index === 1) probePid = await pid(db); }, async index => {
      if (index === 1) await owner.query("SELECT pg_terminate_backend($1,$2)", [probePid, 1000]);
    });
  const error = await withCatalogAdmissionFence(pool, scope(), read, { prelock: guard }).catch(failure => failure);
  expect(error).toMatchObject({ message: unavailable, hint: checklist });
  expect(Object.keys(error)).toEqual(["hint"]);
  expect(read).not.toHaveBeenCalled();
});

it("retains the private client event for classification and returns both connections after an idle writer dies", async () => {
  const owner = installation.owner;
  const started = latch(), finish = latch(), release = vi.fn();
  owner.on("release", release);
  let writerPid = 0;
  const input = scope();
  const first = withCatalogAdmissionFence(pair(async (index, db) => {
    if (index === 0) writerPid = await pid(db);
  }), input, async () => "unexpected", { prelock: async db => {
    await guard(db);
    started.resolve();
    await finish.wait();
  } });
  void first.catch(() => {});
  try {
    await started.wait(first);
    await owner.query("SELECT pg_terminate_backend($1,$2)", [writerPid, 1000]);
    const error = await first.catch(failure => failure);
    expect(error).toMatchObject({ message: unavailable, hint: checklist });
    expect(Object.keys(error)).toEqual(["hint"]);
    expect(release.mock.calls.filter(([, db]) => db).length).toBeGreaterThanOrEqual(2);
    expect(await withCatalogAdmissionFence(owner, input, async () => "retried", { prelock: guard })).toBe("retried");
  } finally {
    owner.removeListener("release", release);
    finish.resolve();
  }
});

it("refuses outstanding work with the checklist and closes the query handle", async () => {
  const owner = installation.owner;
  const read = vi.fn(async () => "unexpected"), input = scope();
  let query: Parameters<Prelock>[0]["query"] | undefined;
  await expect(withCatalogAdmissionFence(owner, input, read, { prelock: async db => {
    query = db.query;
    void db.query(ledgerSql);
  } })).rejects.toMatchObject({ message: unavailable, hint: checklist });
  await expect(query!(ledgerSql)).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
  expect(await withCatalogAdmissionFence(owner, input, async () => "retried", { prelock: guard })).toBe("retried");
});

it("sanitizes a lock-time serialization failure with the same-key remedy", async () => {
  const owner = installation.owner;
  const holder = await owner.connect(), starting = latch();
  let buyerPid = 0;
  let result: Promise<unknown> | undefined;
  try {
    await holder.query("BEGIN");
    const holderPid = await pid(holder);
    await holder.query("UPDATE public.commerce_orders SET updated_at=clock_timestamp() WHERE id=$1", [orderId]);
    result = withCatalogAdmissionFence(pair(async (index, db) => { if (index === 0) buyerPid = await pid(db); }),
      scope(), async () => "unexpected", { prelock: async db => {
        starting.resolve();
        await db.query(orderSql, [orderId]);
      } });
    void result.catch(() => {});
    await starting.wait(result);
    await waitForBlock(buyerPid, holderPid, "transactionid");
    await holder.query("COMMIT");
    const error = await result.catch(failure => failure);
    expect(error).toMatchObject({ code: "40001", message: visibility, hint: sameKey });
    expect(Object.keys(error as object).sort()).toEqual(["code", "hint"]);
  } finally {
    await holder.query("ROLLBACK").finally(() => holder.release());
    await result?.catch(() => {});
  }
});

it.each(["order guard", "list:sku advisory"] as const)("serializes two fences on the %s in each arrival order", async lane => {
  for (const sequence of [[0, 1], [1, 0]] as const) {
    const sameOrder: Prelock = async db => { await guard(db); await db.query(orderSql, [orderId]); };
    const actors = [scope(), scope()];
    const atRead = latch(), release = latch(), assigned = latch();
    const [first, second] = sequence;
    const firstRead = vi.fn(async () => { atRead.resolve(); await release.wait(); return first; });
    const secondRead = vi.fn(async () => second);
    const pids: number[] = [];
    const makePair = (index: number) => pair(async (offset, db) => {
      if (offset === 0) {
        pids[index] = await pid(db);
        if (index === second) assigned.resolve();
      }
    }, undefined, orderingPool);
    const options = { prelock: lane === "order guard" ? sameOrder : guard };
    const leader = withCatalogAdmissionFence(makePair(first), actors[first]!, firstRead, options);
    void leader.catch(() => {});
    let follower: Promise<number | Error> | undefined;
    try {
      await atRead.wait(leader);
      follower = withCatalogAdmissionFence(makePair(second), actors[second]!, secondRead, options).catch(error => error);
      await assigned.wait(follower);
      await waitForBlock(pids[second]!, pids[first]!, lane === "order guard" ? "transactionid" : "advisory");
      expect(secondRead).not.toHaveBeenCalled();
      release.resolve();
      expect(await leader).toBe(first);
      expect(await follower).toMatchObject({ message: visibility, code: "40001" });
      expect(secondRead).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await leader.catch(() => {});
      await follower;
    }
  }
}, setupTimeout * 3);

it("detects a reversed order cycle on incompatible owner and SKU row locks", async () => {
  const first = await orderingPool.connect(), reverse = await orderingPool.connect();
  const skuLock = "SELECT id FROM public.catalog_skus WHERE id=$1 FOR UPDATE";
  let held: Promise<unknown> | undefined;
  let inverted: Promise<unknown> | undefined;
  const result = (error: { code?: string }) => ({ code: error.code });
  try {
    const [firstPid, reversePid] = await Promise.all([pid(first), pid(reverse)]);
    const deadline = performance.now() + setupTimeout;
    async function dispatch(db: PoolClient, sql: string, key: string) {
      const ms = Math.ceil(deadline - performance.now());
      if (ms <= 0) throw new Error("Negative control used its order budget");
      await db.query(`SET LOCAL lock_timeout=${ms}; SET LOCAL statement_timeout=${ms + wallMarginMs}`);
      return db.query(sql, [key]);
    }
    await Promise.all([first.query("BEGIN"), reverse.query("BEGIN")]);
    await dispatch(first, orderSql, orderId);
    await dispatch(reverse, skuLock, skuId);
    held = dispatch(first, skuLock, skuId).then(() => ({}), result);
    await waitForBlock(firstPid, reversePid, "transactionid");
    inverted = dispatch(reverse, orderSql, orderId).then(() => ({}), result);
    const outcomes = await Promise.all([held, inverted]);
    expect(outcomes).toEqual(expect.arrayContaining([{ code: "40P01" }, {}]));
  } finally {
    await Promise.all([first.query("ROLLBACK"), reverse.query("ROLLBACK")]);
    first.release(); reverse.release();
    await Promise.all([held, inverted]);
  }
}, setupTimeout * 2);

const eraserSql = "LOCK TABLE public.identity_privacy_erasures IN SHARE ROW EXCLUSIVE MODE";
const ledgerTable = "public.identity_privacy_erasures";
const expireDestination = "SELECT public.commerce_destination_v2_expire(clock_timestamp(),1) AS expired";

it.each(["erasure", "B0 receipt", "B1 issue", "B1 expiry"] as const)("orders %s against the checkout hook in both directions", async otherLane => {
  const owner = installation.owner;
  for (const checkoutFirst of [true, false]) {
    const subject = await receiptClient(owner);
    const ctx = await destinationContext(owner, subject);
    const evidence = otherLane === "B1 expiry" ? await snapshot(owner, ctx) : undefined;
    if (evidence) await reachDestinationCutoff(owner, evidence.binding);
    const other = await orderingPool.connect();
    const stopCheckout = latch(), atRead = latch(), writerAssigned = latch();
    let buyerPid = 0;
    const read = vi.fn(async () => { atRead.resolve(); await stopCheckout.wait(); return "checkout committed"; });
    const checkout = () => withCatalogAdmissionFence(pair(async (index, db) => {
      if (index === 0) { buyerPid = await pid(db); writerAssigned.resolve(); }
    }, undefined, orderingPool), { ...scope(), clientId: subject }, read, { prelock: async db => {
      await db.query(ledgerSql);
      await db.query(clientSql, [subject]);
      if (evidence) {
        await db.query(`SELECT scope_ref FROM ${selectionTable} WHERE scope_ref=$1 FOR SHARE`, [ctx.scopeRef]);
        await db.query(`SELECT snapshot_ref FROM ${documentTable} WHERE snapshot_ref=$1 FOR SHARE`, [evidence.binding.snapshotRef]);
      }
    } });
    async function act() {
      if (otherLane === "B0 receipt") return receiptCall(other, "lock", receiptArgs(subject));
      if (otherLane === "B1 issue") return snapshot(other, ctx);
      if (otherLane === "B1 expiry") return other.query(expireDestination);
      await other.query(eraserSql);
      await other.query(ownerSql, [subject]);
    }
    let purchase: Promise<string> | undefined;
    let independent: Promise<unknown> | undefined;
    try {
      await other.query("BEGIN");
      const otherPid = await pid(other);
      if (checkoutFirst) {
        purchase = checkout();
        void purchase.catch(() => {});
        await atRead.wait(purchase);
        independent = act();
        void independent.catch(() => {});
        await waitForBlock(otherPid, buyerPid, otherLane === "erasure" ? "relation" : "transactionid",
          otherLane === "erasure" ? ledgerTable : undefined);
        stopCheckout.resolve();
        expect(await purchase).toBe("checkout committed");
        await independent;
        await other.query("COMMIT");
      } else {
        await act();
        purchase = checkout();
        void purchase.catch(() => {});
        await writerAssigned.wait(purchase);
        await waitForBlock(buyerPid, otherPid, otherLane === "erasure" ? "relation" : "transactionid",
          otherLane === "erasure" ? ledgerTable : undefined);
        await other.query("COMMIT");
        stopCheckout.resolve();
        await expect(purchase).rejects.toMatchObject({ code: "40001", message: visibility });
        expect(read).not.toHaveBeenCalled();
      }
    } finally {
      stopCheckout.resolve();
      await other.query("ROLLBACK").finally(() => other.release());
      await independent?.catch(() => {});
      await purchase?.catch(() => {});
    }
  }
}, setupTimeout * 3);

it("authenticates stored submit replay before checking an expired document and retired selection", async () => {
  const owner = installation.owner;
  const ctx = await destinationContext(owner), evidence = await snapshot(owner, ctx);
  const input = { ...scope(), clientId: ctx.clientId };
  await owner.query(`INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor,mode,valid_from)
    VALUES($1,$2,125,'one_time',clock_timestamp()-interval '1 hour')`, [priceListId, skuId]);
  const digest = "1".repeat(64), lane = "example-checkout";
  const amount = { amountMinor: 125, currency: "XXX" }, zero = { ...amount, amountMinor: 0 };
  const quoteSnapshot: CreateQuoteResponse = { contractVersion: "commerce.v0", quote: { currency: "XXX", taxIncluded: true,
    context: { mode: "one_time", promoCodes: [] }, lines: [{ sku: "PRELOCK", productSlug: "prelock-article", quantity: 1,
      unitPriceGross: amount, lineSubtotalGross: amount, tax: { included: true, country: "ZZ", category: "standard",
        vatRateBps: 0, netAmount: amount, vatAmount: zero, grossAmount: amount, legalBasis: "Example" } }],
    discounts: [], subtotalGross: amount, discountTotalGross: zero, totalGross: amount, netTotal: amount, taxTotal: zero } };
  const response = await transaction(installation.runtime, async db => {
    const outcome = await createPostgresNativeCheckoutPersistence(db).createOrderDraft({ idempotencyKey: input.key, quoteSnapshot }, { clientId: ctx.clientId });
    await db.query("SELECT public.catalog_admission_attach_legacy_submit($1,$2,$3)", [input.key, ctx.clientId, {
      schemaVersion: 1, ownerNamespace: "example:store", clientId: ctx.clientId, lane, requestKey: input.key,
      submitDigest: digest, acceptanceTokenDigest: null,
    }]);
    return outcome;
  });

  await reachDestinationCutoff(owner, evidence.binding);
  await owner.query(expireDestination);
  expect((await owner.query(`SELECT scope_ref FROM ${selectionTable} WHERE scope_ref=$1`, [ctx.scopeRef])).rows).toEqual([]);
  await expect(readSnapshot(owner, ctx, evidence.binding)).rejects.toMatchObject({ message: "destination_version_changed" });
  const checkFresh = vi.fn(async () => "fresh");
  const replay = (incoming: string) => withCatalogAdmissionFence(owner, input, async writer => {
    const { rows } = await writer.query("SELECT public.catalog_admission_replay_order_draft($1,$2,$3,$4) AS response",
      [input.key, ctx.clientId, lane, incoming]);
    return rows[0]?.response ?? checkFresh();
  }, { prelock: async writer => {
    await writer.query(ledgerSql);
    await writer.query(clientSql, [ctx.clientId]);
    await writer.query(`SELECT scope_ref FROM ${selectionTable} WHERE scope_ref=$1 FOR SHARE`, [ctx.scopeRef]);
    await writer.query(`SELECT snapshot_ref FROM ${documentTable} WHERE snapshot_ref=$1 FOR SHARE`, [evidence.binding.snapshotRef]);
  } });
  await expect(replay(digest)).resolves.toEqual({ ...response, orderDraft: { ...response.orderDraft, replayed: true } });
  await expect(replay("2".repeat(64))).rejects.toMatchObject({ message: "commerce_order_draft_idempotency_conflict" });
  expect(checkFresh).not.toHaveBeenCalled();
});

it.each([true, false])("orders real base price apply and checkout, checkout first=%s", async checkoutFirst => {
  const owner = installation.owner;
  const db = await orderingPool.connect(), atRead = latch(), finish = latch(), buyerAssigned = latch();
  const list = (await owner.query("INSERT INTO public.price_lists(name,region_code,currency) VALUES('Price apply','ZZ','XXX') RETURNING id")).rows[0]!.id;
  const input = { ...scope(), priceListId: list };
  const price = await db.query(`INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor,mode,valid_from)
    VALUES($1,$2,125,'one_time',clock_timestamp()-interval '1 hour') RETURNING id`, [list, skuId]);
  const command = { schemaVersion: 1, commandKey: randomUUID(), variantId: skuId, priceListId: list,
    mode: "one_time", minQty: 1, amountKind: "gross", unitPriceMinor: 130, expected: { entryId: price.rows[0]!.id, unitPriceMinor: 125 } };
  const handler = createCatalogPriceSetupHandler({ store: createPostgresCatalogPriceSetupStore(db),
    authorizeOperator: async () => ({ actorId }) });
  let writerPid = 0;
  const read = vi.fn(async () => { atRead.resolve(); await finish.wait(); return "checkout committed"; });
  const checkout = () => withCatalogAdmissionFence(pair(async (index, writer) => {
    if (index === 0) { writerPid = await pid(writer); buyerAssigned.resolve(); }
  }, undefined, orderingPool), input, read, { prelock: guard });
  let purchase: Promise<string> | undefined;
  let apply: ReturnType<typeof handler.apply> | undefined;
  try {
    const pricePid = await pid(db);
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actorId, role: "authenticated" })]);
    if (checkoutFirst) {
      purchase = checkout();
      void purchase.catch(() => {});
      await atRead.wait(purchase);
      apply = handler.apply(command, null);
      await waitForBlock(pricePid, writerPid, "advisory");
      finish.resolve();
      expect(await purchase).toBe("checkout committed");
      expect(await apply).toMatchObject({ outcome: "committed" });
      await db.query("COMMIT");
    } else {
      expect(await handler.apply(command, null)).toMatchObject({ outcome: "committed" });
      purchase = checkout();
      void purchase.catch(() => {});
      await buyerAssigned.wait(purchase);
      await waitForBlock(writerPid, pricePid, "advisory");
      await db.query("COMMIT");
      finish.resolve();
      await expect(purchase).rejects.toMatchObject({ code: "40001", message: visibility });
      expect(read).not.toHaveBeenCalled();
    }
    expect((await owner.query("SELECT unit_price_minor FROM public.price_entries WHERE price_list_id=$1 AND active", [list])).rows)
      .toEqual([{ unit_price_minor: 130 }]);
  } finally {
    finish.resolve();
    await db.query("ROLLBACK").finally(() => db.release());
    await apply;
    await purchase?.catch(() => {});
  }
}, setupTimeout * 2);

const typeKey = "example:prelock-article";
const publicationRules = createCatalogProductTypeRegistry(withCatalogPublicationRules({
  id: "example:prelock-rules", namespace: "example", version: 1, openlupRange: "1.x", capabilities: {}, taxClasses: [],
  types: [{ key: typeKey, version: 1, units: [{ code: "openlup:g", dimension: "mass", integral: false }], netContentUnits: ["openlup:g"],
    dimensions: [{ key: "finish", kind: "choice", values: ["matte"] }],
    axes: [{ key: "finish", attributeKey: "finish" }],
    attributes: [{ key: "finish", scope: "variant", valueType: { kind: "enum", values: [{ id: "matte" }] },
      required: false, cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} }] }],
}, () => Buffer.from(`
  const wire = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)));
  module.exports = {
    validateContent: () => [], validateProduct: () => [],
    identifyDocument: ({ schemaVersion, id, productSlug, revisionNo, name }) =>
      ({ schemaId: "example:document.v" + schemaVersion, documentRef: id, productSlug, revisionNo, name }),
    inspectDocument(text) { return { ...this.identifyDocument(JSON.parse(text)), canonicallyEncoded: wire(JSON.parse(text)) === text }; },
    matchesDocument: (document, text) => wire(document) === text,
    deriveSkuFacts: () => ({ derived: 12 }), classifySkuChange: () => "compatible",
  };
`)).types);
const definition = publicationRules.resolve({ key: typeKey, version: 1 })!;
const productTable = "public.catalog_products";

function publisher(afterRelation: (db: PoolClient) => Promise<void> = async () => {}) {
  return createPostgresCatalogPublicationCommands({
    authorizeHuman: async (userId: string) => ({ ok: true, userId, role: "admin", isMachineActor: false }),
    registry: publicationRules,
    catalogPublicationOwner: { run: work => transaction(orderingPool, db => work({ async query(sql, args) {
      const result = await db.query(sql, args);
      if (sql.startsWith("LOCK TABLE public.catalog_products")) await afterRelation(db);
      return result;
    } })) },
  });
}

async function approvedPublication(checkoutFirst: boolean) {
  const owner = installation.owner, api = publisher(), who = (await api.authorize(actorId))!;
  await owner.query(`INSERT INTO public.catalog_type_versions(type_key,version,definition,definition_digest,validator_ref)
    VALUES($1,1,'{}',$2,$3) ON CONFLICT DO NOTHING`, [typeKey, catalogDefinitionDigest(definition), definition.validatorRef]);
  const id = randomUUID(), variantId = randomUUID(), draftId = randomUUID(), documentId = randomUUID();
  const slug = `prelock-${id.slice(0, 8)}`, code = slug.toUpperCase();
  const doc = authoredPublicationDocument(slug);
  const canonicalText = canonicalCatalogDraftJson(doc), digest = hash(canonicalText);
  const reference = { id: documentId, productId: id, revisionNo: 1, schemaId: "example:document.v1", sourceRef: "example:source",
    documentRef: doc.id, digest };
  const sku = { skuCode: code, title: doc.name, minQuantity: 1, isAddon: false, facts: { derived: 12 } };
  const identifier = { scheme: "gs1:gtin", issuer: "example", value: checkoutFirst ? "4006381333931" : "5901234123457",
    packagingLevel: "unit" as const };
  const payload: CatalogDraftPayloadV3 = { schemaVersion: 3,
    product: { id, type: { key: typeKey, version: 1 }, dimensions: ["finish"], slug, primarySkuId: variantId, documentRevision: reference,
      sharedContent: { schemaVersion: 1, catalogAction: "create", document: doc, presentation: {}, publicationSkus: [sku],
        requestedModes: [{ skuCode: code, modes: [] }], offerMemberships: [] } },
    skus: [{ id: variantId, productId: id, code, options: { finish: { kind: "choice", value: "matte" } }, identifiers: [identifier],
      netContent: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 } }],
    publication: { kind: "release", evidence: {}, operations: [
      { op: "create_product", productId: id, productSlug: slug, name: doc.name },
      { op: "register_document_revision", productSlug: slug, revisionId: documentId, revisionNo: 1, documentRef: reference.documentRef,
        sourceRef: reference.sourceRef, canonicalText, digest, provenance: { source: "current_draft" } },
      { op: "move_document_pointer", productSlug: slug, documentRevisionNo: 1 },
      { op: "create_sku", productSlug: slug, documentRevisionNo: 1, skuId: variantId, ...sku },
      { op: "create_identifier", skuCode: code, ...identifier, quantity: 1, isPrimary: true, label: null, sourceRef: null },
      { op: "set_primary_sku", productSlug: slug, skuCode: code },
      { op: "set_product_presentation", productSlug: slug, presentation: {} },
    ] },
  };
  async function approve(draftRevision: number, expectedHead: import("@openlup/platform/catalog/contracts").CatalogHeadRef | null) {
    const canonicalCommand = canonicalCatalogDraftJson({ schemaVersion: 3, action: draftRevision === 1 ? "create" : "revise",
      draftId, commandKey: randomUUID(), expectedRevision: draftRevision - 1, payload });
    expect(await createPostgresCatalogDraftStoreV4(owner).apply({ canonicalCommand, fingerprint: hash(canonicalCommand), actorId }))
      .toHaveProperty("record");
    const candidate = await api.prepareCandidate({ draftId, draftRevision, expectedHead }, who);
    if (!("candidateRef" in candidate) || !candidate.preparation?.postStateDigest) {
      throw new Error(`Publication fixture was not ready: ${JSON.stringify(candidate)}`);
    }
    const common = { productId: id, candidateRef: candidate.candidateRef, candidateDigest: candidate.candidateDigest };
    expect(await api.execute({ ...common, action: "approve", commandKey: randomUUID(), reason: null,
      postStateDigest: candidate.preparation.postStateDigest }, who)).toMatchObject({ outcome: "committed" });
    return { ...common, action: "publish" as const, expectedHead, changes: [], commandKey: randomUUID() };
  }
  const issued = await api.execute(await approve(1, null), who);
  if (!("receipt" in issued) || !("head" in issued.receipt)) throw new Error(`Publication fixture failed: ${JSON.stringify(issued)}`);
  payload.product.sharedContent.catalogAction = "revise";
  payload.product.sharedContent.presentation = { routePath: { en: `/${slug}` } };
  payload.publication.operations = [{ op: "set_product_presentation", productSlug: slug,
    presentation: payload.product.sharedContent.presentation }];
  return { variantId, command: await approve(2, issued.receipt.head) };
}

it.each([true, false])("orders the real Stage B publisher and checkout, checkout first=%s", async checkoutFirst => {
  const { variantId, command } = await approvedPublication(checkoutFirst);
  const buyerAssigned = latch(), releasePublication = latch(), relationHeld = latch();
  let writerPid = 0, publisherPid = 0;
  const pool = pair(async (index, db) => { if (index === 0) { writerPid = await pid(db); buyerAssigned.resolve(); } }, undefined, orderingPool);
  const api = publisher(async db => { publisherPid = await pid(db); relationHeld.resolve(); await releasePublication.wait(); });
  const who = (await api.authorize(actorId))!;
  const input = { ...scope(), skuIds: [variantId] };
  async function grantedShare() {
    const result = await installation.owner.query(`SELECT 1 FROM pg_locks
      WHERE pid=$1 AND relation=$2::regclass AND granted AND mode='ShareLock'`, [writerPid, productTable]);
    expect(result.rows).toHaveLength(1);
  }
  let publish: ReturnType<typeof api.execute> | undefined;
  let purchase: Promise<unknown> | undefined;
  try {
    if (checkoutFirst) {
      await withCatalogAdmissionFence(pool, input, async () => {
        await grantedShare();
        expect(await api.execute(command, who)).toMatchObject({ outcome: "conflict", reason: "publication_busy" });
      }, { prelock: guard });
    } else {
      publish = api.execute(command, who);
      await relationHeld.wait(publish);
      expect(publisherPid).toBeGreaterThan(0);
      const write = vi.fn(async () => "unexpected");
      purchase = withCatalogAdmissionFence(pool, input, write, { prelock: guard });
      void purchase.catch(() => {});
      await buyerAssigned.wait(purchase);
      await waitForBlock(writerPid, publisherPid, "relation", productTable);
      releasePublication.resolve();
      expect(await publish).toMatchObject({ outcome: "committed" });
      await expect(purchase).rejects.toMatchObject({ code: "40001", message: visibility });
      expect(write).not.toHaveBeenCalled();
      expect((await installation.owner.query("SELECT order_id FROM public.commerce_order_draft_receipts WHERE idempotency_key=$1",
        [input.key])).rows).toEqual([]);
    }
  } finally {
    releasePublication.resolve();
    await publish;
    await purchase?.catch(() => {});
  }
}, setupTimeout * 2);
