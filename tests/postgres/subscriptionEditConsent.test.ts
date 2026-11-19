import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import type { ClassicBundleEditRequest, SubscriptionEditConsent } from "@openlup/platform/subscriptions/contracts";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresClassicBundleEditor, createPostgresPackageEditor, createPostgresSizedEditor, createPostgresLegacyEditConsentBridge, type PackageEditorOptions, type SizedEditorOptions, type ExactSubscriptionEditRequest } from "@openlup/platform/subscriptions";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  type PostgresContainer } from "../helpers/postgresContainer.js";
let container: PostgresContainer | undefined, pool: Pool;
const money = (amountMinor: number) => ({ amountMinor,currency: "XXX" });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const rpc = async (db: Pool | PoolClient,name: string,args: unknown[]) => (await db.query(`SELECT public.${name}(${args.map((_,i) => `$${i+1}`).join(",")}) AS result`,args)).rows[0].result;
beforeAll(async () => {
  container = await runPostgresContainer({ name: `edit-consent-${process.pid}`,password: "synthetic-consent" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Edit consent requires PostgreSQL");
  pool = new Pool({ connectionString: container.connectionString });
  for (const role of ["service_role"]) await pool.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT NOBYPASSRLS`);
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json","utf8"));
  for (const unit of [manifest.baseline,...manifest.forward]) await pool.query(readFileSync(unit.file,"utf8"));
  await pool.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_minimum_base_units','1')");
},postgresSetupTimeoutMs);
afterAll(() => closePostgres(container,[pool]),postgresTeardownTimeoutMs);
async function fixture() {
  const priceList = randomUUID(),subscription = randomUUID(),client = randomUUID(),actor = randomUUID(),other = randomUUID(),sku = randomUUID();
  await pool.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)",[client,`${client}@example.invalid`,actor]);
  await pool.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Article')",[sku,`article-${sku}`]);
  await pool.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription) VALUES($1::uuid,$1::uuid,$1::text,'Article',true)",[sku]);
  await pool.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Synthetic','ZZ','XXX')",[priceList]);
  await pool.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor) VALUES($1,$2,'any',137)",[priceList,sku]);
  await pool.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,currency_code,composition_constraint,price_list_id) VALUES($1,$2,28,clock_timestamp()+interval '28 days','XXX',$3,$4)",[subscription,client,{ kind: "unit_count",value: 2,dailyNeed: 1 },priceList]);
  await pool.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,2,0,100,'XXX')",[subscription,sku]);
  await pool.query("INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref) VALUES($1,'XXX','synthetic','sandbox',clock_timestamp(),'synthetic')",[subscription]);
  await pool.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,$2,2,100)",[subscription,sku]);
  await pool.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')",[subscription]);
  const at = (await pool.query("SELECT clock_timestamp() AS at")).rows[0].at.toISOString() as string;
  return { subscription,client,actor,other,sku,at };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function record(f: Fixture,action = "update_package_template",snapshot: unknown = {},request: unknown = {},totals: unknown = {}) {
  const digest = hash(randomUUID());
  const expiry = (await pool.query("SELECT $1::timestamptz+interval '1 hour' AS at",[f.at])).rows[0].at;
  const preview = await rpc(pool,"subscription_quote_preview_record",[f.actor,f.client,f.subscription,action,digest,1,expiry,request,snapshot,totals,f.at]);
  return { digest,preview };
}
async function snapshot(f: Fixture) {
  const result: Record<string,unknown> = {};
  for (const table of ["subscriptions","subscription_lines","subscription_renewal_terms","subscription_renewal_term_lines","subscription_quote_previews","subscription_events","subscription_command_receipts"]) {
    const id = table === "subscriptions" ? "id" : "subscription_id";
    result[table] = (await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM public.${table} t WHERE ${id}=$1::uuid`,[f.subscription])).rows[0].rows;
  }
  return result;
}
it("edit_consent_shared_take_actor_equality",async () => {
  const f = await fixture(), q = await record(f), before = await snapshot(f);
  await expect(rpc(pool,"subscription_quote_preview_take",[f.other,f.client,f.subscription,"update_package_template",q.digest,1,"other-actor-key",f.at]))
    .rejects.toMatchObject({ message: "subscription_edit_quote_actor_mismatch",code: "22023" });
  expect(await snapshot(f)).toEqual(before);
  expect(await rpc(pool,"subscription_quote_preview_take",[f.actor,f.client,f.subscription,"update_package_template",q.digest,1,"same-actor-key",f.at])).toEqual(q.preview);
});
it("edit_consent_actor_id_always_recorded",async () => {
  const f = await fixture(), q = await record(f);
  expect(q.preview.actor_id).toBe(f.actor);
  expect((await pool.query("SELECT attnotnull FROM pg_attribute WHERE attrelid='public.subscription_quote_previews'::regclass AND attname='actor_id'")).rows[0].attnotnull).toBe(true);
  await expect(pool.query("UPDATE public.subscription_quote_previews SET actor_id=NULL WHERE id=$1",[q.preview.id])).rejects.toMatchObject({ code: "23502" });
  const expiry = (await pool.query("SELECT $1::timestamptz+interval '1 hour' AS at",[f.at])).rows[0].at;
  const args = [f.other,f.client,f.subscription,"update_package_template",q.digest,1,expiry,{},{},{},f.at];
  expect((await rpc(pool,"subscription_quote_preview_record",args)).actor_id).toBe(f.other);
  args[0] = null as never; await expect(rpc(pool,"subscription_quote_preview_record",args)).rejects.toMatchObject({ message: "subscription_command_invalid_input" });
});
async function lane(f: Fixture,name: "package" | "line" | "sized") {
  const action = name === "package" ? "update_package_template" : name === "line" ? "update_plan_length" : "resize_bundle";
  const core = [{ variantId: f.sku,qty: 2 }], constraint = { kind: "unit_count",value: 2,dailyNeed: 1 };
  const quoted = { variantId: f.sku,qty: 2,isAddon: false,lineId: null,sortOrder: 0,
    quoteLine: richLine(f.sku,2) };
  const request = name === "package" ? { planDays: 30,base: core,addons: [] } : name === "line" ? { action,planDays: 30 }
    : { action,cadenceDays: 30,compositionConstraint: constraint,resizeLever: { kind: "subscription.sized.parcel",value: { coreLines: core,optInToSized: true } } };
  const totals = { currentRecurringPrice: money(200),newRecurringPrice: money(274),delta: money(74) };
  const evidence = name === "package" ? { baseLines: [quoted],addonLines: [],compositionConstraint: constraint }
    : { lines: [quoted],cadenceDays: 30,compositionConstraint: constraint,...(name === "sized" ? { subjectFacts: { revision: 1 },optInFacts: { revision: 1 } } : {}) };
  const q = await record(f,action,evidence,request,totals), accepted = { ...request,acceptedQuoteHash: q.digest,expectedTemplateVersion: 1 };
  const payload = { ...accepted,request: accepted,...evidence,...totals };
  const invoke = (actor: string,key: string) => rpc(pool,`subscription_${name === "package" ? "package" : name === "line" ? "line" : "sized"}_edit_apply`,
    [actor,f.client,key,f.subscription,...(name === "line" ? [action] : []),payload,f.at]);
  return { invoke,q,payload };
}
it.each(["package","line","sized"] as const)("edit_consent_unwrapped_actor_equality[%s]",async name => {
  const f = await fixture(), edit = await lane(f,name), before = await snapshot(f);
  await expect(edit.invoke(f.other,"other-actor-apply")).rejects.toMatchObject({ message: "subscription_edit_quote_actor_mismatch",code: "22023" });
  expect(await snapshot(f)).toEqual(before);
  const result = await edit.invoke(f.actor,"same-actor-apply");
  expect(result).toMatchObject({ status: "applied",subscriptionId: f.subscription,templateVersion: 2,subscriptionStatus: "active" });
  const accepted = await snapshot(f); await pool.query("DELETE FROM public.subscription_quote_previews WHERE subscription_id=$1",[f.subscription]);
  await pool.query("DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=$1",[f.subscription]);
  expect(await edit.invoke(f.actor,"same-actor-apply")).toEqual({ ...result,status: "replayed",originalStatus: "applied" });
  expect((await snapshot(f)).subscription_events).toEqual(accepted.subscription_events);
});
function editorOptions(f: Fixture, unit: (sku: string) => number = () => 137, afterQuery?: (db: PoolClient,sql: string) => Promise<void>): PackageEditorOptions {
  const options: PackageEditorOptions = { now: () => f.at,limits: { maximumPlanDays: 100,maximumBaseLines: 5,maximumAddonLines: 5,maximumQuantity: 100 },
    withTransaction: async work => { const db = await pool.connect(); await db.query("BEGIN"); try { const value = await work({ query: async (sql,values) => { const result = await db.query(sql,values); await afterQuery?.(db,sql); return result; } }); await db.query("COMMIT"); return value; }
      catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); } },
    quoteCatalogReadPort: { listQuoteCatalogItems: async () => (await pool.query("SELECT id,sku FROM public.catalog_skus WHERE sellable_in_subscription")).rows.map(row => ({ variantId: String(row.id),skuCode: String(row.sku),sellability: { subscription: true } })) },
    portionModes: { full: { mode: "full",factor: 1 },reduced: { mode: "reduced",factor: 0.5 } },
    quotePort: { createServerAuthoritativeQuote: async request => {
      const lines = request.lines.map(line => ({ sku: line.sku,quantity: line.quantity,unitPriceGross: money(unit(line.sku)),lineSubtotalGross: money(unit(line.sku)*line.quantity) }));
      const total = money(lines.reduce((sum,line) => sum+line.lineSubtotalGross.amountMinor,0));
      return { quote: { lines,totalGross: total,subtotalGross: total,discountTotalGross: money(0) } };
    } },compositionRulesPort: { validateComposition: async () => ({ ok: true }),resizeComposition: async input => ({ coreLines: input.coreLines,constraint: input.lever.kind === "portionMode"
      ? { ...input.constraint,data: { ...input.constraint.data,mode: (input.lever.value as { portionMode: string }).portionMode,portionFactor: 1 } } : input.constraint }) },
    constraintMapper: { toCore: value => ({ kind: "example",version: 1,data: value ?? {} }),fromCore: value => value.data,nominalPlanDays: () => 28 } };
  return options;
}
function editor(f: Fixture, unit?: (sku: string) => number, afterQuery?: (db: PoolClient,sql: string) => Promise<void>) {
  return createPostgresPackageEditor(editorOptions(f, unit, afterQuery));
}
it.each([false,true])("edit_consent_wrapped_classic_actor_equality[noop=%s]",async noop => {
  const f = await fixture(), api = editor(f), input = { subscriptionId: f.subscription,planDays: noop ? 28 : 30,base: [{ variantId: f.sku,qty: 2 }] };
  const preview = await api.preview({ actorId: f.actor,clientId: f.client },input), before = await snapshot(f);
  expect(preview.editConsent?.lines[0]).toMatchObject({ agreedUnitMinor: 100,newUnitMinor: noop ? 100 : 137,deltaMinor: noop ? 0 : 37 });
  await expect(api.apply({ actorId: f.other,clientId: f.client },"wrapped-other-actor",{ ...input,acceptedQuoteHash: preview.quoteHash })).rejects.toMatchObject({ message: "subscription_edit_quote_actor_mismatch" });
  expect(await snapshot(f)).toEqual(before);
  expect((await api.apply({ actorId: f.actor,clientId: f.client },"wrapped-same-actor",{ ...input,acceptedQuoteHash: preview.quoteHash })).status).toBe(noop ? "noop" : "applied");
});
it("edit_consent_old_unaccepted_preview_requires_refresh",async () => {
  const f = await fixture(), api = editor(f),actor = { actorId: f.actor,clientId: f.client };
  const input = { subscriptionId: f.subscription,planDays: 30,base: [{ variantId: f.sku,qty: 2 }] },preview = await api.preview(actor,input);
  // All request/hash/baseline inputs remain valid; only the required disclosure is absent.
  await pool.query("UPDATE public.subscription_quote_previews SET quote_snapshot=quote_snapshot-'editConsent' WHERE subscription_id=$1",[f.subscription]);
  const before = await snapshot(f);
  await expect(api.apply(actor,"old-preview-refresh",{ ...input,acceptedQuoteHash: preview.quoteHash }))
    .rejects.toMatchObject({ message: "subscription_edit_quote_required" });
  expect(await snapshot(f)).toEqual(before);
});
const prune = (retention: unknown,limit: unknown,at: unknown) => rpc(pool,"customer_self_service_prune_subscription_quote_previews",[retention,limit,at]);
it.each([null,"-1 second"])("parity_LC9_01318_sql_guard[%s]",async retention => {
  await expect(prune(retention,1000,null)).rejects.toMatchObject({ message: "customer_self_service_invalid_quote_preview_retention",code: "P0001" });
});
it("parity_LC9_01319_sql_code",async () => {
  await expect(prune(null,1000,null)).rejects.toMatchObject({ message: "customer_self_service_invalid_quote_preview_retention" });
});
it("parity_LC9_01320_sql_raise",async () => {
  await expect(prune("-1 second",1000,null)).rejects.toMatchObject({ message: "customer_self_service_invalid_quote_preview_retention" });
});
it.each([null,0,-1,10001])("parity_LC9_01321_sql_guard[%s]",async limit => {
  await expect(prune("0 seconds",limit,null)).rejects.toMatchObject({ message: "customer_self_service_invalid_quote_preview_prune_limit",code: "P0001" });
});
it("parity_LC9_01322_sql_code",async () => {
  await expect(prune("0 seconds",null,null)).rejects.toMatchObject({ message: "customer_self_service_invalid_quote_preview_prune_limit" });
});
it("parity_LC9_01323_sql_raise",async () => {
  await expect(prune("0 seconds",0,null)).rejects.toMatchObject({ message: "customer_self_service_invalid_quote_preview_prune_limit" });
});
it("edit_consent_prune_zero_retention_and_limit_boundaries",async () => {
  expect(await prune("0 seconds",10000,null)).toBe(0);
  await expect(prune("0 seconds",10001,null)).rejects.toMatchObject({ message: "customer_self_service_invalid_quote_preview_prune_limit" });
});
it("parity_LC9_01324_sql_return",async () => {
  const f = await fixture(), q = await record(f);
  await pool.query("UPDATE public.subscription_quote_previews SET expires_at=$2::timestamptz-interval '8 days' WHERE id=$1",[q.preview.id,f.at]);
  expect(await prune("7 days",1000,f.at)).toBe(1);
  expect(await prune("7 days",1000,f.at)).toBe(0);
});
it.each(["LC9-D-090", "LC9-D-094"] as const)("%s prune distinguishes transaction, null and later clocks", async item => {
  const f = await fixture(), q = await record(f), db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(`UPDATE public.subscription_quote_previews SET expires_at=now()${item === "LC9-D-094" ? "-interval '1 microsecond'" : ""}
      WHERE id=$1`, [q.preview.id]);
    const clock = (await db.query("SELECT statement_timestamp()>now() AS advanced,statement_timestamp()::text AS later")).rows[0];
    expect(clock.advanced).toBe(true);
    const pending = item === "LC9-D-090" ? ["0 seconds", 10000] : ["0 seconds", 10000, null];
    expect(await rpc(db, "customer_self_service_prune_subscription_quote_previews", pending)).toBe(0);
    expect((await db.query("SELECT id FROM public.subscription_quote_previews WHERE id=$1", [q.preview.id])).rows).toEqual([{ id: q.preview.id }]);
    await rpc(db, "customer_self_service_prune_subscription_quote_previews", ["0 seconds", 10000, clock.later]);
    expect((await db.query("SELECT id FROM public.subscription_quote_previews WHERE id=$1", [q.preview.id])).rows).toEqual([]);
  } finally { await db.query("ROLLBACK"); db.release(); }
});
it("edit_consent_prune_strict_cutoff_oldest_first_and_accepted_kept",async () => {
  const f = await fixture(), a = await record(f), b = await record(f), equal = await record(f), accepted = await record(f);
  for (const [q,age] of [[a,9],[b,8],[equal,7],[accepted,10]] as const) {
    await pool.query("UPDATE public.subscription_quote_previews SET expires_at=$2::timestamptz-make_interval(days=>$3) WHERE id=$1",[q.preview.id,f.at,age]);
  }
  const event = randomUUID();
  await pool.query("INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,payload) VALUES($1,$2,'subscription.customer_self_service.update_package_template',$3,'{}')",[event,f.subscription,randomUUID()]);
  await pool.query("UPDATE public.subscription_quote_previews SET status='accepted',accepted_at=$2,accepted_idempotency_key='accepted-preview-key',accepted_event_id=$3 WHERE id=$1",[accepted.preview.id,f.at,event]);
  expect(await prune("7 days",1,f.at)).toBe(1);
  expect((await pool.query("SELECT id FROM public.subscription_quote_previews WHERE id=ANY($1::uuid[]) ORDER BY id",[[a.preview.id,b.preview.id,equal.preview.id,accepted.preview.id]])).rows.map(row => row.id).sort())
    .toEqual([b.preview.id,equal.preview.id,accepted.preview.id].sort());
  // With capacity remaining, equality at the cutoff must still be retained.
  expect(await prune("7 days",1000,f.at)).toBe(1);
  expect((await pool.query("SELECT id FROM public.subscription_quote_previews WHERE id=ANY($1::uuid[]) ORDER BY id",[[b.preview.id,equal.preview.id,accepted.preview.id]])).rows.map(row => row.id).sort())
    .toEqual([equal.preview.id,accepted.preview.id].sort());
});

