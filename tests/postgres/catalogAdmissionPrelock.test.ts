import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { setImmediate as yieldTurn, setTimeout as delay } from "node:timers/promises";
import { Client, Pool, type PoolClient, type QueryConfig, type QueryResult } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { catalogDefinitionDigest, createCatalogProductTypeRegistry, createPostgresCatalogDraftStoreV4,
  createPostgresCatalogPublicationCommands, withCatalogPublicationRules } from "@openlup/platform/catalog";
import { canonicalCatalogDraftJson, type CatalogDraftPayloadV3 } from "@openlup/platform/catalog/contracts";
import { withCatalogAdmissionFence } from "@openlup/platform/catalog/testing";
// eslint-disable-next-line no-restricted-imports -- exercise the selected fence without exposing an installed entry point
import { withSelectedCatalogAdmissionFence } from "../../packages/platform/src/catalog/catalogAdmissionFence.js";
import { createPostgresNativeCheckoutPersistence } from "@openlup/platform/commerce/server/native-checkout";
import { createCatalogPriceSetupHandler, createPostgresCatalogPriceSetupStore, type CreateQuoteResponse } from "@openlup/platform/pricing";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { actorId, authoredPublicationDocument, fixture, graph, hash, insertGraph, installPublicationActors, transaction } from "./catalogPublicationFixture.js";
import { destinationContext, documentTable, readSnapshot, reachDestinationCutoff, selectionTable, snapshot } from "./destinationDocumentFixture.js";
import { markReceiptClientErased, receiptArgs, receiptCall, receiptClient } from "./destinationReceiptFixture.js";
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
type ObservedQuery = string | (QueryConfig & { query_timeout?: number });
type QueryObserver = (index: number, text: string, request: ObservedQuery, values?: unknown[]) => Promise<void> | void;
function pair(observeClient: ClientObserver = () => {}, observeQuery: QueryObserver = () => {},
  pool: { connect(): Promise<PoolClient> } = installation.owner, observeError?: (error: unknown) => void,
  observeResult?: (text: string, index: number, result: QueryResult) => Promise<void> | void,
  observeSettlement?: (text: string, index: number) => void) {
  let index = 0;
  return { async connect() {
    const number = index++;
    const db = await pool.connect();
    try { await observeClient(number, db); } catch (error) { db.release(true); throw error; }
    return {
      query: async (request: ObservedQuery, values?: unknown[]) => {
        const text = typeof request === "string" ? request : request.text;
        await observeQuery(number, text, request, values);
        try {
          const result = await (typeof request === "string" ? db.query(request, values) : db.query(request));
          await observeResult?.(text, number, result);
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
      // hit.at is recorded after withCatalogAdmissionFence computes remaining(), so CI event-loop jitter can shift hit.at later.
      expect(allowance).toBeLessThanOrEqual(Math.min(input.timeoutMs, minRemainingProbe + 25));
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
      // setting.at is recorded after withCatalogAdmissionFence computes remaining(), so CI event-loop jitter can shift setting.at later.
      expect(Number(lock)).toBeLessThanOrEqual(Math.min(input.timeoutMs, expectedMs + 25));
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
    expect(Reflect.ownKeys(error as object)).toEqual(keys);
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
  await expect(readSnapshot(owner, ctx, evidence.binding)).resolves.toMatchObject({ code: "destination_version_changed" });
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

it.each([true, false].flatMap(checkoutFirst => [true, false].map(selected => ({ checkoutFirst, selected }))))(
  "orders real base price apply and checkout, checkout first=$checkoutFirst selected=$selected", async ({ checkoutFirst, selected }) => {
  const owner = installation.owner;
  const selection = selected ? await selectedFixture() : undefined;
  const db = await orderingPool.connect(), atRead = latch(), finish = latch(), buyerAssigned = latch();
  const list = selection?.guards.priceListId ??
    (await owner.query("INSERT INTO public.price_lists(name,region_code,currency) VALUES('Price apply','ZZ','XXX') RETURNING id")).rows[0]!.id;
  const variantId = selection?.guards.skuIds[1] ?? skuId;
  const input = { ...scope(), priceListId: list };
  const price = await db.query(`INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor,mode,valid_from)
    VALUES($1,$2,125,'one_time',clock_timestamp()-interval '1 hour') RETURNING id`, [list, variantId]);
  const command = { schemaVersion: 1, commandKey: randomUUID(), variantId, priceListId: list,
    mode: "one_time", minQty: 1, amountKind: "gross", unitPriceMinor: 130, expected: { entryId: price.rows[0]!.id, unitPriceMinor: 125 } };
  const handler = createCatalogPriceSetupHandler({ store: createPostgresCatalogPriceSetupStore(db),
    authorizeOperator: async () => ({ actorId }) });
  let writerPid = 0;
  const read = vi.fn(async () => { atRead.resolve(); await finish.wait(); return "checkout committed"; });
  const pool = pair(async (index, writer) => {
    if (index === 0) { writerPid = await pid(writer); buyerAssigned.resolve(); }
  }, undefined, selected ? installation.runtime : orderingPool);
  const checkout = () => selection ? withSelectedCatalogAdmissionFence(pool, selection.request, selection.guards, read, noAuthorizationRefusal)
    : withCatalogAdmissionFence(pool, input, read, { prelock: guard });
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
    // COMMIT was acknowledged on the price writer before this fresh owner read.
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

async function approvedPublication(checkoutFirst: boolean, gtin?: string) {
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
  const identifier = { scheme: "gs1:gtin", issuer: "example", value: gtin ?? (checkoutFirst ? "4006381333931" : "5901234123457"),
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

const selectedSql = "SELECT public.catalog_admission_runtime_checkout($1::text,$2::text,$3::uuid,$4::jsonb) AS result";
const dark = { code: "55000", message: "catalog_admission_quote_authority_required",
  hint: "Governed checkout is unavailable for this selection. Use a supported offer or replay the original request." };
const noAuthorizationRefusal = () => {};
const orderInsert = `INSERT INTO public.commerce_orders(client_id,status,currency_code,total_amount_minor)
  SELECT $1,'pending_payment','XXX',0 FROM generate_series(1,$2) RETURNING id`;

async function observeBefore(check: () => Promise<boolean>, deadline: number) {
  await expect.poll(async () => await check() && performance.now() <= deadline,
    { timeout: Math.max(1, deadline - performance.now()), interval: 2 }).toBe(true);
}

function trackedSelectedWriter(observeQuery?: QueryObserver, onWriter?: (db: PoolClient) => Promise<void> | void) {
  let backend: number | undefined, xid: string | undefined;
  const pool = pair(async (index, db) => {
    if (index === 0) {
      backend = await pid(db);
      await onWriter?.(db);
    }
  }, observeQuery, installation.runtime, undefined, (sql, index, { rows }) => {
    if (index !== 0 || !sql.startsWith("SELECT pg_current_xact_id()")) return;
    const value: unknown = rows[0]?.xid;
    if (typeof value === "string") xid = value;
  });
  return { pool, get pid() { return backend; }, waitUntil: (deadline: number) => observeBefore(async () => {
    // The backend check also covers a nonce sent before the deadline without a returned XID.
    const { rows: [result] } = await installation.owner.query<{ settled: boolean }>(`SELECT
      NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND state IS DISTINCT FROM 'idle')
      AND COALESCE(pg_visible_in_snapshot($2::xid8, pg_current_snapshot()), true) AS settled`,
    [backend ?? null, xid ?? null]);
    return result?.settled === true;
  }, deadline) };
}

async function selectedFixture() {
  const seed = fixture();
  const skuRevisionId = await transaction(installation.owner, async db => {
    const issue = await graph(db, seed, null, true, { lifecycle: "active", subscriptionEligible: true });
    issue.facts.memberships = [{ offerVersion: "example:subscription", admitted: true }];
    await insertGraph(db, issue);
    return issue.skuRevisionId;
  });
  const legacy = randomUUID();
  const owner = installation.owner;
  await owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Example')", [legacy, legacy]);
  await owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription) VALUES($1,$1,$2,'Example',true)", [legacy, legacy]);
  const { rows: [list] } = await owner.query("INSERT INTO public.price_lists(name,region_code,currency) VALUES($1,'ZZ','XXX') RETURNING id", [legacy]);
  const { rows: [client] } = await owner.query("INSERT INTO public.clients(email) VALUES($1) RETURNING id", [`${legacy}@example.invalid`]);
  return { request: { key: randomUUID(), clientId: String(client!.id), timeoutMs: setupTimeout },
    guards: { skuIds: [seed.skuId, legacy] as const, skuRevisionId, priceListId: String(list!.id) }, productId: seed.productId, emailLocalPart: legacy };
}

async function selectedRaw<T>(work: (db: PoolClient) => Promise<T>, begin = "BEGIN ISOLATION LEVEL REPEATABLE READ") {
  const db = await installation.runtime.connect();
  try {
    await db.query(begin);
    await db.query("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='3s'");
    return await work(db);
  } finally { await db.query("ROLLBACK"); db.release(); }
}

it("checks exact selected input, transaction and advisory layout before fresh locks", async () => {
  const { request, guards } = await selectedFixture();
  const input = ["prelock", request.key, request.clientId, guards];
  const peer = await installation.owner.connect();
  try {
    await peer.query("BEGIN");
    await peer.query(keySql, [request.key]);
    await selectedRaw(db => expect(db.query(selectedSql, input)).rejects.toMatchObject(dark));
    await peer.query("ROLLBACK");
  } finally { peer.release(); }

  for (const lock of [undefined, "SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text,0))",
    `SELECT pg_advisory_xact_lock((h>>32)::int4,(h<<32>>32)::int4) FROM hashtextextended($1::text,0) h`]) {
    await selectedRaw(async db => {
      if (lock) await db.query(lock, [request.key]);
      await expect(db.query(selectedSql, input)).rejects.toMatchObject(dark);
    });
  }
  for (const begin of ["BEGIN", "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "BEGIN ISOLATION LEVEL SERIALIZABLE"]) {
    await selectedRaw(async db => {
      await db.query(keySql, [request.key]);
      await expect(db.query(selectedSql, input)).rejects.toMatchObject(dark);
    }, begin);
  }
  await selectedRaw(async db => {
    await db.query(keySql, ["unrelated-key"]);
    await expect(db.query(selectedSql, input)).rejects.toMatchObject(dark);
  });
  for (const timeout of ["lock_timeout", "statement_timeout"]) {
    await selectedRaw(async db => {
      await db.query(keySql, [request.key]);
      await db.query("SELECT set_config($1,'0',true)", [timeout]);
      await expect(db.query(selectedSql, input)).rejects.toMatchObject(dark);
    });
  }

  await selectedRaw(async db => {
    await db.query(keySql, [request.key]);
    const cases = [
      ["write", request.key, request.clientId, guards], ["PRELOCK", ...input.slice(1)], ["prelock ", ...input.slice(1)], [null, ...input.slice(1)],
      ...[null, "1234567", "x".repeat(121), "with space", "newline\n", "key-é-ascii"].map(key => ["prelock", key, request.clientId, guards]),
      ["prelock", request.key, null, guards],
      ...[null, [], {}, { ...guards, extra: true }, { ...guards, skuIds: null },
        { ...guards, skuIds: [guards.skuIds[0]] }, { ...guards, skuIds: [...guards.skuIds, randomUUID()] },
        { ...guards, skuIds: [guards.skuIds[0], guards.skuIds[0]] }, { ...guards, skuIds: [null, guards.skuIds[1]] },
        { ...guards, skuRevisionId: guards.skuRevisionId.toUpperCase() }, { ...guards, priceListId: 123 },
        ...Object.keys(guards).flatMap(key => [{ ...guards, [key]: undefined }, { ...guards, [key]: null }]),
      ].map(payload => ["prelock", request.key, request.clientId, JSON.stringify(payload)]),
    ];
    for (const values of cases) {
      await db.query("SAVEPOINT invalid_selected");
      await expect(db.query(selectedSql, values)).rejects.toMatchObject(dark);
      await db.query("ROLLBACK TO SAVEPOINT invalid_selected");
      await db.query("RELEASE SAVEPOINT invalid_selected");
    }
    // Acknowledged savepoint rollbacks complete on this same backend before the lock read.
    expect((await db.query(`SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid()
      AND relation IN ('public.clients'::regclass,'public.catalog_products'::regclass,'public.commerce_orders'::regclass)`)).rows).toEqual([]);
    await db.query("SET LOCAL search_path=pg_temp,public,pg_catalog");
    await db.query("CREATE TEMP TABLE clients(id uuid) ON COMMIT DROP");
    await db.query("CREATE TEMP TABLE catalog_skus(id uuid) ON COMMIT DROP");
    expect((await db.query(selectedSql, input)).rows).toEqual([{ result: { kind: "locked" } }]);
  });
  await selectedRaw(db => expect(db.query(selectedSql, ["prelock", request.key, "invalid", guards])).rejects.toMatchObject({ code: "22P02" }));
});

it("observes the key gate before cleanup with the first guard held by a peer", async () => {
  const { request, guards } = await selectedFixture();
  const owner = installation.owner, peer = await owner.connect();
  const input = ["prelock", request.key, request.clientId, guards];
  const targets = ["identity_privacy_erasures", "clients", "commerce_orders", "catalog_skus", "catalog_sku_revisions", "catalog_products",
    "catalog_sku_identifiers", "catalog_product_document_revisions", "catalog_attribute_projection", "catalog_publication_heads",
    "catalog_publications", "catalog_operator_receipts", "catalog_publication_decisions", "catalog_publication_pointer_capabilities",
    "catalog_draft_heads", "catalog_draft_revisions", "catalog_draft_command_receipts", "price_lists", "price_entries", "subscription_price_policy_revisions"];
  try {
    await peer.query("BEGIN");
    await peer.query("LOCK TABLE public.identity_privacy_erasures IN ACCESS EXCLUSIVE MODE");
    await selectedRaw(async db => {
      const writerPid = await pid(db);
      await db.query("SAVEPOINT before_key_gate");
      await expect(db.query(selectedSql, input)).rejects.toMatchObject(dark);
      expect((await owner.query("SELECT state FROM pg_stat_activity WHERE pid=$1", [writerPid])).rows)
        .toEqual([{ state: "idle in transaction (aborted)" }]);
      expect((await owner.query(`SELECT l.locktype,c.relname FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
        WHERE l.pid=$1 AND l.locktype IN ('relation','tuple') AND c.relname=ANY($2::text[])`, [writerPid, targets])).rows).toEqual([]);
      await db.query("ROLLBACK TO SAVEPOINT before_key_gate");
    });
    // Calibrate against the same first guard above the key check. The
    // replacement is visible only to this transaction and is rolled back.
    const calibration = await owner.connect();
    try {
      await calibration.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await calibration.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='3s'");
      const { rows: [routine] } = await calibration.query<{ definition: string }>(`SELECT
        pg_get_functiondef('public.catalog_admission_runtime_checkout(text,text,uuid,jsonb)'::regprocedure) AS definition`);
      const ledger = "LOCK TABLE public.identity_privacy_erasures IN SHARE MODE;";
      const key = "v_key := pg_catalog.hashtextextended(p_key,0);";
      expect(routine!.definition).toContain(ledger);
      expect(routine!.definition).toContain(key);
      await calibration.query(routine!.definition.replace(ledger, "").replace(key, ledger + "\n    " + key));
      await calibration.query("SET LOCAL ROLE service_role");
      const writerPid = await pid(calibration), peerPid = await pid(peer);
      const dispatched = calibration.query(selectedSql, input).catch((error: unknown) => error);
      try { await waitForBlock(writerPid, peerPid, "relation", "public.identity_privacy_erasures"); }
      finally { expect(await dispatched).toMatchObject({ code: "55P03" }); }
    } finally { await calibration.query("ROLLBACK"); calibration.release(); }
  } finally { await peer.query("ROLLBACK"); peer.release(); }
});

it.each([false, true])("preserves the incumbent settlement through cleanup failures with prelock=%s", async hooked => {
  for (const outcome of ["success", "read", "COMMIT"]) {
    const failure = new Error("chosen outcome"), release = vi.fn(), remove = vi.fn();
    const base = pair(undefined, (_index, sql) => { if (sql === "COMMIT" && outcome === "COMMIT") throw failure; });
    let connected = 0;
    const pool = { async connect() {
      const db = await base.connect();
      if (connected++ !== 0) return db;
      const releaseClient = db.release, removeListener = db.removeListener;
      db.release = discard => { release(discard); releaseClient(discard); throw new Error("release failed"); };
      db.removeListener = (event, listener) => { remove(); removeListener(event, listener); throw new Error("listener removal failed"); };
      return db;
    } };
    const settled = withCatalogAdmissionFence(pool, scope(), async () => {
      if (outcome === "read") throw failure;
      return "chosen value";
    }, hooked ? { prelock: guard } : undefined);
    if (outcome === "success") await expect(settled).resolves.toBe("chosen value");
    else await expect(settled).rejects.toBe(failure);
    expect(release).toHaveBeenCalledExactlyOnceWith(outcome === "COMMIT");
    expect(remove).toHaveBeenCalledTimes(1);
  }
});

it("rejects any authorizer result other than undefined before fresh guards", async () => {
  const { request, guards } = await selectedFixture();
  for (const returned of [null, false, {}, () => Promise.resolve(), () => Promise.reject(new Error("async refusal"))]) {
    const trace: string[] = [];
    const pool = pair(undefined, (_index, sql) => { trace.push(sql); }, installation.runtime);
    const read = vi.fn(async () => undefined);
    const authorize = () => typeof returned === "function" ? returned() : returned;
    await expect(withSelectedCatalogAdmissionFence(pool, request, guards, read, authorize))
      .rejects.toThrow("authorizeFresh must return undefined");
    expect(trace).not.toContain(selectedSql);
    expect(read).not.toHaveBeenCalled();
  }
});

it("checks the guarded owner coordinates and uses the runtime login for the probe", async () => {
  const { request, guards } = await selectedFixture();
  const other = await selectedFixture();
  for (const [scope, message] of [
    [{ ...guards, skuRevisionId: other.guards.skuRevisionId }, "catalog_admission_line_ineligible"],
    [{ ...guards, priceListId: randomUUID() }, "catalog_admission_price_context_required"],
  ] as const) {
    await expect(withSelectedCatalogAdmissionFence(installation.runtime, request, scope, async () => "unexpected", noAuthorizationRefusal))
      .rejects.toMatchObject({ message });
  }
  let index = 0;
  const read = vi.fn(async () => "unexpected");
  await expect(withSelectedCatalogAdmissionFence({ connect: () => (index++ ? installation.owner : installation.runtime).connect() },
    request, guards, read, noAuthorizationRefusal)).rejects.toMatchObject({ message: unavailable, hint: checklist });
  expect(read).not.toHaveBeenCalled();
});

it("takes the transaction key before dispatch even if the writer already holds the session key", async () => {
  const { request, guards } = await selectedFixture();
  const statements: string[] = [];
  const pool = pair(async (index, db) => {
    if (index === 0) await db.query("SELECT pg_advisory_lock(hashtextextended($1::text,0))", [request.key]);
  }, (index, sql) => { if (index === 0) statements.push(sql); }, installation.runtime);
  try {
    await withSelectedCatalogAdmissionFence(pool, request, guards, async db => {
      expect((await db.query("SELECT pg_advisory_unlock(hashtextextended($1::text,0)) AS unlocked", [request.key])).rows)
        .toEqual([{ unlocked: true }]);
      // The session unlock is acknowledged while the writer transaction is still held here.
      const check = "SELECT pg_try_advisory_xact_lock(hashtextextended($1::text,0)) AS acquired";
      expect((await installation.owner.query(check, [request.key])).rows).toEqual([{ acquired: false }]);
    }, noAuthorizationRefusal);
    expect(statements.filter(sql => sql === keySql || sql === selectedSql)).toEqual([keySql, selectedSql]);
    // A successful fence result follows the writer's acknowledged COMMIT.
    expect((await installation.owner.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1::text,0)) AS acquired", [request.key])).rows)
      .toEqual([{ acquired: true }]);
  } finally {
    // An assertion before the unlock must not leave a session lock in the pool.
    const clients = await Promise.all([installation.runtime.connect(), installation.runtime.connect()]);
    try { await Promise.all(clients.map(db => db.query("SELECT pg_advisory_unlock_all()"))); }
    finally { clients.forEach(db => db.release()); }
  }
});

it("authorizes only after an absent receipt and skips fresh guards for a saved receipt", async () => {
  const { request, guards } = await selectedFixture();
  const trace: string[] = [];
  const pool = pair(undefined, (_index, sql) => { trace.push(traceName(sql)); }, installation.runtime);
  const read = vi.fn(async () => "unexpected");
  const refusal = Object.assign(new Error("starter_quote_refresh_required"), { label: "unauthenticated" });
  await expect(withSelectedCatalogAdmissionFence(pool, request, guards, read, () => { trace.push("authorize"); throw refusal; }))
    .rejects.toBe(refusal);
  expect(trace).toContain(lockTrace[3]);
  expect(trace.indexOf(lockTrace[3]!)).toBeLessThan(trace.indexOf("authorize"));
  expect(trace).not.toContain(selectedSql);
  expect(trace.filter(sql => sql === "WITH snap AS MATERIALIZED")).toHaveLength(2);
  expect(read).not.toHaveBeenCalled();

  const { rows: [order] } = await installation.owner.query(orderInsert, [request.clientId, 1]);
  await installation.owner.query(`INSERT INTO public.commerce_order_draft_receipts(idempotency_key,request_fingerprint,order_id,response_payload)
    VALUES($1,$2,$3,'{}')`, [request.key, "a".repeat(32), order.id]);
  trace.length = 0;
  await expect(withSelectedCatalogAdmissionFence(pool, request, undefined, async (db, instant, present) => {
    // The order and receipt inserts were acknowledged as autocommit statements before the fence started.
    expect(present).toBe(true);
    expect(Number.isFinite(Date.parse(instant))).toBe(true);
    expect((await db.query("SELECT id FROM public.commerce_orders WHERE id=$1", [order.id])).rows).toEqual([{ id: order.id }]);
    return "saved";
  }, () => { throw refusal; })).resolves.toBe("saved");
  expect(trace.filter(sql => sql === "WITH snap AS MATERIALIZED")).toHaveLength(2);
  expect(trace).not.toContain(selectedSql);
});

it("holds compatible selected guards through two concurrent order inserts and releases both keys", async () => {
  const [first, second] = [await selectedFixture(), await selectedFixture()];
  const atFirst = latch(), atSecond = latch(), insert = latch();
  const rollback = new Error("discard fixture orders");
  async function cross(entry: typeof first, ready: ReturnType<typeof latch<void>>, writer: ReturnType<typeof trackedSelectedWriter>) {
    return withSelectedCatalogAdmissionFence(writer.pool, entry.request, entry.guards, async db => {
      ready.resolve();
      await insert.wait();
      expect(await db.query(orderInsert, [entry.request.clientId, 1])).toMatchObject({ rows: [expect.objectContaining({ id: expect.any(String) })] });
      throw rollback;
    }, noAuthorizationRefusal).catch(error => error);
  }
  const started = performance.now();
  const writers = [trackedSelectedWriter(), trackedSelectedWriter()] as const;
  const leader = cross(first, atFirst, writers[0]);
  let follower: Promise<unknown> | undefined;
  try {
    await atFirst.wait(leader);
    follower = cross(second, atSecond, writers[1]);
    await atSecond.wait(follower);
    insert.resolve();
    expect(await Promise.all([leader, follower])).toEqual([rollback, rollback]);
    expect(performance.now() - started).toBeLessThan(setupTimeout);
    await Promise.all(writers.map(writer => writer.waitUntil(started + setupTimeout + wallMarginMs)));
    expect((await installation.owner.query("SELECT 1 FROM public.commerce_orders WHERE client_id=ANY($1::uuid[])",
      [[first.request.clientId, second.request.clientId]])).rows).toEqual([]);
  } finally { insert.resolve(); await Promise.all([leader, follower]); }
}, setupTimeout * 2);

it("bounds the shared client wait and retries the original key", async () => {
  const { request, guards } = await selectedFixture();
  const ready = latch(), release = latch();
  const contender = trackedSelectedWriter();
  const first = withSelectedCatalogAdmissionFence(installation.runtime, request, guards, async () => {
    ready.resolve();
    await release.wait();
  }, noAuthorizationRefusal);
  const second = { ...request, key: randomUUID(), timeoutMs: 300 };
  try {
    await ready.wait(first);
    const started = performance.now();
    await expect(withSelectedCatalogAdmissionFence(contender.pool, second, guards, async () => "unexpected", noAuthorizationRefusal))
      .rejects.toMatchObject({ message: unavailable, hint: sameKey });
    // Prove the contender's rollback while the client row is still held. The holder then acknowledges COMMIT.
    await contender.waitUntil(started + second.timeoutMs + wallMarginMs);
  } finally { release.resolve(); await first; }
  await expect(withSelectedCatalogAdmissionFence(installation.runtime, second, guards, async () => "retried", noAuthorizationRefusal))
    .resolves.toBe("retried");
});

it("guards 500 existing orders for the qualified client and refuses 501", async () => {
  const { request, guards } = await selectedFixture();
  await installation.owner.query(orderInsert, [request.clientId, 500]);
  await installation.owner.query(orderInsert, [clientId, 501]);
  // The seed inserts and the extra order below are acknowledged autocommit statements.
  await expect(withSelectedCatalogAdmissionFence(installation.runtime, request, guards, async db => {
    const { rows } = await db.query("SELECT count(*)::int AS count FROM public.commerce_orders WHERE client_id=$1", [request.clientId]);
    return rows[0]?.count;
  }, noAuthorizationRefusal)).resolves.toBe(500);
  await installation.owner.query(orderInsert, [request.clientId, 1]);
  await selectedRaw(async db => {
    await db.query(keySql, [request.key]);
    await expect(db.query(selectedSql, ["prelock", request.key, request.clientId, guards])).rejects.toMatchObject(dark);
  });
  const read = vi.fn(async () => {});
  await expect(withSelectedCatalogAdmissionFence(installation.runtime, request, guards, read, noAuthorizationRefusal))
    .rejects.toMatchObject({ message: dark.message });
  expect(read).not.toHaveBeenCalled();
});

it.each(["promotion roster", "email family"] as const)("refuses a selection requiring the open %s", async predicate => {
  const { request, guards, emailLocalPart } = await selectedFixture();
  const owner = installation.owner;
  const promotion = { status: "active", trigger_type: "automatic", discount_type: "percentage", applies_to_kind: "order_total",
    stacking_rule: "exclusive", eligibility: { first_subscription_purchase: true }, applies_to_payload: {}, region_availability: ["ZZ"],
    redemption_limit_per_customer: 1, redemption_limit_global: 1 };
  const addPromotion = (id: string) => owner.query("INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active) VALUES($1,$2,true)",
    [id, { ...promotion, id }]);
  const roster = predicate === "promotion roster";
  const names = [`fixture:${request.key}:existing`, `fixture:${request.key}:entrant`];
  if (roster) await addPromotion(names[0]!);
  const count = roster
    ? `SELECT count(*)::int AS count FROM jsonb_array_elements(public.commerce_promotion_active_definitions()) p WHERE p->>'id'=ANY($1::text[])`
    : `SELECT count(*)::int AS count FROM public.clients WHERE regexp_replace(lower(btrim(email)), '\\+[^@]*@', '@')=$1`;
  const parameters: [string | string[]] = [roster ? names : `${emailLocalPart}@example.invalid`];
  await withSelectedCatalogAdmissionFence(installation.runtime, request, guards, async db => {
    expect((await db.query(count, parameters)).rows).toEqual([{ count: 1 }]);
    if (roster) await addPromotion(names[1]!);
    else await installation.runtime.query("INSERT INTO public.clients(email) VALUES($1)", [`${emailLocalPart}+entrant@example.invalid`]);
    // The insert is committed before these reads. The writer retains its pinned snapshot.
    expect((await db.query(count, parameters)).rows).toEqual([{ count: 1 }]);
    expect((await installation.runtime.query(count, parameters)).rows).toEqual([{ count: 2 }]);
  }, noAuthorizationRefusal);

  const effects = `SELECT
    (SELECT count(*) FROM public.commerce_orders WHERE client_id=$1),
    (SELECT count(*) FROM public.commerce_order_draft_receipts WHERE idempotency_key=$2),
    (SELECT count(*) FROM public.outbox_events) AS outbox`;
  const before = (await owner.query(effects, [request.clientId, request.key])).rows;
  const trace: string[] = [];
  const read = vi.fn(async () => {});
  // The server has no qualified scope for an evaluator that uses this predicate.
  await expect(withSelectedCatalogAdmissionFence(pair(undefined, (_index, sql) => { trace.push(sql); }, installation.runtime),
    request, undefined, read, noAuthorizationRefusal)).rejects.toThrow("catalog_admission_line_ineligible");
  expect(read).not.toHaveBeenCalled();
  expect(trace).not.toContain(selectedSql);
  // The completed refusal never invoked a write path.
  expect((await owner.query(effects, [request.clientId, request.key])).rows).toEqual(before);
});

it.each([false, true])("bounds a stalled selected read and prevents late SQL on the released writer (blocked SQL: %s)", async busy => {
  const { request, guards } = await selectedFixture();
  const ready = latch(), resume = latch(), settled = latch<{ blocked: boolean | undefined; late: boolean }>();
  const statements: string[] = [], releases: boolean[] = [];
  const writer = trackedSelectedWriter((_index, sql) => { statements.push(sql); }, db => {
    const release = db.release.bind(db);
    db.release = discard => { releases.push(discard === true); release(discard); };
  });
  const owner = installation.owner;
  const blocker = busy ? await owner.connect() : undefined;
  const blockedKey = randomUUID();
  const input = { ...request, timeoutMs: 500 };
  let attempt: Promise<unknown> | undefined;
  try {
    if (blocker) {
      await blocker.query("BEGIN");
      await blocker.query(keySql, [blockedKey]);
    }
    const blockerPid = blocker && await pid(blocker);
    const deadline = performance.now() + input.timeoutMs + wallMarginMs;
    attempt = withSelectedCatalogAdmissionFence(writer.pool, input, guards, async db => {
      const blocked = blocker && db.query(keySql, [blockedKey]).then(() => false, () => true);
      ready.resolve();
      await resume.wait();
      const late = await db.query(selectedSql, ["write", request.key, request.clientId, {}]).then(() => false, () => true);
      settled.resolve({ blocked: await blocked, late });
    }, noAuthorizationRefusal).catch(error => error);
    await ready.wait(attempt);
    if (blockerPid !== undefined) await waitForBlock(writer.pid!, blockerPid, "advisory");
    // The peer must take both locks by the original budget plus 50 ms, while read is still stalled.
    await observeBefore(async () => {
      const { rows: [result] } = await owner.query<{ released: boolean }>(`SELECT
        pg_try_advisory_xact_lock(hashtextextended($1::text,0)) AND EXISTS (
          SELECT 1 FROM public.clients WHERE id=$2 FOR UPDATE SKIP LOCKED
        ) AS released`, [input.key, input.clientId]);
      return result?.released === true;
    }, deadline);
    expectFenceError(await attempt, { message: unavailable, hint: sameKey });
    expect(releases).toEqual([true]);
    await writer.waitUntil(deadline);
    resume.resolve();
    await settled.wait();
    const outcome = await settled.promise;
    if (busy) expect(outcome.blocked).toBe(true);
    expect(outcome.late).toBe(true);
    expect(statements.filter(sql => sql === selectedSql)).toHaveLength(1);
    expect(statements).not.toContain("COMMIT");
    await expect(withSelectedCatalogAdmissionFence(installation.runtime, request, guards, async () => "retried", noAuthorizationRefusal))
      .resolves.toBe("retried");
  } finally {
    resume.resolve();
    await attempt;
    if (blocker) await blocker.query("ROLLBACK").finally(() => blocker.release());
  }
});

it("snapshots selected input and handles deadline limits and guarded read transport", async () => {
  const fixture = await selectedFixture();
  const { clientId } = fixture.request;
  const connect = vi.fn(async () => { throw new Error("reserved"); });
  const read = vi.fn(async () => {});
  for (const input of [
    { key: "x".repeat(7) }, { key: "x".repeat(121) }, { key: "has space" }, { key: "valid-key\n" },
    { clientId: clientId.toUpperCase() }, { clientId: null }, { clientId: undefined },
    { timeoutMs: 0 }, { timeoutMs: 1.5 }, { timeoutMs: 2_147_483_648 }, { timeoutMs: undefined },
  ]) {
    await expect(withSelectedCatalogAdmissionFence({ connect }, { ...fixture.request, ...input } as typeof fixture.request,
      fixture.guards, read, noAuthorizationRefusal)).rejects.toBeInstanceOf(TypeError);
  }
  const invalidScopes = [null, { ...fixture.guards, extra: true }, { ...fixture.guards, skuIds: [clientId, clientId] },
    ...Object.keys(fixture.guards).map(key => ({ ...fixture.guards, [key]: undefined }))];
  for (const scope of invalidScopes) {
    await expect(withSelectedCatalogAdmissionFence({ connect }, fixture.request, scope as typeof fixture.guards, read, noAuthorizationRefusal))
      .rejects.toBeInstanceOf(TypeError);
  }
  expect(connect).not.toHaveBeenCalled();

  const readSql = "SELECT 123 AS value";
  for (const [key, timeoutMs] of [["12345678", 2_147_483_647], ["k".repeat(120), setupTimeout]] as const) {
    const input = { ...fixture.request, key, timeoutMs };
    const guards = { ...fixture.guards, skuIds: [...fixture.guards.skuIds] as [string, string] };
    const trade = pair(index => {
      if (index !== 0) return;
      input.key = "replacement";
      guards.skuIds[0] = randomUUID();
    }, (_index, sql, request, values) => {
      if (sql === keySql) expect((request as QueryConfig).values).toEqual([key]);
      if (sql === selectedSql) expect(JSON.parse((request as QueryConfig).values![3])).toEqual(fixture.guards);
      if (sql === readSql) expect(typeof request === "string" ? undefined : request.query_timeout).toBeGreaterThan(0);
      expect(values).toBeUndefined();
    }, installation.runtime);
    await expect(withSelectedCatalogAdmissionFence(trade, input, guards, async db => (await db.query(readSql)).rows,
      noAuthorizationRefusal)).resolves.toEqual([{ value: 123 }]);
  }

  const tiny = { ...fixture.request, timeoutMs: 1 };
  await expect(withSelectedCatalogAdmissionFence({ async connect() { await delay(20); return installation.runtime.connect(); } },
    tiny, fixture.guards, read, noAuthorizationRefusal)).rejects.toMatchObject({ message: unavailable, hint: sameKey });
  expect(read).not.toHaveBeenCalled();
});

type SelectedFixture = Awaited<ReturnType<typeof selectedFixture>>;
type CompetingWrite = (writer: PoolClient) => Promise<unknown>;
type GuardCase = { name: string; wait?: { type: string; relation?: string }; writer(entry: SelectedFixture): Promise<CompetingWrite> };
const tupleWait = { type: "transactionid" };
const relationWait = (relation: string) => ({ type: "relation", relation: `public.${relation}` });
const simpleWrite = (sql: string, values: (entry: SelectedFixture) => unknown[]) =>
  async (entry: SelectedFixture): Promise<CompetingWrite> => async db => db.query(sql, values(entry));
const componentGuards: GuardCase[] = [
  { name: "receipt", wait: tupleWait, async writer({ request }) {
    const { rows: [order] } = await installation.owner.query(orderInsert, [request.clientId, 1]);
    await installation.owner.query(`INSERT INTO public.commerce_order_draft_receipts(idempotency_key,request_fingerprint,order_id,response_payload)
      VALUES($1,$2,$3,'{}')`, [request.key, "a".repeat(32), order.id]);
    return db => db.query("UPDATE public.commerce_order_draft_receipts SET request_fingerprint=$2 WHERE idempotency_key=$1",
      [request.key, "b".repeat(32)]);
  } },
  { name: "erasure ledger", wait: relationWait("identity_privacy_erasures"), async writer({ request }) {
    return async db => {
      await db.query("LOCK TABLE public.identity_privacy_erasures IN SHARE ROW EXCLUSIVE MODE");
      await markReceiptClientErased(db, request.clientId);
    };
  } },
  { name: "exact client", wait: tupleWait, writer: simpleWrite("UPDATE public.clients SET first_name='Changed' WHERE id=$1",
    ({ request }) => [request.clientId]) },
  { name: "order insert via client foreign key", wait: tupleWait, writer: simpleWrite(orderInsert, ({ request }) => [request.clientId, 1]) },
  { name: "existing order status", async writer({ request }) {
    const { rows: [order] } = await installation.owner.query(orderInsert, [request.clientId, 1]);
    return db => db.query("UPDATE public.commerce_orders SET status='paid',paid_at=clock_timestamp() WHERE id=$1", [order.id]);
  } },
  { name: "selected SKU", wait: tupleWait, writer: simpleWrite("UPDATE public.catalog_skus SET sku=$2 WHERE id=$1",
    ({ guards }) => [guards.skuIds[1], randomUUID()]) },
  { name: "catalogue products", wait: relationWait("catalog_products"), writer: simpleWrite(
    "UPDATE public.catalog_products SET name='Changed' WHERE id=$1", ({ guards }) => [guards.skuIds[1]]) },
  { name: "catalogue projection", writer: simpleWrite(`INSERT INTO public.catalog_sku_identifiers
      (catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity) VALUES($1,'example','other',$2,'unit',1)`,
    ({ guards }) => [guards.skuIds[1], randomUUID()]) },
  { name: "price list", wait: relationWait("price_lists"), writer: simpleWrite("UPDATE public.price_lists SET name='Changed' WHERE id=$1",
    ({ guards }) => [guards.priceListId]) },
  { name: "base-price advisory", wait: { type: "advisory" }, async writer({ guards }) {
    return async db => {
      await db.query("SELECT public.catalog_price_setup_lock_context($1,$2)", [guards.priceListId, guards.skuIds[0]]);
      return db.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor)
        VALUES($1,$2,'one_time',100)`, [guards.priceListId, guards.skuIds[0]]);
    };
  } },
  { name: "direct price entry", wait: relationWait("price_entries"), writer: simpleWrite(
    "INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor) VALUES($1,$2,'subscription',100)",
    ({ guards }) => [guards.priceListId, guards.skuIds[1]]) },
  { name: "policy history", writer: simpleWrite(`INSERT INTO public.subscription_price_policy_revisions
      (id,revision_no,price_list_id,region_code,currency,channel,effective_from,discount_bps,rounding_quantum_minor,rounding_rule,digest)
      SELECT id,1,$1,'ZZ','XXX','D2C',at,1000,10,'FLOOR_TO_QUANTUM',
        public.catalog_price_setup_policy_digest(id,1,$1,'ZZ','XXX','D2C',at,NULL,1000,10,'FLOOR_TO_QUANTUM')
      FROM (SELECT gen_random_uuid() AS id,date_trunc('milliseconds',statement_timestamp()-interval '1 hour') AS at) v`,
    ({ guards }) => [guards.priceListId]) },
];

const phases = ["writer first", "before probe", "after probe"] as const;
it.each(componentGuards.flatMap(guard => phases.map(phase => ({ ...guard, phase }))))(
  "holds the selected $name guard with a competing writer $phase", async scenario => {
    const entry = await selectedFixture();
    const mutate = await scenario.writer(entry);
    const { request, guards } = entry;
    const runtime = installation.runtime;

    if (scenario.phase === "writer first") {
      const competing = await installation.owner.connect();
      let attempt: Promise<unknown> | undefined;
      const assigned = latch();
      const writer = trackedSelectedWriter(undefined, () => { assigned.resolve(); });
      try {
        await competing.query("BEGIN");
        await mutate(competing);
        const read = vi.fn(async () => "unexpected");
        const deadline = performance.now() + request.timeoutMs + wallMarginMs;
        attempt = withSelectedCatalogAdmissionFence(writer.pool, request, guards, read, noAuthorizationRefusal).catch(error => error);
        if (scenario.wait) {
          await assigned.wait(attempt);
          await waitForBlock(writer.pid!, await pid(competing), scenario.wait.type, scenario.wait.relation);
          await competing.query("COMMIT");
          expectFenceError(await attempt, { message: visibility, code: "40001", hint: sameKey });
        } else {
          expectFenceError(await attempt, { message: unavailable, hint: sameKey });
          await competing.query("COMMIT");
        }
        expect(read).not.toHaveBeenCalled();
        await writer.waitUntil(deadline);
      } finally { await competing.query("ROLLBACK"); competing.release(); await attempt; }
      await expect(withSelectedCatalogAdmissionFence(runtime, request, guards, async () => "retried", noAuthorizationRefusal)).resolves.toBe("retried");
      return;
    }

    const conflict = vi.fn(async () => {
      await expect(transaction(installation.owner, async db => {
        await db.query("SET LOCAL lock_timeout='150ms'");
        await mutate(db);
      })).rejects.toMatchObject({ code: "55P03" });
    });
    const writer = trackedSelectedWriter(async (index, sql) => {
      if (scenario.phase === "before probe" && index === 1 && sql.startsWith("WITH snap")) await conflict();
    });
    const deadline = performance.now() + request.timeoutMs + wallMarginMs;
    const outcome = await withSelectedCatalogAdmissionFence(writer.pool, request, guards, async () => {
      if (scenario.phase === "after probe") await conflict();
    }, noAuthorizationRefusal).catch(error => error);
    if (outcome !== undefined) {
      expect(scenario.phase).toBe("before probe");
      expectFenceError(outcome, { message: visibility, code: "40001", hint: sameKey });
    }
    expect(conflict).toHaveBeenCalledTimes(1);
    // The competing transaction helper has acknowledged ROLLBACK. Verify the fence writer has settled too.
    await writer.waitUntil(deadline);
    await transaction(installation.owner, mutate);
  }, setupTimeout * 2);

it("holds the complete catalogue projection and issue guards at the probe", async () => {
  const { request, guards } = await selectedFixture();
  const tables = [
    "catalog_products", "catalog_skus", "catalog_sku_identifiers", "catalog_product_document_revisions", "catalog_attribute_projection",
    "catalog_publication_heads", "catalog_publications", "catalog_sku_revisions", "catalog_operator_receipts", "catalog_publication_decisions",
    "catalog_publication_pointer_capabilities", "catalog_draft_heads", "catalog_draft_revisions", "catalog_draft_command_receipts",
    "price_lists", "price_entries", "subscription_price_policy_revisions", "identity_privacy_erasures",
  ].sort();
  let writerPid = 0;
  const pool = pair(async (index, db) => { if (index === 0) writerPid = await pid(db); }, async (index, sql) => {
    if (index !== 1 || !sql.startsWith("WITH snap")) return;
    // The writer acknowledged the guard query and cannot finish while this probe hook is pending.
    const { rows } = await installation.owner.query(`SELECT c.relname FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE l.pid=$1 AND l.mode='ShareLock' AND l.granted AND n.nspname='public'
      ORDER BY c.relname COLLATE "C"`, [writerPid]);
    expect(rows.map(row => row.relname)).toEqual(tables);
  }, installation.runtime);
  await withSelectedCatalogAdmissionFence(pool, request, guards, async () => {}, noAuthorizationRefusal);
});

it("keeps a real Stage B revision out until the selected crossing releases its catalogue guards", async () => {
  const { request, guards } = await selectedFixture();
  const { command } = await approvedPublication(true, "5012345678900");
  const api = publisher(), actor = (await api.authorize(actorId))!;
  const attempt = async () => {
    expect(await api.execute(command, actor)).toMatchObject({ outcome: "conflict", reason: "publication_busy" });
  };
  const writer = trackedSelectedWriter(async (index, sql) => {
    if (index === 1 && sql.startsWith("WITH snap")) await attempt();
  });
  const deadline = performance.now() + request.timeoutMs + wallMarginMs;
  const beforeProbe = await withSelectedCatalogAdmissionFence(writer.pool, request, guards, async () => {}, noAuthorizationRefusal).catch(error => error);
  if (beforeProbe !== undefined) expectFenceError(beforeProbe, { message: visibility, code: "40001", hint: sameKey });
  await writer.waitUntil(deadline);
  await withSelectedCatalogAdmissionFence(installation.runtime, request, guards, attempt, noAuthorizationRefusal);
  // The selected writer's COMMIT has been acknowledged before the publisher crosses in this third transaction.
  expect(await api.execute(command, actor)).toMatchObject({ outcome: "committed" });
});

it("restores selected read settings before commit and preserves an unacknowledged commit error", async () => {
  const { request, guards } = await selectedFixture();
  const releases: boolean[] = [];
  let writer: PoolClient;
  const commitFailure = new Error("commit transport failed");
  const tracked = trackedSelectedWriter(async (_index, sql) => {
    if (sql !== "COMMIT") return;
    // Read the restored settings on the original backend before sending COMMIT.
    expect((await writer.query("SELECT current_setting('lock_timeout') AS lock,current_setting('statement_timeout') AS statement")).rows)
      .toEqual([{ lock: "250ms", statement: "700ms" }]);
    throw commitFailure;
  }, async db => {
    writer = db;
    await db.query("SET lock_timeout='250ms'; SET statement_timeout='700ms'");
    const release = db.release.bind(db);
    db.release = discard => { releases.push(discard === true); release(discard); throw new Error("cleanup failed"); };
  });
  await expect(withSelectedCatalogAdmissionFence(tracked.pool, request, guards, async db => {
    await db.query("SET LOCAL lock_timeout='10ms'");
  }, noAuthorizationRefusal)).rejects.toBe(commitFailure);
  expect(releases).toEqual([true]);
  // COMMIT has no fence deadline. This test fault is before dispatch, so use the fixture's observation bound.
  await tracked.waitUntil(performance.now() + barrierTimeout);
  await expect(withSelectedCatalogAdmissionFence(installation.runtime, request, guards, async () => "retried", noAuthorizationRefusal))
    .resolves.toBe("retried");
});

it("retries a receipt committed while the selected fence waits on its key", async () => {
  const { request, guards } = await selectedFixture();
  const blocker = await installation.owner.connect();
  const assigned = latch();
  const trace: string[] = [];
  let attempt: Promise<unknown> | undefined;
  const writer = trackedSelectedWriter((_index, sql) => { trace.push(sql); }, () => { assigned.resolve(); });
  const read = vi.fn(async () => "unexpected");
  const authorize = vi.fn(() => { throw new Error("starter_quote_refresh_required"); });
  try {
    await blocker.query("BEGIN");
    await blocker.query(keySql, [request.key]);
    const { rows: [order] } = await blocker.query(orderInsert, [request.clientId, 1]);
    await blocker.query(`INSERT INTO public.commerce_order_draft_receipts(idempotency_key,request_fingerprint,order_id,response_payload)
      VALUES($1,$2,$3,'{}')`, [request.key, "a".repeat(32), order.id]);
    const deadline = performance.now() + request.timeoutMs + wallMarginMs;
    attempt = withSelectedCatalogAdmissionFence(writer.pool, request, guards, read, authorize).catch(error => error);
    await assigned.wait(attempt);
    await waitForBlock(writer.pid!, await pid(blocker), "advisory");
    await blocker.query("COMMIT");
    expectFenceError(await attempt, { message: visibility, code: "40001", hint: sameKey });
    expect(read).not.toHaveBeenCalled();
    expect(trace).not.toContain(selectedSql);
    await writer.waitUntil(deadline);
    await expect(withSelectedCatalogAdmissionFence(installation.runtime, request, undefined, async (_db, _instant, present) => present, authorize))
      .resolves.toBe(true);
    expect(authorize).toHaveBeenCalledTimes(1);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); await attempt; }
});
