import { randomUUID } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { PoolClient, QueryConfig } from "pg";
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
let clientId: string, skuId: string, priceListId: string, orderId: string;
const setupTimeout = 6_000;
const sameKey = "Retry the same request with the same idempotency key.";
const checklist = "Check the native binding, connection/TLS, privileges and migrations.";
const unavailable = "catalog_admission_fence_unavailable";
const visibility = "catalog_admission_visibility_changed";
const ledgerSql = "LOCK TABLE public.identity_privacy_erasures IN SHARE MODE";
const clientSql = "SELECT id FROM public.clients WHERE id=$1 FOR KEY SHARE";
const ownerSql = "SELECT id FROM public.clients WHERE id=$1 FOR UPDATE";
const orderSql = "SELECT id FROM public.commerce_orders WHERE id=$1 FOR NO KEY UPDATE";

const scope = (timeoutMs = setupTimeout) => ({ key: randomUUID(), clientId, priceListId,
  skuIds: [skuId], revisionIds: [], timeoutMs });
type Prelock = NonNullable<NonNullable<Parameters<typeof withCatalogAdmissionFence>[3]>["prelock"]>;
const guard: Prelock = async db => {
  await db.query(ledgerSql);
  await db.query(clientSql, [clientId]);
};
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(ready => { resolve = ready; });
  return { promise, resolve };
}
const pid = async (db: PoolClient) => Number((await db.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);

beforeAll(async () => {
  installation = await lifecycleInstallation("qualified-v2");
  const owner = installation.owner;
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
afterAll(() => installation?.close(), postgresTeardownTimeoutMs);

type ClientObserver = (index: number, db: PoolClient) => Promise<void> | void;
type QueryObserver = (index: number, text: string) => Promise<void> | void;
function pair(observeClient: ClientObserver = () => {}, observeQuery: QueryObserver = () => {}) {
  let index = 0;
  return { async connect() {
    const number = index++;
    const db = await installation.owner.connect();
    await observeClient(number, db);
    return {
      query: async (request: string | QueryConfig, values?: unknown[]) => {
        await observeQuery(number, typeof request === "string" ? request : request.text);
        return typeof request === "string" ? db.query(request, values) : db.query(request);
      },
      on: db.on.bind(db), removeListener: db.removeListener.bind(db), release: db.release.bind(db),
    } as PoolClient;
  } };
}

async function waitForBlock(waiter: number, holder: number, locktype: string, relation?: string) {
  const end = performance.now() + setupTimeout - 1000;
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

it("omitted and empty options preserve the original statement trace", async () => {
  for (const options of [undefined, {}]) {
    const trace: string[] = [];
    const pool = pair(undefined, (_, sql) => { trace.push(traceName(sql)); });
    await withCatalogAdmissionFence(pool, scope(), async () => "accepted", options);
    expect(trace).toEqual(lockTrace);
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
    await Promise.race([started.promise, attempt]);
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
  const input = scope(650);
  try {
    await expect(withCatalogAdmissionFence(owner, input, read, { prelock: async db => {
      await guard(db);
      await finish.promise;
      await expect(db.query(ledgerSql)).rejects.toThrow();
      late.resolve();
    } })).rejects.toMatchObject({ message: unavailable, hint: sameKey });
    expect(read).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(2);
    expect(release.mock.calls.some(([discard]) => Boolean(discard))).toBe(true);
    expect(await withCatalogAdmissionFence(owner, { ...input, timeoutMs: setupTimeout }, async () => "retried", { prelock: guard })).toBe("retried");
  } finally {
    owner.removeListener("release", release);
    finish.resolve();
  }
  await late.promise;
});

it("bounds a late blocked statement and lets the same key retry while its blocker and callback remain pending", async () => {
  const owner = installation.owner;
  const holder = await owner.connect(), finish = latch(), blocked = latch();
  const input = scope(1200);
  let writerPid = 0;
  let attempt: Promise<unknown> | undefined;
  try {
    await holder.query("BEGIN");
    const holderPid = await pid(holder);
    await holder.query(ownerSql, [clientId]);
    const pool = pair(async (index, db) => { if (index === 0) writerPid = await pid(db); });
    const start = performance.now();
    attempt = withCatalogAdmissionFence(pool, { ...input, clientId: randomUUID() }, async () => "unexpected", { prelock: async db => {
      for (let n = 0; n < 6; n++) {
        await db.query("SELECT pg_advisory_xact_lock(1917, $1)", [n]);
        while (performance.now() < start + 100 * (n + 1)) await yieldTurn();
      }
      blocked.resolve();
      await db.query(clientSql, [clientId]).catch(() => {});
      await finish.promise;
    } });
    void attempt.catch(() => {});
    await Promise.race([blocked.promise, attempt]);
    await waitForBlock(writerPid, holderPid, "transactionid");
    await expect(attempt).rejects.toMatchObject({ message: unavailable, hint: sameKey });
    expect(await withCatalogAdmissionFence(owner, { ...input, clientId: randomUUID(), timeoutMs: setupTimeout },
      async () => "retried", { prelock: async db => { await db.query(ledgerSql); } })).toBe("retried");
    expect(performance.now() - start).toBeLessThan(input.timeoutMs + 400);
  } finally {
    finish.resolve();
    await holder.query("ROLLBACK").finally(() => holder.release());
    await attempt?.catch(() => {});
  }
});

it("applies one wall budget to a stream of individually short lock queries", async () => {
  const input = scope(200), read = vi.fn(async () => "unexpected");
  await expect(withCatalogAdmissionFence(installation.owner, input, read, { prelock: async db => {
    for (let i = 0; ; i++) await db.query("SELECT pg_advisory_xact_lock(1918, $1)", [i]);
  } })).rejects.toMatchObject({ message: unavailable, hint: sameKey });
  expect(read).not.toHaveBeenCalled();
});

it("preserves an exact owner refusal and rolls back before the same key retries", async () => {
  const ownerRefusal = new Error("catalog_admission_line_ineligible");
  const read = vi.fn(async () => "unexpected"), input = scope();
  const query: string[] = [];
  await expect(withCatalogAdmissionFence(pair(undefined, (_, text) => { query.push(text); }), input, read, {
    prelock: async db => { await guard(db); throw ownerRefusal; },
  })).rejects.toBe(ownerRefusal);
  expect(read).not.toHaveBeenCalled();
  expect(query.at(-1)).toBe("ROLLBACK");
  const withDiagnostics = new Error(ownerRefusal.message, { cause: new Error("Private diagnostic") });
  const sanitized = await withCatalogAdmissionFence(installation.owner, input, read, {
    prelock: async () => { throw withDiagnostics; },
  }).catch(error => error);
  expect(sanitized).toMatchObject({ message: unavailable, hint: checklist });
  expect(sanitized).not.toHaveProperty("cause");
  await expect(withCatalogAdmissionFence(installation.owner, input, async () => "retried", { prelock: guard })).resolves.toBe("retried");
});

it("captures and restores the original settings while retaining a stricter lock limit", async () => {
  const settings = "SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock, current_setting('idle_in_transaction_session_timeout') AS idle";
  const trace: string[] = [];
  const pool = pair(async (index, db) => {
    if (index === 0) await db.query("SET statement_timeout='19s'; SET lock_timeout='900ms'; SET idle_in_transaction_session_timeout='17s'");
  }, (_, sql) => { trace.push(sql); });
  await withCatalogAdmissionFence(pool, scope(), async db => {
    expect((await db.query(settings)).rows).toEqual([{ statement: "19s", lock: "900ms", idle: "17s" }]);
  }, { prelock: async db => {
    await guard(db);
    const { rows } = await db.query(settings);
    expect(rows[0]).toMatchObject({ lock: "900ms" });
    expect(String(rows[0]?.statement)).toMatch(/^(?:[1-5]?[0-9]{1,3}ms|[1-6]s)$/u);
  } });
  expect(trace.findIndex(sql => sql.includes("current_setting"))).toBeLessThan(trace.findIndex(sql => sql.startsWith("SET LOCAL statement_timeout")));
});

it.each([0, -1, 1.5, NaN, Infinity, 2147483648, "1000"])("refuses invalid hook timeout %s before reservation", async value => {
  const connect = vi.fn(() => installation.owner.connect());
  const error = await withCatalogAdmissionFence({ connect }, scope(value as number), async () => {}, { prelock: guard }).catch(error => error);
  expect(error).toBeInstanceOf(TypeError);
  expect(error.message).toContain("timeoutMs");
  expect(connect).not.toHaveBeenCalled();
});

it.each([null, false, 17, {}])("refuses non-function prelock %s before reservation", async value => {
  const connect = vi.fn(() => installation.owner.connect());
  const error = await withCatalogAdmissionFence({ connect }, scope(), async () => {}, { prelock: value as Prelock }).catch(error => error);
  expect(error).toBeInstanceOf(TypeError);
  expect(error.message).toContain("prelock");
  expect(connect).not.toHaveBeenCalled();
});

it.each([1, 2147483647])("accepts the inclusive hook timeout edge %s before checking budget", async value => {
  const connect = vi.fn(() => Promise.reject(new Error("synthetic connection refusal")));
  await expect(withCatalogAdmissionFence({ connect }, scope(value), async () => {}, { prelock: guard }))
    .rejects.toMatchObject({ message: unavailable, hint: checklist });
  expect(connect).toHaveBeenCalled();
});

it("keeps the old timeout domain when the hook is absent", async () => {
  const connect = vi.fn(() => Promise.reject(new Error("synthetic connection refusal")));
  await expect(withCatalogAdmissionFence({ connect }, scope(NaN), async () => {})).rejects.toMatchObject({ message: unavailable });
  expect(connect).toHaveBeenCalled();
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
    await Promise.race([result, starting.promise]);
    await waitForBlock(writerPid, blockerPid, "transactionid");
    expect((await owner.query("SELECT pg_cancel_backend($1) AS cancelled", [writerPid])).rows[0]!.cancelled).toBe(true);
    const failure = await result.catch(error => error);
    expect(failure).toMatchObject({ message: unavailable, hint: checklist });
    expect(Object.keys(failure as object)).toEqual(["hint"]);
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
    await finish.promise;
  } });
  void first.catch(() => {});
  try {
    await Promise.race([started.promise, first]);
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
    await Promise.race([result, starting.promise]);
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
    const firstRead = vi.fn(async () => { atRead.resolve(); await release.promise; return first; });
    const secondRead = vi.fn(async () => second);
    const pids: number[] = [];
    const makePair = (index: number) => pair(async (offset, db) => {
      if (offset === 0) {
        pids[index] = await pid(db);
        if (index === second) assigned.resolve();
      }
    });
    const options = { prelock: lane === "order guard" ? sameOrder : guard };
    const leader = withCatalogAdmissionFence(makePair(first), actors[first]!, firstRead, options);
    void leader.catch(() => {});
    let follower: Promise<number | Error> | undefined;
    try {
      await Promise.race([atRead.promise, leader]);
      follower = withCatalogAdmissionFence(makePair(second), actors[second]!, secondRead, options).catch(error => error);
      await assigned.promise;
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
  const owner = installation.owner;
  const first = await owner.connect(), reverse = await owner.connect();
  const skuLock = "SELECT id FROM public.catalog_skus WHERE id=$1 FOR UPDATE";
  let held: Promise<unknown> | undefined;
  let inverted: Promise<unknown> | undefined;
  const result = (error: { code?: string }) => ({ code: error.code });
  try {
    const [firstPid, reversePid] = await Promise.all([pid(first), pid(reverse)]);
    for (const db of [first, reverse]) {
      await db.query("BEGIN");
      await db.query(`SET LOCAL lock_timeout='${setupTimeout}ms'; SET LOCAL deadlock_timeout='200ms'`);
    }
    await first.query(orderSql, [orderId]);
    await reverse.query(skuLock, [skuId]);
    held = first.query(skuLock, [skuId]).then(() => ({}), result);
    await waitForBlock(firstPid, reversePid, "transactionid");
    inverted = reverse.query(orderSql, [orderId]).then(() => ({}), result);
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
    const other = await owner.connect();
    const stopCheckout = latch(), atRead = latch(), writerAssigned = latch();
    let buyerPid = 0;
    const read = vi.fn(async () => { atRead.resolve(); await stopCheckout.promise; return "checkout committed"; });
    const checkout = () => withCatalogAdmissionFence(pair(async (index, db) => {
      if (index === 0) { buyerPid = await pid(db); writerAssigned.resolve(); }
    }), { ...scope(), clientId: subject }, read, { prelock: async db => {
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
      await other.query(`SET LOCAL lock_timeout='${setupTimeout}ms'`);
      const otherPid = await pid(other);
      if (checkoutFirst) {
        purchase = checkout();
        void purchase.catch(() => {});
        await Promise.race([atRead.promise, purchase]);
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
        await writerAssigned.promise;
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
  const db = await owner.connect(), atRead = latch(), finish = latch(), buyerAssigned = latch();
  const list = (await owner.query("INSERT INTO public.price_lists(name,region_code,currency) VALUES('Price apply','ZZ','XXX') RETURNING id")).rows[0]!.id;
  const input = { ...scope(), priceListId: list };
  const price = await db.query(`INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor,mode,valid_from)
    VALUES($1,$2,125,'one_time',clock_timestamp()-interval '1 hour') RETURNING id`, [list, skuId]);
  const command = { schemaVersion: 1, commandKey: randomUUID(), variantId: skuId, priceListId: list,
    mode: "one_time", minQty: 1, amountKind: "gross", unitPriceMinor: 130, expected: { entryId: price.rows[0]!.id, unitPriceMinor: 125 } };
  const handler = createCatalogPriceSetupHandler({ store: createPostgresCatalogPriceSetupStore(db),
    authorizeOperator: async () => ({ actorId }) });
  let writerPid = 0;
  const read = vi.fn(async () => { atRead.resolve(); await finish.promise; return "checkout committed"; });
  const checkout = () => withCatalogAdmissionFence(pair(async (index, writer) => {
    if (index === 0) { writerPid = await pid(writer); buyerAssigned.resolve(); }
  }), input, read, { prelock: guard });
  let purchase: Promise<string> | undefined;
  let apply: ReturnType<typeof handler.apply> | undefined;
  try {
    const pricePid = await pid(db);
    await db.query("BEGIN");
    await db.query(`SET LOCAL lock_timeout='${setupTimeout}ms'; SET LOCAL ROLE authenticated`);
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actorId, role: "authenticated" })]);
    if (checkoutFirst) {
      purchase = checkout();
      void purchase.catch(() => {});
      await Promise.race([atRead.promise, purchase]);
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
      await buyerAssigned.promise;
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
    catalogPublicationOwner: { run: work => transaction(installation.owner, db => work({ async query(sql, args) {
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
  const pool = pair(async (index, db) => { if (index === 0) { writerPid = await pid(db); buyerAssigned.resolve(); } });
  const api = publisher(async db => { publisherPid = await pid(db); relationHeld.resolve(); await releasePublication.promise; });
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
      await Promise.race([relationHeld.promise, publish]);
      expect(publisherPid).toBeGreaterThan(0);
      const write = vi.fn(async () => "unexpected");
      purchase = withCatalogAdmissionFence(pool, input, write, { prelock: guard });
      void purchase.catch(() => {});
      await buyerAssigned.promise;
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
