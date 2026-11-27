import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseError, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { boundOneTimePurchase } from "./acquisitionAdmissionFixture.js";
import { actorId, hash, installPublicationActors, json, transaction } from "./catalogPublicationFixture.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer, owner: Pool, installer: Pool, runtime: Pool;
const installation = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres",
  migrationLogin: "postgres", runtimeLogin: "price_edit_runtime", restoreLogin: "price_edit_restore" } as const;
const absent = { entryId: null, unitPriceMinor: null, amountKind: null };
const list = randomUUID();
const invalid = { outcome: "validation_issue", reason: "command_invalid" };

beforeAll(async () => {
  const password = randomUUID();
  container = await runPostgresContainer({ name: `basis-writer-${process.pid}`, password });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Price writer proof needs PostgreSQL");
  owner = new Pool({ connectionString: container.connectionString });
  for (const login of [installation.runtimeLogin, installation.restoreLogin]) {
    await owner.query(`CREATE ROLE ${login} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
  }
  installer = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(installation) });
  await createPostgresMigrationRunner({ connectionString: container.connectionString }, { installation, poolFactory: () => installer }).apply();
  const url = new URL(container.connectionString);
  url.username = installation.runtimeLogin;
  runtime = new Pool({ connectionString: url.toString() });
  expect((await runtime.query("SELECT session_user AS login")).rows).toEqual([{ login: installation.runtimeLogin }]);
  await installPublicationActors(owner);
  await owner.query(readFileSync("tests/postgres/fixtures/catalogPricePublicationV2/grants.sql", "utf8"));
  await owner.query(`INSERT INTO public.commerce_settings(key,value_text)
    VALUES('settlement_region','ZZ'),('settlement_currency','XXX')
    ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`);
  await owner.query("SELECT public.commerce_capture_offer_policy_v2_legacy_baseline()");
  await owner.query(`INSERT INTO public.price_lists(id,name,region_code,currency,amount_basis,valid_from)
    VALUES($1,'Test list','ZZ','XXX','tax_inclusive',clock_timestamp()-interval '1 hour')`, [list]);
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, [runtime, installer, owner].filter(Boolean)), postgresTeardownTimeoutMs);

async function seedSku(base = true) {
  const sku = randomUUID(), entry = randomUUID();
  await transaction(owner, async db => {
    const product = (await db.query(`INSERT INTO public.catalog_products(slug,name) VALUES($1,'Example') RETURNING id`, [sku])).rows[0].id;
    await db.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1::uuid,$2,$1::uuid::text,'Example')`, [sku, product]);
    if (base) await db.query(`INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,unit_price_minor,valid_from)
      VALUES($1,$2,$3,'one_time',150,clock_timestamp()-interval '1 hour'),
        (gen_random_uuid(),$2,$3,'subscription',125,clock_timestamp()-interval '1 hour')`, [entry, list, sku]);
  });
  return { schemaVersion: 2, commandKey: randomUUID(), variantId: sku, priceListId: list, mode: "one_time",
    minQty: 1, amountKind: "gross", expectedListAmountBasis: "tax_inclusive", unitPriceMinor: 180,
    expected: base ? { entryId: entry, unitPriceMinor: 150, amountKind: "gross" } : absent };
}
async function authenticated(db: PoolClient) {
  await db.query("SET LOCAL ROLE authenticated");
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actorId, role: "authenticated" })]);
}
async function sqlApply(db: PoolClient, input: unknown, encode = json) {
  const text = encode(input);
  return (await db.query("SELECT public.catalog_price_setup_apply($1,$2) AS result", [text, hash(text)])).rows[0].result;
}
const apply = (input: unknown) => transaction(runtime, async db => { await authenticated(db); return sqlApply(db, input); });
const receipts = async (key: string) => (await owner.query(`SELECT status,metadata,response_payload FROM public.catalog_price_setup_receipts
  WHERE scope='catalog.price_setup.base' AND idempotency_key=$1`, [key])).rows;
const current = async (sku: string) => (await owner.query(`SELECT id,unit_price_minor FROM public.price_entries
  CROSS JOIN (SELECT clock_timestamp() AS at) t
  WHERE variant_id=$1 AND mode='one_time' AND active AND valid_from<=at
    AND (valid_to IS NULL OR valid_to>at)`, [sku])).rows;