it.each(["helper", "recorder"] as const)("LC9-S-024 %s rechecks pending status after a row wait", async path => {
  const f = await fixture(), recorder = await fixture();
  const { at } = (await pool.query("SELECT $1::timestamptz + interval '9 days' AS at", [f.at])).rows[0];
  const prunedAt = at.toISOString() as string;
  await prune("7 days", 10000, prunedAt);
  const q = await record(f), event = randomUUID(), key = "prune-race-acceptance";
  const accepting = await pool.connect(), deleting = await pool.connect();
  const { pid: acceptPid } = (await accepting.query("SELECT pg_backend_pid() AS pid")).rows[0];
  const { pid: deletePid } = (await deleting.query("SELECT pg_backend_pid() AS pid")).rows[0];
  let deletion: Promise<unknown> | undefined;
  try {
    await accepting.query("BEGIN");
    await rpc(accepting, "subscription_quote_preview_take", [f.actor, f.client, f.subscription, "update_package_template", q.digest, 1, key, f.at]);
    const expiry = (await pool.query("SELECT $1::timestamptz + interval '1 hour' AS expiry", [prunedAt])).rows[0].expiry;
    deletion = path === "helper"
      ? rpc(deleting, "customer_self_service_prune_subscription_quote_previews", ["7 days", 1, prunedAt])
      : rpc(deleting, "subscription_quote_preview_record", [recorder.actor, recorder.client, recorder.subscription,
        "update_package_template", hash(randomUUID()), 1, expiry, {}, {}, {}, prunedAt]);
    // Attach a handler immediately so teardown can release the row if either command fails.
    void deletion.catch(() => {});
    await expect.poll(async () => (await pool.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS waiting", [deletePid, acceptPid])).rows[0].waiting).toBe(true);
    await accepting.query("INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,payload) VALUES($1,$2,'subscription.customer_self_service.update_package_template',$3,'{}')",
      [event, f.subscription, key]);
    await rpc(accepting, "subscription_quote_preview_mark_accepted", [q.preview.id, key, event, f.at]);
    await accepting.query("COMMIT");
    if (path === "helper") expect(await deletion).toBe(0);
    else expect(await deletion).toMatchObject({ subscription_id: recorder.subscription });
    expect((await pool.query("SELECT status,accepted_event_id FROM public.subscription_quote_previews WHERE id=$1", [q.preview.id])).rows)
      .toEqual([{ status: "accepted", accepted_event_id: event }]);
  } finally {
    await accepting.query("ROLLBACK");
    await Promise.allSettled(deletion ? [deletion] : []);
    accepting.release(); deleting.release();
  }
});

it("edit_consent_prune_service_only_acl",async () => {
  const signature = "public.customer_self_service_prune_subscription_quote_previews(interval,integer,timestamptz)";
  for (const [role,allowed] of [["anon",false],["authenticated",false],["service_role",true]] as const) {
    expect((await pool.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",[role,signature])).rows[0].allowed).toBe(allowed);
    const db = await pool.connect(); try {
      await db.query(`SET ROLE ${role}`);
      if (allowed) expect(await pruneOn(db)).toBe(0); else await expect(pruneOn(db)).rejects.toMatchObject({ code: "42501" });
    } finally { await db.query("RESET ROLE"); db.release(); }
  }
});
const pruneOn = (db: PoolClient) => rpc(db,"customer_self_service_prune_subscription_quote_previews",["0 seconds",1000,null]);

function expectBoundDisclosure(preview: { quoteHash?: unknown; editConsent?: unknown }) {
  expect(preview.editConsent).toMatchObject({ version: 1,currency: "XXX",lines: expect.any(Array) });
  const consent = preview.editConsent as SubscriptionEditConsent;
  expect(preview.quoteHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(preview.quoteHash).not.toBe(consent.innerQuoteHash);
}

function bridge(f: Fixture, after?: (db: PoolClient,sql: string) => Promise<void>) {
  return createPostgresLegacyEditConsentBridge({ now: () => f.at,withTransaction: async work => {
    const db = await pool.connect(); await db.query("BEGIN");
    try {
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[f.actor]);
      await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({ sub: f.actor,role: "authenticated" })]);
      const value = await work({ query: async (sql,values) => { const result = await db.query(sql,values); await after?.(db,sql); return result; } });
      await db.query("COMMIT"); return value;
    } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  } });
}
const legacyRequest = (f: Fixture) => ({ subscriptionId: f.subscription,coreLines: [{ variantId: f.sku,qty: 3 }],cadenceDays: 28,expectedTemplateVersion: 1 });
it("edit_consent_bridge_requires_one_transaction",() => {
  expect(() => createPostgresLegacyEditConsentBridge({ now: () => "unused",withTransaction: undefined as never })).toThrow("dependency_unavailable");
});
it("edit_consent_bridge_actor_equality",async () => {
  const f = await fixture(), api = bridge(f), actor = { actorId: f.actor,clientId: f.client },input = legacyRequest(f), key = "legacy-same-actor";
  const result = await api.preview(actor,key,input), preview = result.preview as Record<string,unknown>;
  expect(preview.editConsent).toMatchObject({ lines: [{ agreedUnitMinor: 100,newUnitMinor: 137 }] });
  expectBoundDisclosure(preview);
  const accepted = { ...input,acceptedQuoteHash: String(preview.quoteHash) };
  const before = await snapshot(f);
  await pool.query("UPDATE public.subscription_quote_previews SET actor_id=$2 WHERE subscription_id=$1",[f.subscription,f.other]);
  await expect(api.apply(actor,key,accepted)).rejects.toMatchObject({ message: "subscription_edit_quote_actor_mismatch" });
  await pool.query("UPDATE public.subscription_quote_previews SET actor_id=$2 WHERE subscription_id=$1",[f.subscription,f.actor]);
  expect(await snapshot(f)).toEqual(before);
  expect((await api.apply(actor,key,accepted)).subscriptionAction).toMatchObject({ status: "applied",templateVersion: 2 });
});
it("edit_consent_bridge_rejects_forged_inner_binding",async () => {
  const f = await fixture(), api = bridge(f), actor = { actorId: f.actor,clientId: f.client },input = legacyRequest(f), key = "legacy-forged-binding";
  const result = await api.preview(actor,key,input), preview = result.preview as Record<string,unknown>;
  await pool.query("UPDATE public.subscription_quote_previews SET quote_snapshot=jsonb_set(quote_snapshot,'{legacyQuoteId}',to_jsonb($2::text)) WHERE subscription_id=$1",[f.subscription,randomUUID()]);
  const before = await snapshot(f);
  await expect(api.apply(actor,key,{ ...input,acceptedQuoteHash: String(preview.quoteHash) })).rejects.toMatchObject({ message: "subscription_edit_quote_drift" });
  expect(await snapshot(f)).toEqual(before);
});
it.each([
  ["LC9-S-005", "preview", { currency: null }, "agreement_currency_unavailable"],
  ["LC9-S-005", "apply", { currency: "YYY" }, "agreement_currency_mismatch"],
  ["LC9-S-022", "preview", { unitPriceMinor: null }, "agreement_baseline_unavailable"],
  ["LC9-S-022", "apply", { quantity: "" }, "agreement_baseline_unavailable"],
  ["LC9-S-022", "apply", { unitPriceMinor: 138 }, "subscription_edit_quote_drift"],
] as const)("%s legacy %s refuses invalid proposal evidence %j", async (_item, phase, patch, code) => {
  const f = await fixture(), actor = { actorId: f.actor, clientId: f.client }, input = legacyRequest(f), key = "legacy-proposal-check";
  const corrupt = (db: Pick<Pool, "query">) => db.query(`UPDATE public.subscription_edit_quotes
    SET proposed_lines=jsonb_set(proposed_lines,'{0}',(proposed_lines->0)||$2::jsonb) WHERE subscription_id=$1`, [f.subscription, patch]);
  if (phase === "preview") {
    const api = bridge(f, async (db, sql) => { if (sql.includes("customer_subscription_preview_bundle_as_actor")) await corrupt(db); });
    const before = await snapshot(f);
    await expect(api.preview(actor, key, input)).rejects.toMatchObject({ message: code });
    expect(await snapshot(f)).toEqual(before);
    expect((await pool.query("SELECT id FROM public.subscription_edit_quotes WHERE subscription_id=$1", [f.subscription])).rows).toEqual([]);
  } else {
    const api = bridge(f), result = await api.preview(actor, key, input), preview = result.preview as Record<string, unknown>;
    await corrupt(pool);
    const before = await snapshot(f);
    await expect(api.apply(actor, key, { ...input, acceptedQuoteHash: String(preview.quoteHash) })).rejects.toMatchObject({ message: code });
    expect(await snapshot(f)).toEqual(before);
  }
});
it("edit_consent_bridge_late_failure_rolls_back",async () => {
  const f = await fixture(), actor = { actorId: f.actor,clientId: f.client },input = legacyRequest(f), key = "legacy-late-failure";
  const result = await bridge(f).preview(actor,key,input), preview = result.preview as Record<string,unknown>, before = await snapshot(f);
  const api = bridge(f,async (db,sql) => {
    if (sql.includes("customer_subscription_apply_bundle_as_actor")) await db.query("DELETE FROM public.subscription_quote_previews WHERE subscription_id=$1",[f.subscription]);
  });
  await expect(api.apply(actor,key,{ ...input,acceptedQuoteHash: String(preview.quoteHash) })).rejects.toMatchObject({ message: "subscription_edit_quote_required" });
  expect(await snapshot(f)).toEqual(before);
});
it("edit_consent_actor_gate_does_not_change_successful_replay",async () => {
  const f = await fixture(), api = bridge(f), actor = { actorId: f.actor,clientId: f.client },input = legacyRequest(f), key = "legacy-replay-key";
  const preview = (await api.preview(actor,key,input)).preview as Record<string,unknown>;
  const accepted = { ...input,acceptedQuoteHash: String(preview.quoteHash) },result = await api.apply(actor,key,accepted);
  await pool.query("DELETE FROM public.subscription_quote_previews WHERE subscription_id=$1",[f.subscription]);
  await pool.query("DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=$1",[f.subscription]);
  expect(await api.apply(actor,key,accepted)).toEqual({ ...result,subscriptionAction: { ...(result.subscriptionAction as object),status: "replayed" } });
});

const recorderCases = [
  ["parity_LC9_01363_sql_code",{ action: "add_addon" },null],
  ["parity_LC9_01364_sql_code",{ action: "remove_addon" },null],
  ["parity_LC9_01365_sql_code",{ action: "update_addon_quantity" },null],
  ["parity_LC9_01367_sql_code",{ action: "swap_base_line" },null],
  ["parity_LC9_01368_sql_code",{ action: "update_plan_length" },null],
  ["parity_LC9_01369_sql_code",{ action: "update_base_mix" },null],
  ["parity_LC9_01370_sql_code",{ action: "update_portion" },null],
  ["parity_LC9_01371_sql_code",{ action: "update_package_template" },null],
  ["parity_LC9_01372_sql_code",{ action: "resize_bundle" },null],
  ["parity_LC9_01373_sql_code",{ action: "update_bundle" },null],
  ...["01366_sql_guard","01374_sql_code","01375_sql_raise"].map(id => [`parity_LC9_${id}`,{ action: "unsupported" },"subscription_command_unsupported_action"]),
  ...["01376_sql_guard","01377_sql_code","01378_sql_raise"].map(id => [`parity_LC9_${id}`,{ digest: "A".repeat(64) },"subscription_edit_quote_required"]),
  ...["01379_sql_guard","01380_sql_code","01381_sql_raise"].map(id => [`parity_LC9_${id}`,{ version: null },"subscription_edit_stale_template"]),
  ...["01382_sql_guard","01383_sql_code","01384_sql_raise"].map(id => [`parity_LC9_${id}`,{ expired: true },"subscription_edit_quote_expired"]),
  ...["01385_sql_guard","01386_sql_code","01387_sql_raise"].map(id => [`parity_LC9_${id}`,{ now: "-infinity" },"subscription_command_invalid_input"]),
  ...["01388_sql_guard","01389_sql_code","01390_sql_raise"].map(id => [`parity_LC9_${id}`,{ foreign: true },"subscription_command_forbidden"]),
  ...["01391_sql_guard","01392_sql_code","01393_sql_raise"].map(id => [`parity_LC9_${id}`,{ version: 2 },"subscription_edit_stale_template"]),
] as const;
it.each(recorderCases)("%s",async (_name,patch,reason) => {
  const f = await fixture(), p = patch as { action?: string; digest?: string; version?: number | null; expired?: boolean; client?: null; foreign?: boolean; now?: string };
  const expiry = p.expired ? f.at : (await pool.query("SELECT $1::timestamptz+interval '1 hour' AS at",[f.at])).rows[0].at;
  const digest = p.digest ?? hash(randomUUID()), action = p.action ?? "update_bundle";
  const args = [f.actor,p.foreign ? f.other : p.client === null ? null : f.client,f.subscription,action,digest,p.version === undefined ? 1 : p.version,expiry,{},{},{},p.now ?? f.at];
  const before = await snapshot(f);
  if (reason) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      // Isolate the function's deciding guard from a downstream storage backstop.
      // These fixture changes and any mutant write are always rolled back.
      if (p.version === null) await db.query("ALTER TABLE public.subscription_quote_previews ALTER COLUMN template_version DROP NOT NULL");
      if (p.foreign) {
        await db.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$1)",[f.other,`${f.other}@example.invalid`]);
        await db.query("ALTER TABLE public.subscription_quote_previews ALTER COLUMN subscription_id DROP NOT NULL");
      }
      await expect(rpc(db,"subscription_quote_preview_record",args)).rejects.toMatchObject({ message: reason,code: "22023" });
    } finally {
      await db.query("ROLLBACK"); db.release();
      expect((await pool.query("SELECT attname,attnotnull FROM pg_attribute WHERE attrelid='public.subscription_quote_previews'::regclass AND attname IN ('subscription_id','template_version') ORDER BY attname")).rows)
        .toEqual([{ attname: "subscription_id",attnotnull: true },{ attname: "template_version",attnotnull: true }]);
    }
    expect(await snapshot(f)).toEqual(before);
  } else expect(await rpc(pool,"subscription_quote_preview_record",args)).toMatchObject({ subscription_id: f.subscription,client_id: f.client,actor_id: f.actor,action,quote_hash: digest,template_version: 1,status: "previewed" });
});
it("parity_LC9_01394_sql_return",async () => {
  const f = await fixture(), q = await record(f);
  expect(q.preview).toMatchObject({ id: expect.any(String),subscription_id: f.subscription,client_id: f.client,actor_id: f.actor,
    action: "update_package_template",quote_hash: q.digest,template_version: 1,status: "previewed",quote_snapshot: {},request_payload: {},totals: {},accepted_at: null });
});
it.each([
  ["parity_LC9_01464_sql_guard","action"], ["parity_LC9_01489_sql_raise","owner"], ["parity_LC9_01496_sql_raise","missing"],
  ["parity_LC9_01497_sql_guard","expired"], ["parity_LC9_01499_sql_raise","expired"],
  ["parity_LC9_01500_sql_guard","used"], ["parity_LC9_01504_sql_raise","used"],
])("%s",async (_name,kind) => {
  const f = await fixture(), q = await record(f), key = "primitive-parity-key";
  // The table permits this synthetic action; only take's explicit action admission refuses it.
  if (kind === "action") await pool.query("UPDATE public.subscription_quote_previews SET action='unsupported' WHERE id=$1",[q.preview.id]);
  if (kind === "used") {
    const event = randomUUID(); await pool.query("INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,payload) VALUES($1,$2,'subscription.customer_self_service.update_package_template',$3,'{}')",[event,f.subscription,randomUUID()]);
    await rpc(pool,"subscription_quote_preview_mark_accepted",[q.preview.id,"original-parity-key",event,f.at]);
  }
  const now = kind === "expired" ? q.preview.expires_at : f.at;
  const code = kind === "action" ? "subscription_command_unsupported_action" : kind === "owner" ? "subscription_command_forbidden"
    : kind === "missing" ? "subscription_edit_quote_required" : kind === "expired" ? "subscription_edit_quote_expired" : "subscription_edit_quote_already_used";
  const before = await snapshot(f);
  const signature = "public.subscription_quote_preview_take(uuid,uuid,uuid,text,text,integer,text,timestamptz)";
  const definition = String((await pool.query("SELECT pg_get_functiondef($1::regprocedure) AS body",[signature])).rows[0].body);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    if (kind === "owner" || kind === "missing") {
      // Preserve the guard under test; isolate it from its later null-row checks.
      // Replacing the identical-signature function is fixture-local and rolled back.
      const actorCheck = "IF q.actor_id IS DISTINCT FROM p_actor_id THEN\n  RAISE EXCEPTION 'subscription_edit_quote_actor_mismatch' USING ERRCODE='22023'; END IF;";
      expect(definition).toContain(actorCheck);
      let isolated = definition.replace(actorCheck,"NULL;");
      if (kind === "owner") {
        const absentCheck = "IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;";
        expect(isolated).toContain(absentCheck); isolated = isolated.replace(absentCheck,"NULL;");
      }
      await db.query(isolated);
    }
    await expect(rpc(db,"subscription_quote_preview_take",[f.actor,kind === "owner" ? f.other : f.client,f.subscription,
      kind === "action" ? "unsupported" : "update_package_template",kind === "missing" ? hash("missing") : q.digest,1,key,now])).rejects.toMatchObject({ message: code,code: "22023" });
  } finally {
    await db.query("ROLLBACK"); db.release();
    expect((await pool.query("SELECT pg_get_functiondef($1::regprocedure) AS body",[signature])).rows[0].body).toBe(definition);
  }
  expect(await snapshot(f)).toEqual(before);
});
it.each(["applied","noop"] as const)("edit_consent_historical_applied_noop_replay_bytes[%s]",async outcome => {
  const f = await fixture(), api = editor(f), actor = { actorId: f.actor,clientId: f.client },request = { subscriptionId: f.subscription,planDays: outcome === "noop" ? 28 : 30,base: [{ variantId: f.sku,qty: 2 }] };
  const preview = await api.preview(actor,request), accepted = { ...request,acceptedQuoteHash: preview.quoteHash },key = "successful-replay";
  const result = await api.apply(actor,key,accepted);
  const receipt = (await pool.query("SELECT to_jsonb(r) AS row FROM public.subscription_command_receipts r WHERE actor_id=$1 AND idempotency_key=$2",[f.actor,key])).rows;
  await pool.query("DELETE FROM public.subscription_quote_previews WHERE subscription_id=$1",[f.subscription]);
  await pool.query("DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=$1",[f.subscription]);
  expect(await editor(f).apply(actor,key,accepted)).toEqual({ ...result,status: "replayed",originalStatus: outcome });
  expect((await pool.query("SELECT to_jsonb(r) AS row FROM public.subscription_command_receipts r WHERE actor_id=$1 AND idempotency_key=$2",[f.actor,key])).rows).toEqual(receipt);
});
it("edit_consent_existing_snapshot_fields_preserved",async () => {
  const f = await fixture(), api = editor(f), preview = await api.preview({ actorId: f.actor,clientId: f.client },{ subscriptionId: f.subscription,planDays: 30,base: [{ variantId: f.sku,qty: 2 }] });
  const row = (await pool.query("SELECT quote_snapshot FROM public.subscription_quote_previews WHERE subscription_id=$1 AND quote_hash=$2",[f.subscription,preview.quoteHash])).rows[0];
  expect(row.quote_snapshot).toMatchObject({ baseLines: [{ variantId: f.sku,qty: 2,quoteLine: { sku: f.sku,quantity: 2,unitPriceGross: money(137) } }],addonLines: [],compositionConstraint: { kind: "unit_count",value: 2,dailyNeed: 1 },editConsent: preview.editConsent });
});

