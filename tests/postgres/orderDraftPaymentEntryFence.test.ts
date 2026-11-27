import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { expect, it } from "vitest";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { installAccountMutationsBeforeForward } from "./customerAccountMutations.fixture.js";
import { backendPid } from "./destinationReceiptFixture.js";
import { assertRuntime } from "./orderDraftReceiptsV2.fixture.js";
import { issue, write } from "./orderMoneyV2Guards.fixture.js";
import { expectSqlError, rejected, seedSku, transaction, version } from "./orderMoneyV2Storage.fixture.js";

type Db = Pool | PoolClient;
const opener = "commerce_open_settlement_intent";
const provider = "payment_provider_intent_create";
const providerOpener = "commerce_open_settlement_intent_for_provider";
const signatures = [
  `public.${opener}(text,uuid,text,bigint,text,jsonb,timestamptz)`,
  `public.${provider}(text,text,uuid,uuid,uuid,bigint,text,jsonb,text,timestamptz)`,
];
const refusal = "fiscal_confirmation_unenforceable";
const field = "/paymentLimits/channelKey";
const hint = "Prepare payment for this order through the versioned-money payment preparation. Legacy settlement opening and provider intent creation do not apply to orders with versioned money.";
const at = "2026-10-01T00:00:00.000Z";
const channel = "card_rail";
const currency = "XXX";

const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as
  Parameters<typeof installAccountMutationsBeforeForward>[0];
const forward = manifest.forward.find(unit => unit.file.endsWith("_order_draft_payment_entry_fence.sql"))!;
const sql = readFileSync(forward.file, "utf8");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function guard(record: string, indent: string) {
  return [
    `IF ${record}.money_version IS NOT NULL THEN`,
    `  RAISE EXCEPTION '${refusal}' USING ERRCODE = '22023',`,
    `    DETAIL = '${field}',`,
    `    HINT = '${hint}';`,
    "END IF;",
  ].map(line => indent + line).join("\n") + "\n";
}

const openerGuard = guard("v_order", "  ");
const providerGuard = guard("o", " ");
const providerOpenCall = `opened:=public.${providerOpener}(`;
const sourcePins = [
  {
    name: opener,
    source: "db/platform/migrations/20260810180000_payment_settlement_rail.sql",
    addition: openerGuard,
    before: "  RETURNING * INTO v_transition;\n\n",
    after: "  RETURN public.commerce_settlement_response(v_intent, v_transition.id, 'opened', false);\n",
    hash: "1de48eef8ad18302ea5e35aab121322045723594e9857eac8dd1157967a6ca4f",
  },
  {
    name: provider,
    source: "db/platform/migrations/20261114100000_payment_provider_attempt_store.sql",
    addition: providerGuard,
    before: " VALUES('commerce.payment_intent.create',p_idempotency_key,fingerprint,'completed',answer,jsonb_build_object('paymentIntentId',i.id,'paymentId',ps.payment_id,'channelKey',p_channel_key));\n",
    after: " RETURN answer;\n",
    hash: "5f8d3f14b8f2eb791333ee5a7227bc33d54fd410d5d5730b5f0f65a819e28b02",
  },
];

