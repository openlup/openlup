import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { expect, it } from "vitest";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { installAccountMutationsBeforeForward } from "./customerAccountMutations.fixture.js";
import { assertRuntime } from "./orderDraftReceiptsV2.fixture.js";
import { issue, write } from "./orderMoneyV2Guards.fixture.js";
import { expectSqlError, rejected, seedSku, transaction, version } from "./orderMoneyV2Storage.fixture.js";

type Db = Pool | PoolClient;
const opener = "commerce_open_settlement_intent";
const provider = "payment_provider_intent_create";
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

const openerOccupied = `    IF EXISTS (SELECT FROM public.commerce_settlement_intents WHERE open_idempotency_key = p_idempotency_key)
    THEN
      RAISE unique_violation USING
        MESSAGE = 'duplicate key value violates unique constraint "commerce_settlement_intents_open_idempotency_key_key"',
        DETAIL = format('Key (open_idempotency_key)=(%s) already exists.', p_idempotency_key),
        SCHEMA = 'public', TABLE = 'commerce_settlement_intents',
        CONSTRAINT = 'commerce_settlement_intents_open_idempotency_key_key';
    END IF;
`;
const providerOpenGuard = `  -- For a versioned order, invoke the opener only when its own validation or
  -- occupied key would refuse first. Otherwise check the provider key below.
  IF o.money_version IS NULL OR char_length(btrim(p_idempotency_key)) < 8 OR char_length(p_channel_key) > 64
    OR EXISTS (SELECT FROM public.commerce_settlement_intents WHERE open_idempotency_key = p_idempotency_key)
  THEN
`;
const providerOpenEnd = "  END IF;\n";
const providerOccupied = `   IF EXISTS (SELECT FROM public.payment_provider_transitions WHERE idempotency_key = p_idempotency_key||':intent_created')
   THEN
     RAISE unique_violation USING
       MESSAGE = 'duplicate key value violates unique constraint "payment_provider_transitions_idempotency_key_key"',
       DETAIL = format('Key (idempotency_key)=(%s) already exists.', p_idempotency_key||':intent_created'),
       SCHEMA = 'public', TABLE = 'payment_provider_transitions',
       CONSTRAINT = 'payment_provider_transitions_idempotency_key_key';
   END IF;
`;

const openerGuard = `  IF v_order.money_version IS NOT NULL AND p_requested_at IS NOT NULL THEN
${openerOccupied}    RAISE EXCEPTION '${refusal}' USING ERRCODE = '22023',
      DETAIL = '${field}',
      HINT = '${hint}';
  END IF;

`;
const providerGuard = ` IF o.money_version IS NOT NULL THEN
${providerOccupied}   RAISE EXCEPTION '${refusal}' USING ERRCODE = '22023',
     DETAIL = '${field}',
     HINT = '${hint}';
 END IF;
`;

const providerOpenCall = "  opened:=public.commerce_open_settlement_intent(p_idempotency_key,p_order_id,p_channel_key,p_amount_minor,p_currency,p_metadata,p_at);\n";
const providerReadIntent = "  SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=(opened#>>'{settlement,id}')::uuid;\n";
const sourcePins = [
  {
    name: opener,
    source: "db/platform/migrations/20260810180000_payment_settlement_rail.sql",
    guards: [{
      addition: openerGuard,
      before: "    RAISE EXCEPTION 'commerce_settlement_open_amount_mismatch' USING ERRCODE = '22023';\n  END IF;\n\n",
      after: "  INSERT INTO public.commerce_settlement_intents\n",
    }],
    hash: "1de48eef8ad18302ea5e35aab121322045723594e9857eac8dd1157967a6ca4f",
  },
  {
    name: provider,
    source: "db/platform/migrations/20261114100000_payment_provider_attempt_store.sql",
    guards: [
      { addition: providerOpenGuard, before: " ELSE\n", after: providerOpenCall },
      { addition: providerOpenEnd, before: providerReadIntent, after: " END IF;\n" },
      { addition: providerGuard, before: " END IF;\n", after: " INSERT INTO public.payment_provider_states(" },
    ],
    hash: "5f8d3f14b8f2eb791333ee5a7227bc33d54fd410d5d5730b5f0f65a819e28b02",
  },
];

function omitGuard(definition: string, { before, addition, after }: typeof sourcePins[number]["guards"][number]) {
  expect(definition.split(before + addition + after)).toHaveLength(2);
  return definition.replace(before + addition + after, before + after);
}