function richLine(sku: string,quantity: number,unit = 137) {
  return { sku,quantity,productSlug: "article",unitPriceGross: money(unit),lineSubtotalGross: money(unit*quantity),
    tax: { included: true as const,country: "ZZ",category: "standard",vatRateBps: 0,legalBasis: "synthetic",netAmount: money(unit*quantity),vatAmount: money(0),grossAmount: money(unit*quantity) } };
}
function sizedEditor(f: Fixture, addons: readonly string[] = [], adjust?: (options: SizedEditorOptions) => void) {
  const options: SizedEditorOptions = { now: () => f.at,
    policy: { minimumCoreUnits: 1,maximumCoreLines: 3,maximumAddonLines: 3,maximumQuantity: 100,allowedCadences: [28,30],maximumExclusions: 8,maximumCatalogExclusions: 16,
      fixedThroughCycle: 2,graduationCycle: 3,portionModes: { full: { mode: "full",factor: 1 },reduced: { mode: "reduced",factor: 0.5 } } },
    withTransaction: async work => { const db = await pool.connect(); await db.query("BEGIN"); try { const result = await work(db); await db.query("COMMIT"); return result; }
      catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); } },
    readFacts: async () => ({ subscriptionId: f.subscription,clientId: f.client,subjectRef: f.subscription,exclusions: [],snapshot: { revision: 1 } }),
    resolveOptInNeed: async () => ({ dailyNeed: 1,snapshot: { revision: 1 } }),
    readCatalog: async () => [f.sku,...addons].map(id => ({ variantId: id,sku: id,groupId: id,isAddon: id !== f.sku,sellable: true,physicalSize: 100,demandPerUnit: 30,
      documentRevisionId: id,documentDigest: hash(id),verified: true,exclusions: [],sellableNow: 100 })),
    assertCurrentFacts: async () => {},proposePortion: async ({ current }) => current.map(line => ({ variantId: line.variantId,qty: 1 })),
    quotePort: { createServerAuthoritativeQuote: async request => {
      const lines = request.lines.map(line => richLine(line.sku,line.quantity)),total = money(lines.reduce((sum,line) => sum+line.lineSubtotalGross.amountMinor,0));
      return { quote: { lines,currency: "XXX",taxIncluded: true,discounts: [],totalGross: total,subtotalGross: total,discountTotalGross: money(0),netTotal: total,taxTotal: money(0) } };
    } } };
  adjust?.(options);
  return createPostgresSizedEditor(options);
}
it.each([28,30])("edit_consent_wrapped_exact_actor_equality[update_plan_length,%s]",async planDays => {
  const f = await fixture(), actor = { actorId: f.actor,clientId: f.client },api = editor(f),request = { subscriptionId: f.subscription,action: "update_plan_length" as const,planDays };
  const preview = await api.preview(actor,request),before = await snapshot(f);
  expectBoundDisclosure(preview);
  expect(preview.editConsent?.lines).toMatchObject([{ kind: "retained",variantId: f.sku,agreedQuantity: 2,newQuantity: 2,agreedUnitMinor: 100,
    newUnitMinor: planDays === 28 ? 100 : 137, deltaMinor: planDays === 28 ? 0 : 37, subtotalDeltaMinor: planDays === 28 ? 0 : 74 }]);
  await expect(api.apply({ ...actor,actorId: f.other },"exact-other-actor",{ ...request,acceptedQuoteHash: preview.quoteHash })).rejects.toMatchObject({ message: "subscription_edit_quote_actor_mismatch" });
  expect(await snapshot(f)).toEqual(before);
  expect((await api.apply(actor,"exact-same-actor",{ ...request,acceptedQuoteHash: preview.quoteHash })).status).toBe(planDays === 28 ? "noop" : "applied");
});
it.each([true,false])("edit_consent_wrapped_sized_actor_equality[update_bundle,noop=%s]",async noop => {
  const f = await fixture(), initial = await lane(f,"sized"); await initial.invoke(f.actor,"initial-sized-opt-in");
  const api = sizedEditor(f),actor = { actorId: f.actor,clientId: f.client };
  const request = { subscriptionId: f.subscription,expectedTemplateVersion: 2,action: "update_bundle" as const,coreLines: [{ variantId: f.sku,qty: 2 }],cadenceDays: noop ? 30 : 28,
    compositionConstraint: { kind: "unit_count",value: 2,dailyNeed: 1 } };
  const preview = await api.preview(actor,request),before = await snapshot(f);
  expectBoundDisclosure(preview);
  expect(preview.editConsent?.lines[0]).toMatchObject({ agreedUnitMinor: 137,newUnitMinor: 137,deltaMinor: 0 });
  await expect(api.apply({ ...actor,actorId: f.other },"sized-other-actor",{ ...request,acceptedQuoteHash: preview.quoteHash })).rejects.toMatchObject({ message: "subscription_edit_quote_actor_mismatch" });
  expect(await snapshot(f)).toEqual(before);
  expect((await api.apply(actor,"sized-same-actor",{ ...request,acceptedQuoteHash: preview.quoteHash })).status).toBe(noop ? "noop" : "applied");
});