function exactSqlError(error: unknown, message: string, code: string, detail?: string) {
  expect(error).toBeInstanceOf(DatabaseError);
  expect(Object.getPrototypeOf(error)).toBe(DatabaseError.prototype);
  expect((error as DatabaseError).message).toBe(message);
  expect((error as DatabaseError).code).toBe(code);
  expect((error as DatabaseError).detail).toBe(detail);
  expect(Reflect.ownKeys(error as Error).filter(key => key !== "stack" && key !== "message").sort()).toEqual([
    "code", "column", "constraint", "dataType", "detail", "file", "hint", "internalPosition", "internalQuery", "length",
    "line", "name", "position", "routine", "schema", "severity", "table", "where",
  ].sort());
}

it("validates both closed key sets and canonical bytes as the runtime login", async () => {
  const command = await seedSku();
  for (const malformed of [{ ...command, forbidden: 1 }, { ...command, expected: { ...command.expected, forbidden: 1 } },
    { ...command, commandKey: "🙂".repeat(121) }, { ...command, commandKey: "\uFEFFkey" }]) {
    expect(await apply(malformed)).toEqual(invalid);
    expect(await receipts(malformed.commandKey)).toEqual([]);
  }
  await transaction(runtime, async db => {
    await authenticated(db);
    for (const encode of [(x: unknown) => " " + json(x), (x: unknown) => json(x).replace('"minQty":1','"minQty":1.0'),
      (x: unknown) => json(x).replace('"minQty":1','"minQty":1,"minQty":1')]) {
      expect(await sqlApply(db, command, encode)).toEqual(invalid);
    }
  });
  for (const [input, path] of [[{ ...command, unitPriceMinor: 2147483648 }, "unitPriceMinor"],
    [{ ...command, expected: { ...command.expected, unitPriceMinor: -1 } }, "expected.unitPriceMinor"]] as const) {
    expect(await apply(input)).toEqual({ outcome: "validation_issue", reason: "money_amount_out_of_range", path });
  }
  expect(await receipts(command.commandKey)).toEqual([]);
  expect(await apply({ ...command, commandKey: "🙂".repeat(120) })).toMatchObject({ outcome: "committed" });
});

it("refuses NOWAIT without a receipt, then commits and replays the same command", async () => {
  const command = await seedSku();
  await transaction(owner, async peer => {
    await peer.query("LOCK TABLE public.price_entries IN ROW EXCLUSIVE MODE");
    const result = await apply(command).catch((error: unknown) => error);
    exactSqlError(result, 'could not obtain lock on relation "public.price_entries"', "55P03");
    expect(await receipts(command.commandKey)).toEqual([]);
  });
  const result = await apply(command);
  expect(result).toMatchObject({ outcome: "committed", receipt: {
    amountBasis: "tax_inclusive", previous: command.expected, current: { amountKind: "gross", unitPriceMinor: 180 },
  } });
  expect(await receipts(command.commandKey)).toEqual([{ status: "completed", response_payload: result,
    metadata: { actorId, variantId: command.variantId, priceListId: list } }]);
  expect(await apply(command)).toEqual({ ...result, outcome: "replayed" });
  const { expectedListAmountBasis: _basis, ...gross } = command;
  expect(await apply({ ...gross, schemaVersion: 1, expected: {
    entryId: gross.expected.entryId, unitPriceMinor: gross.expected.unitPriceMinor,
  } })).toEqual({ outcome: "conflict", reason: "command_key_reused" });
});

async function waitOnAdvisory(peer: PoolClient, pid: number) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const { rows } = await peer.query("SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) AS blocked", [pid]);
    if (rows[0].blocked) return;
    await peer.query("SELECT pg_sleep(0.01)");
  }
  throw new Error("The price writer did not wait on the held advisory key");
}

async function applyAfterAdvisoryWait(command: Awaited<ReturnType<typeof seedSku>>, release: (peer: PoolClient) => Promise<void>) {
  const writer = await runtime.connect(), peer = await owner.connect();
  let pending: ReturnType<typeof sqlApply> | undefined;
  try {
    await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await authenticated(writer);
    const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await peer.query("BEGIN");
    await peer.query("SELECT public.catalog_price_setup_lock_context($1,$2)", [list, command.variantId]);
    pending = sqlApply(writer, command);
    void pending.catch(() => undefined);
    await waitOnAdvisory(peer, pid);
    await release(peer);
    const { rows: [{ at }] } = await peer.query("SELECT clock_timestamp()::text AS at");
    await peer.query("COMMIT");
    const result = await pending;
    await writer.query("COMMIT");
    return { result, at };
  } finally {
    await peer.query("ROLLBACK");
    await pending?.catch(() => undefined);
    await writer.query("ROLLBACK");
    peer.release(); writer.release();
  }
}