function assertBytes(forwardSql: string) {
  const definitions = [...forwardSql.matchAll(/^CREATE( OR REPLACE)? FUNCTION public\.([a-z_]+)\([\s\S]*?^\$\$;\n/gmu)];
  expect(definitions.map(match => match[2])).toStrictEqual([providerOpener, opener, provider]);
  expect(definitions.map(match => match[1])).toStrictEqual([undefined, " OR REPLACE", " OR REPLACE"]);
  for (const [index, { name, source, before, addition, after, hash }] of sourcePins.entries()) {
    const definition = definitions[index + 1]![0];
    expect(definition.split(before + addition + after)).toHaveLength(2);
    let original = definition.replace("CREATE OR REPLACE FUNCTION", "CREATE FUNCTION").replace(before + addition + after, before + after);
    if (name === opener) {
      original = original.replace("SET search_path = public, pg_catalog, pg_temp", "SET search_path = public, pg_catalog");
      expect(definitions[0]![0].replace(providerOpener, opener)).toBe(definition
        .replace("CREATE OR REPLACE FUNCTION", "CREATE FUNCTION").replace(before + addition + after, before + after));
    } else {
      expect(original.split(providerOpenCall)).toHaveLength(2);
      original = original.replace(providerOpenCall, `opened:=public.${opener}(`);
    }
    const landed = readFileSync(source, "utf8").match(new RegExp(
      `^CREATE FUNCTION public\\.${name}\\([\\s\\S]*?^\\$\\$;\\n`, "mu",
    ))?.[0];
    expect(landed).toBe(original);
    expect(sha256(original)).toBe(hash);
  }
}

it("pins the fresh-return guards, owner opening copy and incumbent source ranges byte for byte", () => {
  for (const { before, addition, after } of sourcePins) {
    // Temporarily moved a fresh-return guard in a disposable forward string.
    expect(() => assertBytes(sql.replace(before + addition + after, addition + before + after))).toThrow();
  }
  expect(() => assertBytes(sql.replace(providerOpenCall, `opened:=public.${opener}(`))).toThrow();
  assertBytes(sql);
});

type Order = { id: string; amount: number; currency: string };
type Settlement = {
  contractVersion: string; outcome: string; replayed: boolean; transitionId: string;
  settlement: { id: string; orderId: string; status: string; amountMinor: number; currencyCode: string;
    externalRef: string | null; failureReason: string | null };
};
type Payment = {
  contractVersion: string;
  paymentIntent: { id: string; orderId: string; amountMinor: number; currency: string; replayed: boolean };
};

async function open(db: Db, order: Order, key: string, input: { channel?: string; metadata?: object } = {}) {
  const { rows } = await db.query<{ result: Settlement }>(
    "SELECT public.commerce_open_settlement_intent($1,$2,$3,$4,$5,$6,$7) AS result",
    [key, order.id, input.channel ?? channel, order.amount, order.currency, input.metadata ?? {}, at],
  );
  return rows[0]!.result;
}

async function create(db: Db, order: Order, key: string, channelKey = channel) {
  const { rows } = await db.query<{ result: Payment }>(
    "SELECT public.payment_provider_intent_create($1,'one_time_order',$2,NULL,NULL,$3,$4,'{}'::jsonb,$5,$6) AS result",
    [key, order.id, order.amount, order.currency, channelKey, at],
  );
  return rows[0]!.result;
}

function expectError(error: unknown, code: string, message: string, detail?: string, remedy?: string) {
  expectSqlError(error, code, message);
  expect(error).toMatchObject({
    detail, hint: remedy, schema: undefined, table: undefined, column: undefined, dataType: undefined,
  });
}

async function expectOccupiedKey(run: Promise<unknown>, table: string, column: string, key: string) {
  const error = await rejected(run);
  const constraint = `${table}_${column}_key`;
  expectSqlError(error, "23505", `duplicate key value violates unique constraint "${constraint}"`, constraint);
  expect(error).toMatchObject({
    detail: `Key (${column})=(${key}) already exists.`,
    schema: "public", table, hint: undefined, column: undefined, dataType: undefined,
  });
}

const expectOccupiedOpening = (run: Promise<unknown>, key: string) =>
  expectOccupiedKey(run, "commerce_settlement_intents", "open_idempotency_key", key);

async function expectFence(run: Promise<unknown>, routine: string) {
  const error = await rejected(run);
  expectError(error, "22023", refusal, field, hint);
  expect(error).toMatchObject({ where: expect.stringMatching(new RegExp(`^[^\\n]+ function (?:public\\.)?${routine}\\(`, "u")) });
}

const paymentRelations = ["commerce_settlement_intents", "commerce_settlement_transitions", "payment_provider_states",
  "payment_provider_transitions", "payment_provider_receipts"];
const affectedRelations = [...paymentRelations, "outbox_events", "payment_provider_attempt_evidence", "payment_truth_events"];
async function paymentFacts(db: Db) {
  const facts: Record<string, { fact: string }[]> = {};
  for (const table of affectedRelations) {
    facts[table] = (await db.query<{ fact: string }>(
      `SELECT to_jsonb(fact)::text AS fact FROM public.${table} AS fact ORDER BY 1`)).rows;
  }
  return facts;
}

async function concurrentKeyReservation(
  { owner, runtime }: { owner: Pool; runtime: Pool },
  finish: "COMMIT" | "ROLLBACK",
  reserve: (db: PoolClient) => Promise<unknown>,
  attempt: (db: PoolClient) => Promise<unknown>,
  verify: (run: Promise<unknown>) => Promise<void>,
) {
  const before = await paymentFacts(owner);
  const blocker = await owner.connect();
  const contender = await runtime.connect();
  try {
    const [waitingPid, blockingPid] = await Promise.all([backendPid(contender), backendPid(blocker)]);
    await blocker.query("BEGIN");
    await contender.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await contender.query("SET LOCAL statement_timeout = '10s'");
    await contender.query("SELECT pg_current_snapshot()");
    await reserve(blocker);
    const reserved = await paymentFacts(blocker);

    const checked = verify(attempt(contender));
    void checked.catch(() => {});
    await expect.poll(async () => (await owner.query(`SELECT $2::int = ANY(pg_blocking_pids($1))
      AND EXISTS (SELECT FROM pg_locks WHERE pid=$1 AND locktype='transactionid' AND mode='ShareLock' AND NOT granted)
      AS blocked`, [waitingPid, blockingPid])).rows[0]?.blocked, { timeout: 4_000 }).toBe(true);
    await blocker.query(finish);
    await checked;
    expect(await paymentFacts(owner)).toStrictEqual(finish === "COMMIT" ? reserved : before);
  } finally {
    await blocker.query("ROLLBACK");
    await contender.query("ROLLBACK");
    blocker.release();
    contender.release();
  }
}

async function fenceWithinSavepoint(
  { owner, runtime }: { owner: Pool; runtime: Pool },
  routine: string,
  order: Order,
  attempt: (db: PoolClient, order: Order, key: string) => Promise<unknown>,
) {
  const { rows: [role] } = await runtime.query<{ statement: string }>("SELECT format('SET LOCAL ROLE %I', current_user) AS statement");
  const before = await paymentFacts(owner);
  await transaction(owner, async db => {
    const pid = await backendPid(db);
    const transactionId = () => db.query("SELECT pg_current_xact_id()::text AS xid").then(result => result.rows[0]!.xid);
    const xid = await transactionId();
    const locks = () => owner.query(`SELECT (to_jsonb(l)-'fastpath'-'waitstart')::text AS lock
      FROM pg_locks l WHERE pid=$1 ORDER BY 1`, [pid]).then(result => result.rows);
    const beforeLocks = await locks();

    await db.query("SAVEPOINT payment_fence");
    await db.query(role!.statement);
    await expectFence(attempt(db, order, `savepoint-${randomUUID()}`), routine);
    await db.query("ROLLBACK TO SAVEPOINT payment_fence");
    expect(await locks()).toStrictEqual(beforeLocks);

    // Uncontended row locks need not appear in pg_locks. A second connection must be able to lock the same rows.
    expect((await owner.query("SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE NOWAIT", [order.id])).rows)
      .toStrictEqual([{ id: order.id }]);
    const locked = await owner.query("SELECT id FROM public.commerce_settlement_intents WHERE order_id=$1 FOR UPDATE NOWAIT", [order.id]);
    const settlements = before.commerce_settlement_intents!.map(({ fact }) => JSON.parse(fact) as { order_id: string; id: string });
    expect(locked.rows).toStrictEqual(settlements.filter(row => row.order_id === order.id).map(({ id }) => ({ id })));

    expect(await paymentFacts(db)).toStrictEqual(before);
    await db.query("RELEASE SAVEPOINT payment_fence");
    expect(await transactionId()).toBe(xid);
  });
  expect(await paymentFacts(owner)).toStrictEqual(before);
}

function routineAttributes(db: Db) {
  return db.query(`
    SELECT requested.signature, p.oid, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
           p.prosecdef, p.proconfig, p.provolatile, p.pronargdefaults, pg_get_expr(p.proargdefaults, 0) AS defaults
    FROM unnest($1::text[]) WITH ORDINALITY AS requested(signature, ordinal)
    JOIN pg_proc p ON p.oid = requested.signature::regprocedure
    ORDER BY requested.ordinal`, [signatures]).then(result => result.rows);
}

function receiptReplay(original: Payment): Payment {
  return { ...original, paymentIntent: { ...original.paymentIntent, replayed: true } };
}

function showMutationFailure(check: (db: Db) => Promise<void>, store: Awaited<ReturnType<typeof installAccountMutationsBeforeForward>>, mutant: string) {
  return transaction(store.owner, async db => {
    await db.query(mutant);
    // The disposable owner session can differ from the installed provider definer.
    const { rows } = await db.query<{ statement: string }>(`SELECT format(
      'ALTER FUNCTION public.${providerOpener}(text,uuid,text,bigint,text,jsonb,timestamptz) OWNER TO %I',
      pg_get_userbyid(proowner)) AS statement FROM pg_proc WHERE oid=$1::regprocedure`, [signatures[1]]);
    await db.query(rows[0]!.statement);
    await db.query("SET LOCAL ROLE service_role");
    await expect(check(db)).rejects.toThrow(/expected|promise rejected/iu);
  }, "ROLLBACK");
}

it.each(["bootstrap", "admin-managed"] as const)("upgrades the qualified %s profile and keeps both incumbent replay protocols", async profile => {
  const store = await installAccountMutationsBeforeForward(manifest, forward.file, profile, "payment-entry-upgrade");
  const { owner, runtime } = store;
  try {
    await assertRuntime(store);
    expect((await owner.query("SELECT to_regclass('public.commerce_order_draft_receipts_v2') AS receipt_table")).rows[0]?.receipt_table)
      .toBe("commerce_order_draft_receipts_v2");
    const attrs = await routineAttributes(owner);
    expect(attrs).toHaveLength(2);
    expect(attrs[0]).toMatchObject({ acl: null, prosecdef: false, proconfig: ["search_path=public, pg_catalog, pg_temp"], provolatile: "v",
      pronargdefaults: 2, defaults: "'{}'::jsonb, now()" });
    expect(attrs[1]).toMatchObject({ prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"], provolatile: "v",
      pronargdefaults: 0, defaults: null });

    const sku = await seedSku(owner);
    const versioned = async (): Promise<Order> => {
      const evidence = await issue(store, sku, false);
      const { id } = await transaction(owner, db => write(db, evidence, sku));
      const { rows: [order] } = await owner.query("SELECT money_version, status FROM public.commerce_orders WHERE id=$1", [id]);
      expect(order).toStrictEqual({ money_version: version, status: "pending_payment" });
      return { id, amount: evidence.quote.payableMinor, currency: evidence.quote.currency };
    };
    const fresh = await versioned(), attach = await versioned(), withProvider = await versioned();
    const attachedOrder = await versioned(), closedOrder = await versioned();
    const openingKey = "predecessor-opening", receiptKey = "predecessor-provider";
    const original = await open(runtime, attach, openingKey);
    expect(original).toMatchObject({ outcome: "opened", replayed: false,
      settlement: { orderId: attach.id, status: "created", externalRef: null, failureReason: null } });
    const { rows: [failure] } = await runtime.query<{ result: Settlement }>(
      "SELECT public.commerce_record_settlement($1,$2,'failed',$3,$4,$5) AS result",
      ["predecessor-failure", original.settlement.id, "attempt-reference", { reason: "method declined" }, at],
    );
    const failed = failure!.result;
    expect(failed.transitionId).not.toBe(original.transitionId);
    expect(failed).toMatchObject({ outcome: "failed", replayed: false,
      settlement: { status: "failed", externalRef: "attempt-reference", failureReason: "method declined" } });
    expect((await owner.query("SELECT status FROM public.commerce_orders WHERE id=$1", [attach.id])).rows)
      .toStrictEqual([{ status: "pending_payment" }]);
    const originalPayment = await create(runtime, withProvider, receiptKey);
    expect(originalPayment).toMatchObject({ contractVersion: "commerce.v0",
      paymentIntent: { orderId: withProvider.id, replayed: false } });
    expect((await owner.query("SELECT response_payload FROM public.payment_provider_receipts WHERE idempotency_key=$1", [receiptKey])).rows)
      .toStrictEqual([{ response_payload: originalPayment }]);

    const attachedOpeningKey = "attached-order-opening", attachedReceiptKey = "attached-order-provider";
    const attachedOpening = await open(runtime, attachedOrder, attachedOpeningKey);
    const attachedProvider = await create(runtime, attachedOrder, attachedReceiptKey);
    expect(attachedProvider.paymentIntent).toMatchObject({ id: attachedOpening.settlement.id, orderId: attachedOrder.id, replayed: false });
    await owner.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [closedOrder.id]);

    const transitionRequest = "occupied-provider-transition";
    const transitionKey = transitionRequest + ":intent_created";
    await owner.query(`INSERT INTO public.payment_provider_transitions
      (settlement_intent_id,transition_kind,to_status,reason,idempotency_key)
      VALUES ($1,'intent','created','retained transition',$2),
             ($1,'intent','created','retained transition',$3)`,
    [attachedOpening.settlement.id, transitionKey, openingKey + ":intent_created"]);
    const pendingReceipt = "pending-provider-receipt";
    await owner.query(`INSERT INTO public.payment_provider_receipts(scope,idempotency_key,request_fingerprint,status)
      VALUES ('commerce.payment_intent.create',$1,'retained request','in_progress')`, [pendingReceipt]);

    const openerReplay = async (db: Db) => {
      const retry = open(db, { ...attach, amount: attach.amount + 1, currency: "ZZZ" }, openingKey,
        { channel: "alternate_rail", metadata: { note: "changed retry" } });
      await expect(retry).resolves.toStrictEqual({ ...original, replayed: true, settlement: failed.settlement });
    };
    const providerReplay = async (db: Db) => {
      await expect(create(db, withProvider, receiptKey)).resolves.toStrictEqual(receiptReplay(originalPayment));
    };
    const openerConflict = async (db: Db) => expectError(await rejected(open(db, attach, "different-opening")),
      "23505", "commerce_settlement_open_order_already_has_intent");
    const providerConflict = async (db: Db) => expectError(await rejected(create(db, withProvider, receiptKey, "alternate_rail")),
      "23505", "payment_control_intent_idempotency_conflict");
    const fences = [
      (db: Db) => expectFence(open(db, fresh, "fresh-opener"), opener),
      (db: Db) => expectFence(create(db, fresh, "fresh-provider"), provider),
      (db: Db) => expectFence(create(db, attach, "fresh-attach"), provider),
    ];
    const unchanged = async (calls: ((db: Db) => Promise<void>)[]) => {
      const before = await paymentFacts(owner);
      for (const call of calls) {
        await call(runtime);
        expect(await paymentFacts(owner)).toStrictEqual(before);
      }
    };
    const crossOrderOpening = (db: Db) => expectOccupiedOpening(open(db, fresh, openingKey), openingKey);
    const crossOrderProviderOpening = (db: Db) => expectOccupiedOpening(create(db, fresh, openingKey), openingKey);
    const crossOrderProviderReceipt = async (db: Db) => expectError(await rejected(create(db, fresh, receiptKey)),
      "23505", "payment_control_intent_idempotency_conflict");
    const attachedConflict = async (db: Db) => expectError(await rejected(create(db, attachedOrder, attachedOpeningKey)),
      "23505", "payment_control_intent_order_already_has_intent");
    const attachedWithUnusedKey = async (db: Db) => expectError(await rejected(create(db, withProvider, "unused-provider-key")),
      "23505", "payment_control_intent_order_already_has_intent");
    const existingPaymentMismatch = async (db: Db) => expectError(await rejected(create(db, attachedOrder, attachedOpeningKey, "alternate_rail")),
      "22023", "payment_control_intent_existing_payment_mismatch");
    const attachedReplay = async (db: Db) => {
      await expect(create(db, attachedOrder, attachedReceiptKey)).resolves.toStrictEqual(receiptReplay(attachedProvider));
    };
    const transitionConflict = (db: Db) => expectOccupiedKey(create(db, fresh, transitionRequest),
      "payment_provider_transitions", "idempotency_key", transitionKey);
    const attachTransitionConflict = (db: Db) => expectOccupiedKey(create(db, attach, transitionRequest),
      "payment_provider_transitions", "idempotency_key", transitionKey);
    const inProgressConflict = async (db: Db) => expectError(await rejected(create(db, fresh, pendingReceipt)),
      "23505", "payment_control_intent_idempotency_conflict");
    const validation = [
      async (db: Db) => expectError(await rejected(open(db, { ...fresh, amount: fresh.amount + 1 }, openingKey)),
        "22023", "commerce_settlement_open_amount_mismatch"),
      async (db: Db) => expectError(await rejected(open(db, closedOrder, openingKey)),
        "22023", "commerce_settlement_open_order_not_payable"),
      async (db: Db) => expectError(await rejected(create(db, { ...fresh, amount: fresh.amount + 1 }, openingKey)),
        "22023", "payment_control_intent_order_amount_mismatch"),
      async (db: Db) => expectError(await rejected(create(db, closedOrder, openingKey)),
        "22023", "payment_control_intent_order_not_payable"),
      async (db: Db) => expectError(await rejected(create(db, fresh, "      a ")),
        "22023", "commerce_settlement_open_invalid_input"),
      async (db: Db) => expectError(await rejected(create(db, fresh, transitionRequest, "a".repeat(65))),
        "22023", "commerce_settlement_open_invalid_input"),
    ];
    const incumbent = [openerReplay, openerConflict, providerReplay, providerConflict];
    const occupied = [crossOrderOpening, crossOrderProviderOpening, crossOrderProviderReceipt, attachedConflict,
      attachedWithUnusedKey, existingPaymentMismatch, attachedReplay, transitionConflict, attachTransitionConflict, inProgressConflict];
    await unchanged([...incumbent, ...occupied, ...validation]);

    // Temporarily disabled each fresh guard in a disposable database.
    const noOpenerFence = sql.replace(openerGuard, "");
    await showMutationFailure(fences[0]!, store, noOpenerFence);
    const noProviderFence = sql.replace(providerGuard, "");
    for (const check of fences.slice(1)) await showMutationFailure(check, store, noProviderFence);

    // Temporarily disabled replay and conflict precedence in a disposable database.
    const openerStart = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${opener}(`);
    expect(openerStart).toBeGreaterThan(0);
    const earlyOpener = sql.slice(0, openerStart) + sql.slice(openerStart).replace(openerGuard, "")
      .replace("  SELECT * INTO v_intent\n", openerGuard + "  SELECT * INTO v_intent\n");
    const receiptLookup = " SELECT * INTO receipt FROM public.payment_provider_receipts";
    const earlyProvider = sql.replace(providerGuard, "").replace(receiptLookup, providerGuard + receiptLookup);
    for (const check of incumbent.slice(0, 2)) await showMutationFailure(check, store, earlyOpener);
    for (const check of incumbent.slice(2)) await showMutationFailure(check, store, earlyProvider);
    await showMutationFailure(attachedConflict, store, earlyProvider);

    await showMutationFailure(crossOrderOpening, store, earlyOpener);
    await showMutationFailure(crossOrderProviderOpening, store, earlyProvider);
    await showMutationFailure(transitionConflict, store, earlyProvider);

    expect((await store.runner.apply()).applied[0]).toBe(forward.file);
    expect(await routineAttributes(owner)).toStrictEqual(attrs);
    await unchanged([...incumbent, ...occupied, ...validation, ...fences]);
    expectError(await rejected(runtime.query(
      `SELECT public.${providerOpener}($1,$2,$3,$4,$5,$6,$7)`,
      ["direct-private-opener", fresh.id, channel, fresh.amount, fresh.currency, {}, at],
    )), "42501", `permission denied for function ${providerOpener}`);


    const { rows: [client] } = await owner.query("SELECT client_id FROM public.commerce_orders WHERE id=$1", [fresh.id]);
    const legacyOrder = async (): Promise<Order> => {
      const order = { id: randomUUID(), amount: 100, currency };
      await owner.query(`WITH created AS (
        INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor)
        VALUES($1,$2,'pending_payment',$3,$4) RETURNING id
      )
      INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
      SELECT id,$5,1,1,$4,$4 FROM created`, [order.id, client!.client_id, order.currency, order.amount, sku.id]);
      return order;
    };
    const attachLegacy = await legacyOrder(), createLegacy = await legacyOrder();
    await unchanged([
      async db => expectError(await rejected(open(db, { ...attachLegacy, amount: 99 }, "legacy-opening")),
        "22023", "commerce_settlement_open_amount_mismatch"),
      async db => expectError(await rejected(create(db, { ...createLegacy, amount: 99 }, "legacy-provider")),
        "22023", "payment_control_intent_order_amount_mismatch"),
      async db => expectError(await rejected(open(db, fresh, "short")), "22023", "commerce_settlement_open_invalid_input"),
      async db => expectError(await rejected(create(db, fresh, "short")), "22023", "payment_control_intent_invalid_input"),
    ]);
    const legacyIntent = await open(runtime, attachLegacy, "legacy-opening");
    expect(legacyIntent).toMatchObject({ outcome: "opened", replayed: false,
      settlement: { orderId: attachLegacy.id, status: "created", amountMinor: 100, currencyCode: currency } });
    await unchanged([
      async db => expectError(await rejected(create(db, attachLegacy, "legacy-attach", "alternate_rail")),
        "22023", "payment_control_intent_existing_payment_mismatch"),
    ]);
    const attached = await create(runtime, attachLegacy, "legacy-attach");
    expect(attached.paymentIntent).toMatchObject({ id: legacyIntent.settlement.id, orderId: attachLegacy.id, replayed: false });
    const created = await create(runtime, createLegacy, "legacy-provider");
    expect(created.paymentIntent).toMatchObject({ orderId: createLegacy.id, amountMinor: 100, currency, replayed: false });
    const facts = await paymentFacts(owner);
    expect(paymentRelations.map(table => facts[table]?.length)).toStrictEqual([5, 6, 4, 6, 5]);
    await unchanged([
      async db => { expect(await open(db, attachLegacy, "legacy-opening")).toStrictEqual({ ...legacyIntent, replayed: true }); },
      async db => { expect(await create(db, attachLegacy, "legacy-attach")).toStrictEqual(receiptReplay(attached)); },
      async db => { expect(await create(db, createLegacy, "legacy-provider")).toStrictEqual(receiptReplay(created)); },
      async db => expectError(await rejected(create(db, createLegacy, "legacy-provider-unused")),
        "23505", "payment_control_intent_order_already_has_intent"),
    ]);
    await fenceWithinSavepoint(store, opener, fresh, open);
    await fenceWithinSavepoint(store, provider, fresh, create);
    await fenceWithinSavepoint(store, provider, attach, create);

    // Reserve each key on another order while the versioned contender holds an older snapshot.
    for (const finish of ["COMMIT", "ROLLBACK"] as const) {
      for (const [routine, call] of [[opener, open], [provider, create]] as const) {
        const otherOrder = await legacyOrder();
        const key = `concurrent-opening-${randomUUID()}`;
        await concurrentKeyReservation(store, finish, db => open(db, otherOrder, key), db => call(db, fresh, key),
          run => finish === "COMMIT" ? expectOccupiedOpening(run, key) : expectFence(run, routine));
      }
      const otherOrder = await legacyOrder();
      await open(runtime, otherOrder, `separate-opening-${randomUUID()}`);
      const key = `concurrent-provider-${randomUUID()}`;
      await concurrentKeyReservation(store, finish, db => create(db, otherOrder, key), db => create(db, fresh, key),
        run => finish === "COMMIT"
          ? expectOccupiedKey(run, "payment_provider_transitions", "idempotency_key", key + ":intent_created")
          : expectFence(run, provider));
    }
  } finally { await store.close(); }
}, postgresSetupTimeoutMs);