it.each(["applied","noop"] as const)("LC9-D-150/S-015 sized %s resolves omitted version and replays without current evidence", async outcome => {
  const f = await fixture(), initial = await lane(f,"sized");
  await initial.invoke(f.actor,"bind-sized-replay");
  const actor = { actorId: f.actor,clientId: f.client }, api = sizedEditor(f);
  const input = { subscriptionId: f.subscription,action: "update_bundle" as const,
    coreLines: [{ variantId: f.sku,qty: 2 }],cadenceDays: outcome === "noop" ? 30 : 28,compositionConstraint: { kind: "unit_count",value: 2,dailyNeed: 1 } };
  const preview = await api.preview(actor,input);
  const accepted = { ...input,acceptedQuoteHash: preview.quoteHash }, key = "sized-omitted-version";
  const result = await api.apply(actor,key,accepted);
  expect(result).toMatchObject({ status: outcome, templateVersion: outcome === "noop" ? 2 : 3 });
  const receipt = (await snapshot(f)).subscription_command_receipts;
  await pool.query("DELETE FROM public.subscription_quote_previews WHERE subscription_id=$1", [f.subscription]);
  await pool.query("DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=$1", [f.subscription]);
  await pool.query("UPDATE public.subscriptions SET template_version=template_version+1 WHERE id=$1", [f.subscription]);
  const reconnected = sizedEditor(f);
  expect(await reconnected.apply(actor,key,accepted)).toEqual({ ...result,status: "replayed",originalStatus: outcome });
  await expect(reconnected.apply(actor,key,{ ...accepted,expectedTemplateVersion: 2 })).rejects.toThrow(/^subscription_command_idempotency_conflict$/u);
  expect((await snapshot(f)).subscription_command_receipts).toEqual(receipt);
});