it("commits an inclusive replacement after a real advisory wait and uses one post-wait instant", async () => {
  const command = await seedSku();
  expect((await owner.query("SELECT public.commerce_offer_policy_v2_readiness()->'reasons' AS reasons")).rows[0].reasons)
    .not.toContain("catalog_1490_legacy_1340_invalid");
  const { result, at } = await applyAfterAdvisoryWait(command, async peer => { await peer.query("SELECT pg_sleep(0.02)"); });
  expect(result).toMatchObject({ outcome: "committed" });
  expect((await owner.query(`SELECT old.valid_to=new.valid_from AS same, new.valid_from >= $3::timestamptz AS after_wait
    FROM public.price_entries old,public.price_entries new WHERE old.id=$1 AND new.id=$2`,
  [command.expected.entryId, result.receipt.current.entryId, at])).rows).toEqual([{ same: true, after_wait: true }]);
});

it("observes a peer commit in the advisory wait even when the predecessor amount is unchanged", async () => {
  const command = await seedSku();
  const { result } = await applyAfterAdvisoryWait(command, async peer => {
    await peer.query("UPDATE public.price_entries SET id=$1 WHERE id=$2", [randomUUID(), command.expected.entryId]);
  });
  expect(result).toEqual({ outcome: "conflict", reason: "expected_state_mismatch" });
  expect(await receipts(command.commandKey)).toEqual([]);
});

it("evaluates a predecessor window that expires during the advisory wait", async () => {
  const command = await seedSku();
  const { rows: [{ expires }] } = await owner.query(`UPDATE public.price_entries SET valid_to=clock_timestamp()+interval '1 second'
    WHERE id=$1 RETURNING valid_to::text AS expires`, [command.expected.entryId]);
  const { result } = await applyAfterAdvisoryWait(command, async peer => {
    await peer.query("SELECT pg_sleep_until($1::timestamptz)", [expires]);
  });
  expect(result).toEqual({ outcome: "conflict", reason: "expected_state_mismatch" });
  expect(await receipts(command.commandKey)).toEqual([]);
});

it.each([
  ["non-price gate delta", "UPDATE public.platform_job_controls SET enabled=false WHERE job_name='platform-watchdog'; RETURN NEW;",
    "promotion_watchdog_not_ready"],
  ["missing post-edit base", "RETURN NULL;", "catalog_publication_sku_price_not_ready"],
])("rolls back the edit when the %s refuses", async (_label, body, reason) => {
  const command = await seedSku();
  await owner.query(`INSERT INTO public.platform_job_controls(job_name,active_driver,last_status,last_success_at,metadata)
    VALUES('platform-watchdog','worker','success',clock_timestamp(),'{"promotionReady":true}')
    ON CONFLICT(job_name) DO UPDATE SET enabled=true, last_status='success',
      last_success_at=EXCLUDED.last_success_at,metadata=EXCLUDED.metadata`);
  const occupied = await boundOneTimePurchase(runtime,command.variantId,150);
  const before = await current(command.variantId);
  expect((await owner.query("SELECT public.commerce_offer_policy_v2_readiness()->'reasons' AS reasons")).rows[0].reasons)
    .not.toContain(reason);
  await owner.query(`CREATE FUNCTION public.price_test_refuse_edit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN ${body} END $$;
    CREATE TRIGGER price_test_refuse_edit BEFORE INSERT ON public.price_entries
    FOR EACH ROW EXECUTE FUNCTION public.price_test_refuse_edit()`);
  try {
    const error = await apply(command).catch((failure: unknown) => failure);
    exactSqlError(error, "catalog_price_setup_readiness_would_fail", "55000", JSON.stringify([reason]));
    expect(await current(command.variantId)).toEqual(before);
    expect(await receipts(command.commandKey)).toEqual([]);
    expect((await owner.query("SELECT enabled FROM public.platform_job_controls WHERE job_name='platform-watchdog'")).rows)
      .toEqual([{ enabled: true }]);
  } finally {
    await owner.query("DROP TRIGGER price_test_refuse_edit ON public.price_entries; DROP FUNCTION public.price_test_refuse_edit()");
    await owner.query("UPDATE public.commerce_orders SET created_at=now()-interval '25 hours' WHERE id=$1",[occupied]);
  }
});