function assertBytes(forwardSql: string) {
  const definitions = [...forwardSql.matchAll(/^CREATE OR REPLACE FUNCTION public\.([a-z_]+)\([\s\S]*?^\$\$;\n/gmu)];
  expect(definitions.map(match => match[1])).toStrictEqual([opener, provider]);
  expect(definitions.map(match => match[0]).join("\n")).toBe(forwardSql);
  for (const [index, { name, source, guards, hash }] of sourcePins.entries()) {
    const definition = definitions[index]![0];
    let original = guards.reduce(omitGuard, definition).replace("CREATE OR REPLACE FUNCTION", "CREATE FUNCTION");
    if (name === opener) original = original.replace("SET search_path = public, pg_catalog, pg_temp", "SET search_path = public, pg_catalog");
    const landed = readFileSync(source, "utf8").match(new RegExp(
      `^CREATE FUNCTION public\\.${name}\\([\\s\\S]*?^\\$\\$;\\n`, "mu",
    ))?.[0];
    expect(landed).toBe(original);
    expect(sha256(original)).toBe(hash);
  }
}

it("pins both insertion anchors and preserves the incumbent source ranges byte for byte", () => {
  for (const { guards } of sourcePins) {
    for (const { before, addition, after } of guards) {
      // Temporarily moved an insertion anchor in a disposable forward string.
      expect(() => assertBytes(sql.replace(before + addition + after, addition + before + after))).toThrow();
    }
  }
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

const relations = ["commerce_settlement_intents", "commerce_settlement_transitions", "payment_provider_states",
  "payment_provider_transitions", "payment_provider_receipts"];
const paymentFacts = async (db: Db) => Object.fromEntries(await Promise.all(relations.map(async table => [
  table, (await db.query(`SELECT to_jsonb(fact)::text AS fact FROM public.${table} AS fact ORDER BY 1`)).rows,
])));

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
    const noFences = sourcePins[1]!.guards.reduce(omitGuard, noOpenerFence);
    for (const check of fences.slice(1)) await showMutationFailure(check, store, noFences);

    // Temporarily disabled replay and conflict precedence in a disposable database.
    const earlyOpener = sql.replace(openerGuard, "").replace("  SELECT * INTO v_intent\n", openerGuard + "  SELECT * INTO v_intent\n");
    const receiptLookup = " SELECT * INTO receipt FROM public.payment_provider_receipts";
    const earlyProvider = sql.replace(providerGuard, "").replace(receiptLookup, providerGuard + receiptLookup);
    for (const check of incumbent.slice(0, 2)) await showMutationFailure(check, store, earlyOpener);
    for (const check of incumbent.slice(2)) await showMutationFailure(check, store, earlyProvider);
    await showMutationFailure(attachedConflict, store, earlyProvider);

    await showMutationFailure(crossOrderOpening, store, sql.replace(openerOccupied, ""));
    const checkOpening = "    OR EXISTS (SELECT FROM public.commerce_settlement_intents WHERE open_idempotency_key = p_idempotency_key)\n";
    expect(providerOpenGuard).toContain(checkOpening);
    await showMutationFailure(crossOrderProviderOpening, store, sql.replace(providerOpenGuard, providerOpenGuard.replace(checkOpening, "")));
    await showMutationFailure(transitionConflict, store, sql.replace(providerOccupied, ""));

    expect((await store.runner.apply()).applied[0]).toBe(forward.file);
    expect(await routineAttributes(owner)).toStrictEqual(attrs);
    await unchanged([...incumbent, ...occupied, ...validation, ...fences]);

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
    expect(relations.map(table => facts[table]?.length)).toStrictEqual([5, 6, 4, 6, 5]);
    await unchanged([
      async db => { expect(await open(db, attachLegacy, "legacy-opening")).toStrictEqual({ ...legacyIntent, replayed: true }); },
      async db => { expect(await create(db, attachLegacy, "legacy-attach")).toStrictEqual(receiptReplay(attached)); },
      async db => { expect(await create(db, createLegacy, "legacy-provider")).toStrictEqual(receiptReplay(created)); },
      async db => expectError(await rejected(create(db, createLegacy, "legacy-provider-unused")),
        "23505", "payment_control_intent_order_already_has_intent"),
    ]);
  } finally { await store.close(); }
}, postgresSetupTimeoutMs);