it.each(["classic","exact","sized"] as const)("LC9-S-013/S-014 %s noop binds its request without consuming the preview", async laneName => {
  const f = await fixture(), actor = { actorId: f.actor,clientId: f.client };
  let preview: { quoteHash?: string }, invoke: (key: string, altered?: boolean) => Promise<{ status: string }>;
  if (laneName === "sized") {
    const initial = await lane(f,"sized"); await initial.invoke(f.actor,"bind-sized-noop");
    const api = sizedEditor(f);
    const input = { subscriptionId: f.subscription,action: "update_bundle" as const,coreLines: [{ variantId: f.sku,qty: 2 }],
      compositionConstraint: { kind: "unit_count",value: 2,dailyNeed: 1 } };
    preview = await api.preview(actor,input);
    invoke = (key, altered) => api.apply(actor,key,{ ...input,...(altered ? { addonLines: [] } : {}),acceptedQuoteHash: preview.quoteHash });
  } else {
    const api = editor(f);
    const input = laneName === "classic" ? { subscriptionId: f.subscription,planDays: 28,base: [{ variantId: f.sku,qty: 2 }] }
      : { subscriptionId: f.subscription,action: "update_plan_length" as const,planDays: 28 };
    preview = await api.preview(actor,input);
    invoke = (key, altered) => api.apply(actor,key,{ ...input,planDays: altered ? 30 : 28,acceptedQuoteHash: preview.quoteHash });
  }
  const before = await snapshot(f);
  await expect(invoke("mismatched-noop-request",true)).rejects.toThrow(/^subscription_edit_quote_drift$/u);
  expect(await snapshot(f)).toEqual(before);
  const result = await invoke("first-noop-request");
  expect(result.status).toBe("noop");
  expect(await invoke("first-noop-request")).toEqual({ ...result,status: "replayed",originalStatus: "noop" });
  expect(await invoke("another-noop-request")).toEqual(result);
  const { subscription_command_receipts: receipts,...unchanged } = await snapshot(f);
  const { subscription_command_receipts: original,...prior } = before;
  expect(unchanged).toEqual(prior);
  expect(receipts).toHaveLength((original as unknown[]).length+2);
});

async function extraSku(f: Fixture,addon: boolean,accepted = false) {
  const id = randomUUID();
  await pool.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Article')",[id,`article-${id}`]);
  await pool.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription,is_addon) VALUES($1::uuid,$1::uuid,$1::text,'Article',true,$2)",[id,addon]);
  if (accepted) {
    await pool.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code) VALUES($1,$2,1,1,true,100,'XXX')",[f.subscription,id]);
    await pool.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,2,$2,1,100)",[f.subscription,id]);
  }
  return id;
}
it.each(["add_addon","remove_addon","update_addon_quantity","noop quantity"] as const)(
  "LC9-S-012/S-030 sized %s uses the same actor through its exact delegate", async action => {
    const f = await fixture(), actor = { actorId: f.actor,clientId: f.client }, initial = await lane(f,"sized");
    await initial.invoke(f.actor,"bind-sized-addon");
    f.at = (await pool.query("SELECT $1::timestamptz+interval '1 millisecond' AS at", [f.at])).rows[0].at.toISOString();
    const addon = await extraSku(f,true), api = sizedEditor(f,[addon]);
    const add = { subscriptionId: f.subscription,action: "add_addon" as const,variantId: addon,qty: 1 };
    if (action !== "add_addon") {
      const candidate = await api.preview(actor,add);
      await api.apply(actor,"prepare-sized-addon",{ ...add,acceptedQuoteHash: candidate.quoteHash });
    }
    const input = action === "add_addon" ? add : action === "remove_addon" ? {
      subscriptionId: f.subscription,action,variantId: addon,
    } : { ...add,action: "update_addon_quantity" as const,qty: action === "noop quantity" ? 1 : 2 };
    const preview = await api.preview(actor,input), before = await snapshot(f);
    const accepted = { ...input,acceptedQuoteHash: preview.quoteHash }, key = "selected-sized-addon";
    await expect(api.apply({ ...actor,actorId: f.other },key,accepted)).rejects.toMatchObject({ message: "subscription_edit_quote_actor_mismatch",code: "22023" });
    expect(await snapshot(f)).toEqual(before);
    const result = await api.apply(actor,key,accepted);
    expect(result.status).toBe(action === "noop quantity" ? "noop" : "applied");
    await pool.query("DELETE FROM public.subscription_quote_previews WHERE subscription_id=$1", [f.subscription]);
    await pool.query("DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=$1", [f.subscription]);
    expect(await sizedEditor(f,[addon]).apply(actor,key,accepted)).toEqual({ ...result,status: "replayed",originalStatus: result.status });
  },
);
it.each(["swap_base_line","add_addon","remove_addon","update_addon_quantity","update_base_mix","update_portion"] as const)("edit_consent_wrapped_exact_actor_equality[%s]",async action => {
  const f = await fixture(), target = await extraSku(f,["add_addon","remove_addon","update_addon_quantity"].includes(action),["remove_addon","update_addon_quantity"].includes(action));
  const fields = action === "swap_base_line" ? { fromVariantId: f.sku,toVariantId: target }
    : action === "update_base_mix" ? { base: [{ variantId: target,qty: 2 }] }
      : action === "update_portion" ? { portionMode: "full" } : { variantId: target,...(action === "remove_addon" ? {} : { qty: 2 }) };
  const input = { subscriptionId: f.subscription,expectedTemplateVersion: 1,action,...fields } as ExactSubscriptionEditRequest;
  const actor = { actorId: f.actor,clientId: f.client },api = editor(f),preview = await api.preview(actor,input),before = await snapshot(f);
  expectBoundDisclosure(preview);
  expect(preview.editConsent?.agreedTotalMinor).toBe(["remove_addon","update_addon_quantity"].includes(action) ? 300 : 200);
  await expect(api.apply({ ...actor,actorId: f.other },"exact-action-other",{ ...input,acceptedQuoteHash: preview.quoteHash })).rejects.toMatchObject({ message: "subscription_edit_quote_actor_mismatch" });
  expect(await snapshot(f)).toEqual(before);
  expect(["applied","noop"]).toContain((await api.apply(actor,"exact-action-same",{ ...input,acceptedQuoteHash: preview.quoteHash })).status);
});