it("commits and replays an exclusive core price with the legacy aggregate already present", async () => {
  const command = await seedSku(false), exclusive = randomUUID();
  await owner.query("UPDATE public.price_lists SET status='draft' WHERE id=$1", [list]);
  try {
    await owner.query(`INSERT INTO public.price_lists(id,name,region_code,currency,amount_basis,valid_from)
      VALUES($1,'Test exclusive list','ZZ','XXX','tax_exclusive',clock_timestamp()-interval '1 hour')`, [exclusive]);
    await owner.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,amount_kind,unit_price_minor,valid_from)
      VALUES($1,$2,'subscription','net',125,'-infinity')`, [exclusive, command.variantId]);
    const aggregate = () => owner.query(`SELECT public.commerce_offer_policy_v2_readiness()->'reasons'
      ? 'catalog_1490_legacy_1340_invalid' AS present`);
    expect((await aggregate()).rows).toEqual([{ present: true }]);
    const net = { ...command, priceListId: exclusive, expectedListAmountBasis: "tax_exclusive", amountKind: "net" };
    expect(await apply({ ...net, amountKind: "gross" })).toEqual({ outcome: "validation_issue", reason: "catalog_price_setup_basis_mismatch" });
    expect(await receipts(net.commandKey)).toEqual([]);
    const result = await apply(net);
    expect(result).toMatchObject({ outcome: "committed", receipt: { amountBasis: "tax_exclusive", previous: null, current: { amountKind: "net" } } });
    expect(await apply(net)).toEqual({ ...result, outcome: "replayed" });
    const target = { skuId: command.variantId, requiredModes: ["one_time"],
      skuFacts: { status: "active", isAddon: false, sellableStandalone: true, sellableInSubscription: false } };
    expect((await owner.query(`SELECT public.catalog_publication_target_price_verdict($1,statement_timestamp()) AS result`,
      [{ targets: [target] }])).rows[0].result).toMatchObject({ amountBasis: "tax_exclusive",
      targets: [{ skuId: command.variantId, reason: null, observations: { subscriptionReady: true } }] });
    expect((await aggregate()).rows).toEqual([{ present: true }]);
  } finally {
    await owner.query("UPDATE public.price_lists SET status='draft' WHERE id=$1", [exclusive]);
    await owner.query("UPDATE public.price_lists SET status='active' WHERE id=$1", [list]);
  }
});

async function priceEffects(variantId: string, db: Pool | PoolClient = owner) {
  return (await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.price_entries e WHERE e.variant_id=$1) AS entries,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.idempotency_key) FROM public.catalog_price_setup_receipts r
      WHERE r.metadata->>'variantId'=$1::uuid::text) AS receipts`, [variantId])).rows;
}

it.each([
  ["catalog_price_setup_pending_entry", "future"],
  ["expected_state_mismatch", "amount"],
  ["expected_state_mismatch", "kind"],
  ["price_shape_invalid", "shape"],
  ["base_price_amount_kind_invalid", "stored-kind"],
  ["active_price_list_ambiguous", "list"],
] as const)("leaves all price effects unchanged for %s (%s)", async (reason, variant) => {
  const command = await seedSku(), other = randomUUID();
  if (variant === "future") await owner.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
    VALUES($1,$2,'one_time',200,clock_timestamp()+interval '1 day')`, [list, command.variantId]);
  if (variant === "amount") command.expected.unitPriceMinor = 151;
  if (variant === "kind") command.expected.amountKind = "net";
  if (variant === "shape") await owner.query("UPDATE public.price_entries SET min_qty=2 WHERE id=$1", [command.expected.entryId]);
  if (variant === "stored-kind") await owner.query("UPDATE public.price_entries SET min_qty=2,amount_kind='net' WHERE id=$1", [command.expected.entryId]);
  if (variant === "list") await owner.query(`INSERT INTO public.price_lists(id,name,region_code,currency,valid_from)
    VALUES($1,'Overlapping list','ZZ','XXX',clock_timestamp()-interval '1 hour')`, [other]);
  try {
    const before = await priceEffects(command.variantId);
    expect(await apply(command)).toEqual({ outcome: reason === "expected_state_mismatch" ? "conflict" : "validation_issue", reason });
    expect(await priceEffects(command.variantId)).toEqual(before);
  } finally {
    if (variant === "list") await owner.query("DELETE FROM public.price_lists WHERE id=$1", [other]);
  }
});

async function claimAsOwner(db: PoolClient, input: unknown) {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actorId, role: "authenticated" })]);
  const text = json(input);
  return (await db.query("SELECT public.catalog_price_setup_claim($1,$2) AS claim", [text, hash(text)])).rows[0].claim;
}

it("ignores a caller-selected v2 apply time even on the owner-only wrapper", async () => {
  const command = await seedSku();
  await transaction(owner, async db => {
    const claim = await claimAsOwner(db, command);
    const { rows: [result] } = await db.query(`SELECT public.catalog_price_setup_apply_claimed($1,clock_timestamp()+interval '1 day') AS result`, [claim]);
    expect(result.result).toMatchObject({ outcome: "committed", receipt: { current: { unitPriceMinor: 180 } } });
    expect((await db.query(`SELECT valid_from<=clock_timestamp() AS effective FROM public.price_entries
      WHERE id=$1`, [result.result.receipt.current.entryId])).rows).toEqual([{ effective: true }]);
  });
});

it("refuses to close a predecessor starting exactly at the locked PG instant", async () => {
  const command = await seedSku();
  const original = await priceEffects(command.variantId);
  const writer = await owner.connect(), peer = await owner.connect();
  let wait: Promise<unknown> | undefined;
  try {
    await writer.query("BEGIN");
    const claim = await claimAsOwner(writer, command);
    await peer.query("BEGIN");
    await peer.query("SELECT public.catalog_price_setup_lock_context($1,$2)", [list, command.variantId]);
    const { rows: [{ pid }] } = await writer.query("SELECT pg_backend_pid() AS pid");
    wait = writer.query("SELECT public.catalog_price_setup_lock_context($1,$2)", [list, command.variantId]);
    void wait.catch(() => undefined);
    await waitOnAdvisory(peer, pid);
    await peer.query("COMMIT");
    await wait;
    await writer.query("LOCK TABLE public.commerce_settings,public.price_lists,public.subscription_price_policy_revisions IN SHARE MODE NOWAIT");
    await writer.query("LOCK TABLE public.price_entries IN SHARE ROW EXCLUSIVE MODE NOWAIT");
    const { rows: [{ at }] } = await writer.query(`UPDATE public.price_entries SET valid_from=clock_timestamp()
      WHERE id=$1 RETURNING valid_from::text AS at`, [command.expected.entryId]);
    const before = await priceEffects(command.variantId, writer);
    const { rows: [{ result }] } = await writer.query("SELECT public.catalog_price_setup_mutate_claimed($1,$2,NULL) AS result", [claim, at]);
    expect(result).toEqual({ outcome: "validation_issue", reason: "catalog_price_setup_pending_entry" });
    expect(await priceEffects(command.variantId, writer)).toEqual([{ entries: before[0].entries, receipts: null }]);
  } finally {
    await peer.query("ROLLBACK");
    await wait?.catch(() => undefined);
    await writer.query("ROLLBACK");
    peer.release(); writer.release();
  }
  expect(await priceEffects(command.variantId)).toEqual(original);
});

it("requires issuance for a fresh approval-bound writer call", async () => {
  const command = await seedSku();
  const before = await priceEffects(command.variantId);
  const text = json(command);
  await transaction(owner, async db => {
    await db.query("SET LOCAL ROLE openlup_catalog_publication");
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actorId, role: "authenticated" })]);
    const { rows: [{ result }] } = await db.query("SELECT public.catalog_price_setup_apply_v2($1,$2,$3) AS result",
      [text, hash(text), randomUUID()]);
    expect(result).toEqual({ outcome: "validation_issue", reason: "catalog_publication_price_issue_required" });
  });
  expect(await priceEffects(command.variantId)).toEqual(before);
});

it("applies with a bound captured purchase and preserves the completed receipt under a fresh hard refusal", async () => {
  const command = await seedSku();
  const id = await boundOneTimePurchase(runtime,command.variantId,150);
  try {
    const first = await apply(command);
    expect(first).toMatchObject({outcome:"committed",receipt:{current:{unitPriceMinor:180}}});
    const saved = await receipts(command.commandKey);
    await owner.query("UPDATE public.outbox_events SET metadata=metadata-'boundary' WHERE aggregate_id=$1 AND event_type='commerce.order_draft.created'",[id]);
    const fresh = { ...command,commandKey:randomUUID(),expected:{entryId:first.receipt.current.entryId,unitPriceMinor:180,amountKind:"gross"} };
    await expect(apply(fresh)).rejects.toMatchObject({ code:"55000",message:"catalog_price_setup_native_order_guard_unverified" });
    expect(await apply(command)).toEqual({ ...first,outcome:"replayed" });
    expect(await receipts(command.commandKey)).toEqual(saved);
    expect(await receipts(fresh.commandKey)).toEqual([]);
  } finally {
    await owner.query("UPDATE public.commerce_orders SET created_at=now()-interval '25 hours' WHERE id=$1",[id]);
  }
});