it("edit_consent_prune_defaults_and_native_tie_break",async () => {
  const f = await fixture(); await prune("0 seconds",10000,f.at);
  const a = await record(f),b = await record(f);
  await pool.query("UPDATE public.subscription_quote_previews SET expires_at=$2::timestamptz-interval '8 days' WHERE subscription_id=$1",[f.subscription,f.at]);
  expect(await prune("7 days",1,f.at)).toBe(1);
  const kept = [a.preview.id,b.preview.id].sort()[1];
  expect((await pool.query("SELECT id FROM public.subscription_quote_previews WHERE subscription_id=$1",[f.subscription])).rows).toEqual([{ id: kept }]);
  await pool.query(`INSERT INTO public.subscription_quote_previews(subscription_id,client_id,actor_id,action,quote_hash,template_version,expires_at,request_payload,quote_snapshot,totals)
    SELECT $1,$2,$3,'update_bundle',repeat(md5(g::text),2),1,$4::timestamptz-interval '8 days','{}','{}','{}' FROM generate_series(1,1000) g`,[f.subscription,f.client,f.actor,f.at]);
  // There are 1001 eligible rows: default 1000 must delete exactly 1000.
  expect((await pool.query("SELECT public.customer_self_service_prune_subscription_quote_previews() AS deleted")).rows[0].deleted).toBe(1000);
  expect((await pool.query("SELECT count(*)::integer AS count FROM public.subscription_quote_previews WHERE subscription_id=$1",[f.subscription])).rows[0].count).toBe(1);
});
it("edit_consent_actor_id_every_writer",async () => {
  const writers = (await pool.query("SELECT proname,prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace AND prosrc LIKE '%INSERT INTO public.subscription_quote_previews(%' ORDER BY proname")).rows;
  expect(writers.map(row => row.proname)).toEqual(["subscription_quote_preview_record"]);
  expect(writers[0].prosrc).toContain("actor_id=EXCLUDED.actor_id");
  expect(writers[0].prosrc).toContain("VALUES(s.id,p_client_id,p_actor_id");
});

it("edit_consent_wrapped_fresh_noop_uses_shared_take",async () => {
  for (const lane of ["classic","exact","sized"] as const) {
    const f = await fixture(),actor = { actorId: f.actor,clientId: f.client };
    if (lane === "sized") {
      const initial = await laneCommand(f); await initial.invoke(f.actor,"noop-sized-opt-in");
      const api = sizedEditor(f),input = { subscriptionId: f.subscription,expectedTemplateVersion: 2,action: "update_bundle" as const,
        cadenceDays: 30,coreLines: [{ variantId: f.sku,qty: 2 }],compositionConstraint: { kind: "unit_count",value: 2,dailyNeed: 1 } };
      const preview = await api.preview(actor,input),before = await snapshot(f);
      await expect(api.apply({ ...actor,actorId: f.other },"noop-other-actor",{ ...input,acceptedQuoteHash: preview.quoteHash })).rejects.toMatchObject({ message: "subscription_edit_quote_actor_mismatch" });
      expect(await snapshot(f)).toEqual(before); expect((await api.apply(actor,"noop-same-actor",{ ...input,acceptedQuoteHash: preview.quoteHash })).status).toBe("noop");
    } else {
      const api = editor(f),input = lane === "classic" ? { subscriptionId: f.subscription,planDays: 28,base: [{ variantId: f.sku,qty: 2 }] }
        : { subscriptionId: f.subscription,action: "update_plan_length" as const,planDays: 28 };
      const preview = await api.preview(actor,input),before = await snapshot(f);
      await expect(api.apply({ ...actor,actorId: f.other },"noop-other-actor",{ ...input,acceptedQuoteHash: preview.quoteHash })).rejects.toMatchObject({ message: "subscription_edit_quote_actor_mismatch" });
      expect(await snapshot(f)).toEqual(before); expect((await api.apply(actor,"noop-same-actor",{ ...input,acceptedQuoteHash: preview.quoteHash })).status).toBe("noop");
    }
  }
});
const laneCommand = (f: Fixture) => lane(f,"sized");
it("edit_consent_unwrapped_acceptance_uses_shared_take",async () => {
  for (const name of ["package","line","sized"] as const) {
    const f = await fixture(),edit = await lane(f,name),before = await snapshot(f);
    await expect(edit.invoke(f.other,"unwrapped-other-actor")).rejects.toMatchObject({ message: "subscription_edit_quote_actor_mismatch" });
    expect(await snapshot(f)).toEqual(before); expect((await edit.invoke(f.actor,"unwrapped-same-actor")).status).toBe("applied");
  }
});
it("edit_consent_competing_equal_total_edits",async () => {
  const f = await fixture(),addon = await extraSku(f,true,true);
  await pool.query("UPDATE public.subscription_lines SET unit_price_minor=200 WHERE subscription_id=$1 AND variant_id=$2",[f.subscription,addon]);
  await pool.query("UPDATE public.subscription_renewal_term_lines SET unit_amount_minor=200 WHERE subscription_id=$1 AND sku=$2",[f.subscription,addon]);
  const observer = await pool.connect(),key = BigInt(`0x${randomUUID().replaceAll("-","").slice(0,14)}`).toString();
  await observer.query("SELECT pg_advisory_lock($1::bigint)",[key]);
  const price = (sku: string) => sku === f.sku ? 150 : 100;
  let armed = false,ep = 0,fp = 0;
  const firstApi = editor(f,price,async (db,sql) => {
    if (armed && sql.startsWith("SELECT s.template_version")) {
      ep = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await db.query("SELECT pg_advisory_lock($1::bigint)",[key]); await db.query("SELECT pg_advisory_unlock($1::bigint)",[key]);
    }
  });
  const secondApi = editor(f,price,async db => { if (!fp) fp = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid; });
  const actor = { actorId: f.actor,clientId: f.client },input = { subscriptionId: f.subscription,planDays: 30,expectedTemplateVersion: 1,base: [{ variantId: f.sku,qty: 2 }],addons: [{ variantId: addon,qty: 1 }] };
  const preview = await firstApi.preview(actor,input),anchor = (await pool.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1",[f.subscription])).rows;
  expect(preview.editConsent).toMatchObject({ agreedTotalMinor: 400,newTotalMinor: 400,subtotalDeltaMinor: 0 });
  armed = true;
  const accepted = { ...input,acceptedQuoteHash: preview.quoteHash };
  const first = firstApi.apply(actor,"equal-total-first",accepted).then(value => ({ ok: true as const,value }),error => ({ ok: false as const,error }));
  let second: ReturnType<typeof firstApi.apply> | undefined;
  try {
    await expect.poll(async () => ep > 0 && (await observer.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked",[ep])).rows[0].blocked).toBe(true);
    second = secondApi.apply(actor,"equal-total-second",accepted);
    const rejected = second.then(value => ({ ok: true as const,value }),error => ({ ok: false as const,error }));
    await expect.poll(async () => fp > 0 && (await observer.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked",[fp,ep])).rows[0].blocked).toBe(true);
    await observer.query("SELECT pg_advisory_unlock($1::bigint)",[key]);
    expect((await first).ok).toBe(true);
    const other = await rejected; expect(other.ok).toBe(false); if (!other.ok) expect(other.error).toMatchObject({ message: "subscription_edit_stale_template" });
    expect((await pool.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1",[f.subscription])).rows).toEqual(anchor);
    expect((await pool.query("SELECT count(*)::integer AS count FROM public.subscription_command_receipts WHERE subscription_id=$1",[f.subscription])).rows[0].count).toBe(1);
    const next = await editor(f,price).preview(actor,{ ...input,expectedTemplateVersion: 2 });
    expect(next.editConsent?.innerQuoteHash).toBe(preview.editConsent?.innerQuoteHash);
    expect(next.quoteHash).not.toBe(preview.quoteHash);
  } finally { await observer.query("SELECT pg_advisory_unlock($1::bigint)",[key]); await Promise.allSettled([first,...(second ? [second] : [])]); observer.release(); }
  // Isolate the fresh baseline hash check from the independent template-version fence.
  const drift = await fixture(),side = await extraSku(drift,true,true),driftApi = editor(drift,sku => sku === drift.sku ? 150 : 100);
  await pool.query("UPDATE public.subscription_lines SET unit_price_minor=200 WHERE subscription_id=$1 AND variant_id=$2",[drift.subscription,side]);
  await pool.query("UPDATE public.subscription_renewal_term_lines SET unit_amount_minor=200 WHERE subscription_id=$1 AND sku=$2",[drift.subscription,side]);
  const request = { subscriptionId: drift.subscription,expectedTemplateVersion: 1,planDays: 30,base: [{ variantId: drift.sku,qty: 2 }],addons: [{ variantId: side,qty: 1 }] };
  const verified = { actorId: drift.actor,clientId: drift.client },stale = await driftApi.preview(verified,request);
  await pool.query("UPDATE public.subscription_lines SET unit_price_minor=CASE WHEN variant_id=$2 THEN 150 ELSE 100 END WHERE subscription_id=$1",[drift.subscription,drift.sku]);
  await pool.query("UPDATE public.subscription_renewal_term_lines SET unit_amount_minor=CASE WHEN sku=$2 THEN 150 ELSE 100 END WHERE subscription_id=$1",[drift.subscription,drift.sku]);
  const before = await snapshot(drift);
  await expect(driftApi.apply(verified,"equal-total-baseline-drift",{ ...request,acceptedQuoteHash: stale.quoteHash })).rejects.toMatchObject({ message: "subscription_reprice_quote_not_accepted" });
  expect(await snapshot(drift)).toEqual(before);
});

// Confirmed in-hunk return obligations; distinct case names retain their census identity.
it.each(["parity_LC9_07208_ts_return","parity_LC9_07235_ts_return"])("%s",async () => {
  const f = await fixture(),initial = await lane(f,"sized"); await initial.invoke(f.actor,"return-sized-opt-in");
  const preview = await sizedEditor(f).preview({ actorId: f.actor,clientId: f.client },{ subscriptionId: f.subscription,expectedTemplateVersion: 2,
    action: "update_bundle",coreLines: [{ variantId: f.sku,qty: 3 }],cadenceDays: 28,compositionConstraint: { kind: "unit_count",value: 3,dailyNeed: 1 } });
  expectBoundDisclosure(preview);
  expect(preview.editConsent?.lines[0]).toMatchObject({ variantId: f.sku,newQuantity: 3,newUnitMinor: 137 });
});
it("parity_LC9_08778_ts_return",async () => {
  const f = await fixture(),preview = await editor(f).preview({ actorId: f.actor,clientId: f.client },{ subscriptionId: f.subscription,planDays: 30,base: [{ variantId: f.sku,qty: 2 }] });
  expectBoundDisclosure(preview);
  expect(preview.editConsent?.lines[0]).toMatchObject({ variantId: f.sku,newQuantity: 2,newUnitMinor: 137 });
});
it("edit_consent_recorder_retention_is_seven_days",async () => {
  const f = await fixture(); await prune("0 seconds",10000,f.at);
  const recent = await record(f),old = await record(f);
  await pool.query("UPDATE public.subscription_quote_previews SET expires_at=$2::timestamptz-interval '1 day' WHERE id=$1",[recent.preview.id,f.at]);
  await pool.query("UPDATE public.subscription_quote_previews SET expires_at=$2::timestamptz-interval '8 days' WHERE id=$1",[old.preview.id,f.at]);
  await record(f);
  expect((await pool.query("SELECT id FROM public.subscription_quote_previews WHERE id=ANY($1::uuid[])",[[recent.preview.id,old.preview.id]])).rows).toEqual([{ id: recent.preview.id }]);
});
it("edit_consent_recorder_keeps_native_id_tie_break",async () => {
  const f = await fixture(); await prune("0 seconds",10000,f.at);
  await pool.query(`INSERT INTO public.subscription_quote_previews(subscription_id,client_id,actor_id,action,quote_hash,template_version,expires_at,request_payload,quote_snapshot,totals)
    SELECT $1,$2,$3,'update_bundle',repeat(md5(g::text),2),1,$4::timestamptz-interval '8 days','{}','{}','{}' FROM generate_series(1,501) g`,[f.subscription,f.client,f.actor,f.at]);
  const expected = (await pool.query("SELECT id FROM public.subscription_quote_previews WHERE subscription_id=$1 ORDER BY id DESC LIMIT 1",[f.subscription])).rows;
  await record(f);
  expect((await pool.query("SELECT id FROM public.subscription_quote_previews WHERE subscription_id=$1 AND expires_at<$2::timestamptz",[f.subscription,f.at])).rows).toEqual(expected);
});

it.each(["exact","sized","bridge"] as const)("edit_consent_lane_hash_binds_same_price_baseline[%s]",async laneName => {
  const f = await fixture(),actor = { actorId: f.actor,clientId: f.client };
  if (laneName === "sized") { const initial = await lane(f,"sized"); await initial.invoke(f.actor,"binding-sized-opt-in"); }
  const preview = laneName === "bridge"
    ? async () => (await bridge(f).preview(actor,"binding-legacy-key",legacyRequest(f))).preview as { quoteHash?: unknown; editConsent?: unknown }
    : laneName === "exact"
      ? () => editor(f).preview(actor,{ subscriptionId: f.subscription,action: "update_plan_length",planDays: 30 })
      : () => sizedEditor(f).preview(actor,{ subscriptionId: f.subscription,expectedTemplateVersion: 2,action: "update_bundle",coreLines: [{ variantId: f.sku,qty: 2 }],
        cadenceDays: 28,compositionConstraint: { kind: "unit_count",value: 2,dailyNeed: 1 } });
  const first = await preview(); expectBoundDisclosure(first);
  // Only baseline identity/order changes: all prices, quantities and lane input stay equal.
  await pool.query("UPDATE public.subscription_renewal_term_lines SET line_ordinal=line_ordinal+100 WHERE subscription_id=$1",[f.subscription]);
  const second = await preview(); expectBoundDisclosure(second);
  const a = first.editConsent as SubscriptionEditConsent,b = second.editConsent as SubscriptionEditConsent;
  expect(b.lines).toEqual(a.lines); expect(b.innerQuoteHash).toBe(a.innerQuoteHash);
  expect(b.baselineFingerprint).not.toBe(a.baselineFingerprint);
  expect(second.quoteHash).not.toBe(first.quoteHash);
});

it.each(["classic", "exact"] as const)("LC9-D-047 %s noop shows retained price and flags the live difference", async name => {
  const f = await fixture(), actor = { actorId: f.actor, clientId: f.client }, api = editor(f);
  const input = name === "classic" ? { subscriptionId: f.subscription, planDays: 28, base: [{ variantId: f.sku, qty: 2 }] }
    : { subscriptionId: f.subscription, action: "update_plan_length" as const, planDays: 28 };
  const preview = await api.preview(actor, input);
  expect(preview.editConsent).toMatchObject({ noChange: { livePriceDiffers: true }, agreedTotalMinor: 200, newTotalMinor: 200,
    lines: [{ agreedUnitMinor: 100, newUnitMinor: 100, reason: "unchanged" }] });
  const before = await snapshot(f);
  const accepted = { ...input, acceptedQuoteHash: preview.quoteHash };
  expect(await api.apply(actor, "keep-agreement-noop", accepted)).toMatchObject({ status: "noop", templateVersion: 1 });
  const after = await snapshot(f);
  expect({ ...after, subscription_command_receipts: before.subscription_command_receipts }).toEqual(before);
});

it.each(["fixed pool", "retain", "clear", "normalize resize", "unknown lever", "no schedule", "no method", "open dunning"] as const)(
  "LC9-C-01 classic bundle route handles %s", async scenario => {
    const f = await fixture(), actor = { actorId: f.actor, clientId: f.client };
    const addon = await extraSku(f, true, true), options = editorOptions(f);
    const calls: unknown[] = [];
    const api = createPostgresClassicBundleEditor({ ...options, compositionRulesPort: {
      ...options.compositionRulesPort,
      async resizeComposition(input) {
        calls.push(input.lever);
        if (input.lever.kind !== "portionMode") return null;
        return { coreLines: input.coreLines.map(line => ({ ...line, qty: 3 })), constraint: { ...input.constraint, data: { ...input.constraint.data, revised: true } } };
      },
    } });
    if (scenario === "no schedule") await pool.query("UPDATE public.subscriptions SET next_cycle_at=NULL WHERE id=$1", [f.subscription]);
    if (scenario === "no method") await pool.query("DELETE FROM public.subscription_method_states WHERE subscription_id=$1", [f.subscription]);
    if (scenario === "open dunning") await pool.query("INSERT INTO public.subscription_dunning_cases(subscription_id,client_id,idempotency_key) VALUES($1,$2,$3)",
      [f.subscription,f.client,randomUUID()]);
    const resize = scenario === "normalize resize" || scenario === "unknown lever";
    const request: ClassicBundleEditRequest = resize
      ? { subscriptionId: f.subscription, action: "resize_bundle", cadenceDays: 30, resizeLever: { kind: scenario === "unknown lever" ? "unknown" : "portionMode", value: "reduced" } }
      : { subscriptionId: f.subscription, action: "update_bundle", cadenceDays: scenario === "retain" || scenario === "clear" ? 30 : 28,
          compositionConstraint: { kind: "unit_count", value: 2, dailyNeed: 1 },
          coreLines: [{ variantId: f.sku, qty: scenario === "fixed pool" ? 3 : 2 }], ...(scenario === "clear" ? { addonLines: [] } : {}) };
    const before = await snapshot(f);
    if (scenario === "fixed pool" || scenario === "unknown lever") {
      await expect(api.preview(actor, request)).rejects.toThrow(scenario === "fixed pool" ? /^subscription_reprice_base_total_mismatch$/u : /^subscription_reprice_bundle_resize_unservable$/u);
      expect(await snapshot(f)).toEqual(before);
      return;
    }
    const preview = await api.preview(actor, request);
    if (scenario === "no schedule" || scenario === "no method" || scenario === "open dunning") {
      expect(preview.preview.blockedReason).toBe(scenario === "no schedule" ? "edit_window_closed" : scenario === "no method" ? "missing_payment_method" : "payment_blocked");
      expect(await snapshot(f)).toEqual(before);
      return;
    }
    expect(preview.editConsent?.lines.find(line => line.variantId === addon)?.kind).toBe(scenario === "clear" ? "removed" : "retained");
    const accepted = { ...request, acceptedQuoteHash: preview.quoteHash };
    const answer = await api.apply(actor, "generic-classic-contract", accepted);
    expect(answer).toMatchObject({ status: "applied", action: request.action, templateVersion: 2 });
    expect(await api.apply(actor, "generic-classic-contract", accepted)).toEqual({ ...answer, status: "replayed", originalStatus: "applied" });
    const lines = (await pool.query("SELECT id,variant_id,quantity FROM public.subscription_lines WHERE subscription_id=$1 ORDER BY is_addon", [f.subscription])).rows;
    expect(lines.map(line => [line.variant_id, line.quantity])).toEqual([[f.sku, resize ? 3 : 2], ...(scenario === "clear" ? [] : [[addon, 1]])]);
    if (scenario === "retain") expect(lines[1].id).toBe((before.subscription_lines as { id: string; variant_id: string }[]).find(line => line.variant_id === addon)?.id);
    if (resize) expect(calls).toEqual(Array.from({ length: 2 }, () => ({ kind: "portionMode", value: { planDays: 30, portionMode: "reduced" } })));
    expect(((await snapshot(f)).subscriptions as { cadence_days: number; composition_constraint: Record<string,unknown> }[])[0]).toMatchObject({
      cadence_days: 30, composition_constraint: { kind: "unit_count", ...(resize ? { revised: true } : {}) },
    });
  },
);

it("LC9-D-077 sized preview captures expiry before facts and pricing", async () => {
  const f = await fixture(),actor = { actorId: f.actor,clientId: f.client };
  const clock = (await pool.query("SELECT $1::timestamptz+interval '2 minutes' AS after,$1::timestamptz+interval '15 minutes' AS expected", [f.at])).rows[0];
  let current = f.at;
  const api = sizedEditor(f,[],options => {
    const read = options.readFacts;
    options.now = () => current;
    options.readFacts = async (...args) => { current = clock.after.toISOString(); return read(...args); };
  });
  const request = { subscriptionId: f.subscription,action: "resize_bundle" as const,cadenceDays: 28,
    compositionConstraint: { kind: "unit_count",value: 2,dailyNeed: 1 },
    resizeLever: { kind: "subscription.sized.parcel" as const,value: { coreLines: [{ variantId: f.sku,qty: 2 }],optInToSized: true as const } } };
  // Attach the existing frozen quote shape as the active agreement evidence.
  await pool.query("INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at) VALUES($1,'subscription.starter_graduated',$2,$3,$4)",
    [f.subscription,randomUUID(),{ linePricing: [{ sku: f.sku,quantity: 2,unitAmountMinor: 100,isAddon: false,quoteLine: richLine(f.sku,2,100) }] },f.at]);
  const preview = await api.preview(actor,request);
  expect(preview.quoteExpiresAt).toBe(clock.expected.toISOString());
  expect((await pool.query("SELECT created_at,expires_at FROM public.subscription_quote_previews WHERE subscription_id=$1", [f.subscription])).rows)
    .toEqual([{ created_at: clock.after,expires_at: clock.expected }]);
});

it.each((["classic","exact","sized"] as const).flatMap(laneName =>
  (["explicit stale","missing method","missing anchor"] as const).map(change => ({ laneName,change }))))(
  "LC9-D-040/D-042/D-046 $laneName reports $change before the unreadable quote", async ({ laneName,change }) => {
    const f = await fixture(), actor = { actorId: f.actor,clientId: f.client };
    let preview: () => Promise<{ quoteHash?: string; preview: { blockedReason: string | null } }>;
    let apply: (hash: string | undefined) => Promise<unknown>;
    const version = laneName === "sized" ? 2 : 1;
    if (laneName === "sized") {
      const initial = await lane(f,"sized"); await initial.invoke(f.actor,"bind-sized-eligibility");
      const api = sizedEditor(f), input = { subscriptionId: f.subscription,action: "update_plan_length" as const,planDays: 28 };
      preview = () => api.preview(actor,{ ...input,expectedTemplateVersion: version });
      apply = hash => api.apply(actor,"sized-eligibility-change",{ ...input,expectedTemplateVersion: change === "explicit stale" ? version+1 : version,acceptedQuoteHash: hash });
    } else {
      const api = editor(f), input = laneName === "classic" ? { subscriptionId: f.subscription,planDays: 30,base: [{ variantId: f.sku,qty: 2 }] }
        : { subscriptionId: f.subscription,action: "update_plan_length" as const,planDays: 30 };
      preview = () => api.preview(actor,{ ...input,expectedTemplateVersion: version });
      apply = hash => api.apply(actor,"native-eligibility-change",{ ...input,expectedTemplateVersion: change === "explicit stale" ? version+1 : version,acceptedQuoteHash: hash });
    }
    const quote = await preview();
    expect(quote.quoteHash).toMatch(/^[a-f0-9]{64}$/u);
    await pool.query("DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=$1", [f.subscription]);
    if (change === "missing method") await pool.query("DELETE FROM public.subscription_method_states WHERE subscription_id=$1", [f.subscription]);
    if (change === "missing anchor") await pool.query("UPDATE public.subscriptions SET next_cycle_at=NULL WHERE id=$1", [f.subscription]);
    const before = await snapshot(f);
    const refusal = change === "explicit stale" ? "subscription_edit_stale_template"
      : change === "missing method" ? "subscription_command_payment_blocked" : "subscription_edit_window_closed";
    await expect(apply(quote.quoteHash)).rejects.toMatchObject({ message: refusal });
    if (change !== "explicit stale") expect((await preview()).preview.blockedReason).toBe(change === "missing method" ? "missing_payment_method" : "edit_window_closed");
    expect(await snapshot(f)).toEqual(before);
  },
);

it.each(["derived","historical raw","ambiguous key","different event","different hash","line bound","reconnecting"] as const)(
  "LC9-D-079/D-125/S-015/S-020/S-021/S-029 legacy %s preserves the native receipt scope", async scenario => {
    const f = await fixture(), actor = { actorId: f.actor,clientId: f.client }, input = legacyRequest(f), key = "legacy-native-scope";
    const db = await pool.connect();
    let replay: Promise<unknown> | undefined;
    try {
      await db.query("BEGIN");
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.actor, role: "authenticated" })]);
      const args = [f.subscription,key,JSON.stringify(input.coreLines),"[]",{},input.cadenceDays,input.expectedTemplateVersion];
      if (scenario === "line bound") {
        await db.query("ROLLBACK");
        const before = await snapshot(f);
        await expect(bridge(f).preview(actor,key,{ ...input,coreLines: Array.from({ length: 7 }, () => input.coreLines[0]) }))
          .rejects.toMatchObject({ message: "subscription_edit_invalid_lines",code: "22023" });
        expect(await snapshot(f)).toEqual(before);
        return;
      }
      const preview = (await rpc(db,"customer_subscription_preview_bundle_as_actor",args)).preview;
      const originalHash = String(preview.quoteHash);
      const applied = await rpc(db,"customer_subscription_apply_bundle_as_actor", [...args.slice(0,2),originalHash,...args.slice(2)]);
      expect(applied.subscriptionAction).toMatchObject({ status: "applied",templateVersion: 2 });
      const accepted = { ...input,acceptedQuoteHash: scenario === "different hash" ? hash("different") : originalHash };
      if (scenario === "reconnecting") {
        const writePid = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        let readPid = 0;
        replay = bridge(f, async (connection, sql) => {
          if (!readPid && sql.startsWith("SELECT auth.uid()=")) readPid = (await connection.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        }).apply(actor,key,accepted);
        void replay.catch(() => {});
        await expect.poll(async () => readPid > 0 && (await pool.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS waiting", [readPid,writePid])).rows[0].waiting).toBe(true);
        await db.query("COMMIT");
      } else {
        if (scenario === "historical raw") {
          await db.query("UPDATE public.subscription_events SET idempotency_key=$2,payload=payload-'commandKeyIdentity' WHERE subscription_id=$1", [f.subscription,key]);
          await db.query("UPDATE public.subscription_edit_quotes SET idempotency_key=$2,command_key_identity=NULL WHERE subscription_id=$1", [f.subscription,key]);
        }
        if (scenario === "ambiguous key") await db.query("UPDATE public.subscription_events SET payload=payload||$2::jsonb WHERE subscription_id=$1", [f.subscription,{commandKeyIdentity: { derivation: "principal-sha256.v1",actorId: f.other }}]);
        if (scenario === "different event") await db.query("UPDATE public.subscription_events SET event_type='subscription.customer_self_service.remove_addon' WHERE subscription_id=$1", [f.subscription]);
        await db.query("COMMIT");
        await pool.query("DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=$1", [f.subscription]);
      }
      const before = await snapshot(f);
      replay ??= bridge(f).apply(actor,key,accepted);
      if (scenario === "ambiguous key" || scenario === "different event" || scenario === "different hash") {
        await expect(replay).rejects.toMatchObject({ message: scenario === "ambiguous key" ? "subscription_command_ambiguous_idempotency_key"
          : "subscription_edit_idempotency_conflict",code: "23505" });
      } else {
        expect(await replay).toEqual({ ...applied,subscriptionAction: { ...applied.subscriptionAction,status: "replayed" } });
      }
      expect(await snapshot(f)).toEqual(before);
    } finally {
      await db.query("ROLLBACK");
      if (replay) await Promise.allSettled([replay]);
      db.release();
    }
  },
);

it.each(["version","method","anchor","preview first"] as const)(
  "LC9-S-017 locked preview observes %s from one template", async change => {
    const f = await fixture(), actor = { actorId: f.actor,clientId: f.client };
    const previewDb = await pool.connect(), writer = await pool.connect(), observer = await pool.connect();
    const previewPid = (await previewDb.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const observerPid = (await observer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const key = BigInt(`0x${randomUUID().replaceAll("-","").slice(0,14)}`).toString();
    const options = editorOptions(f);
    const api = createPostgresPackageEditor({ ...options,withTransaction: async work => {
      await previewDb.query("BEGIN");
      try {
        const result = await work({ query: async (sql,values) => {
          const result = await previewDb.query(sql,values);
          if (change === "preview first" && sql.startsWith("SELECT s.*,")) {
            await previewDb.query("SELECT pg_advisory_lock($1::bigint)", [key]);
            await previewDb.query("SELECT pg_advisory_unlock($1::bigint)", [key]);
          }
          return result;
        } });
        await previewDb.query("COMMIT"); return result;
      } catch (error) { await previewDb.query("ROLLBACK"); throw error; }
    } });
    const input = { subscriptionId: f.subscription,planDays: 30,base: [{ variantId: f.sku,qty: 2 }] };
    const waiting = (first: number, second: number) =>
      expect.poll(async () => (await observer.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS waiting", [first,second])).rows[0].waiting).toBe(true);
    let preview: ReturnType<typeof api.preview> | undefined, moved: Promise<unknown> | undefined;
    try {
      if (change === "preview first") {
        await observer.query("SELECT pg_advisory_lock($1::bigint)", [key]);
        preview = api.preview(actor,input); void preview.catch(() => {});
        await waiting(previewPid,observerPid);
        moved = writer.query("UPDATE public.subscriptions SET template_version=2 WHERE id=$1", [f.subscription]);
        void moved.catch(() => {});
        await waiting(writerPid,previewPid);
        await observer.query("SELECT pg_advisory_unlock($1::bigint)", [key]);
        expect((await preview).preview).toMatchObject({ canApply: true,templateVersion: 1 });
        await moved;
        expect((await pool.query("SELECT template_version FROM public.subscription_quote_previews WHERE subscription_id=$1", [f.subscription])).rows).toEqual([{ template_version: 1 }]);
      } else {
        await writer.query("BEGIN");
        await writer.query("SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE", [f.subscription]);
        if (change === "anchor") await writer.query("UPDATE public.subscriptions SET next_cycle_at=NULL WHERE id=$1", [f.subscription]);
        if (change === "version") await writer.query("UPDATE public.subscriptions SET template_version=2 WHERE id=$1", [f.subscription]);
        if (change === "method") await writer.query("DELETE FROM public.subscription_method_states WHERE subscription_id=$1", [f.subscription]);
        preview = api.preview(actor,input); void preview.catch(() => {});
        await waiting(previewPid,writerPid);
        await writer.query("COMMIT");
        if (change === "version") expect((await preview).preview).toMatchObject({ templateVersion: 2,canApply: true });
        else expect((await preview).preview).toMatchObject({ templateVersion: 1,canApply: false,blockedReason: change === "method" ? "missing_payment_method" : "edit_window_closed" });
        expect((await pool.query("SELECT template_version FROM public.subscription_quote_previews WHERE subscription_id=$1", [f.subscription])).rows)
          .toEqual(change === "version" ? [{ template_version: 2 }] : []);
      }
    } finally {
      if (change === "preview first") await observer.query("SELECT pg_advisory_unlock($1::bigint)", [key]);
      if (change !== "preview first") await writer.query("ROLLBACK");
      await Promise.allSettled([preview,moved]);
      previewDb.release(); writer.release(); observer.release();
    }
  },
);
