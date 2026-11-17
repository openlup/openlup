import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresPackageEditor, createPostgresSizedEditor, createPostgresLegacyEditConsentBridge, type PackageEditorOptions, type SizedEditorOptions, type ExactSubscriptionEditRequest } from "@openlup/platform/subscriptions";
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
function editor(f: Fixture) {
  const options: PackageEditorOptions = { now: () => f.at,limits: { maximumPlanDays: 100,maximumBaseLines: 5,maximumAddonLines: 5,maximumQuantity: 100 },
    withTransaction: async work => { const db = await pool.connect(); await db.query("BEGIN"); try { const value = await work(db); await db.query("COMMIT"); return value; }
      catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); } },
    quoteCatalogReadPort: { listQuoteCatalogItems: async () => (await pool.query("SELECT id,sku FROM public.catalog_skus WHERE sellable_in_subscription")).rows.map(row => ({ variantId: String(row.id),skuCode: String(row.sku),sellability: { subscription: true } })) },
    portionModes: { full: { mode: "full",factor: 1 },reduced: { mode: "reduced",factor: 0.5 } },
    quotePort: { createServerAuthoritativeQuote: async request => {
      const lines = request.lines.map(line => ({ sku: line.sku,quantity: line.quantity,unitPriceGross: money(137),lineSubtotalGross: money(137*line.quantity) }));
      const total = money(lines.reduce((sum,line) => sum+line.lineSubtotalGross.amountMinor,0));
      return { quote: { lines,totalGross: total,subtotalGross: total,discountTotalGross: money(0) } };
    } },compositionRulesPort: { validateComposition: async () => ({ ok: true }),resizeComposition: async input => ({ coreLines: input.coreLines,constraint: input.lever.kind === "portionMode"
      ? { ...input.constraint,data: { ...input.constraint.data,mode: (input.lever.value as { portionMode: string }).portionMode,portionFactor: 1 } } : input.constraint }) },
    constraintMapper: { toCore: value => ({ kind: "example",version: 1,data: value ?? {} }),fromCore: value => value.data,nominalPlanDays: () => 28 } };
  return createPostgresPackageEditor(options);
}
it.each([false,true])("edit_consent_wrapped_classic_actor_equality[noop=%s]",async noop => {
  const f = await fixture(), api = editor(f), input = { subscriptionId: f.subscription,planDays: noop ? 28 : 30,base: [{ variantId: f.sku,qty: 2 }] };
  const preview = await api.preview({ actorId: f.actor,clientId: f.client },input), before = await snapshot(f);
  expect(preview.editConsent?.lines[0]).toMatchObject({ agreedUnitMinor: 100,newUnitMinor: 137,deltaMinor: 37 });
  await expect(api.apply({ actorId: f.other,clientId: f.client },"wrapped-other-actor",{ ...input,acceptedQuoteHash: preview.quoteHash })).rejects.toMatchObject({ message: "subscription_edit_quote_actor_mismatch" });
  expect(await snapshot(f)).toEqual(before);
  expect((await api.apply({ actorId: f.actor,clientId: f.client },"wrapped-same-actor",{ ...input,acceptedQuoteHash: preview.quoteHash })).status).toBe(noop ? "noop" : "applied");
});
it("edit_consent_old_unaccepted_preview_requires_refresh",async () => {
  const f = await fixture(), q = await record(f), before = await snapshot(f);
  await expect(editor(f).apply({ actorId: f.actor,clientId: f.client },"old-preview-refresh",{ subscriptionId: f.subscription,planDays: 30,base: [{ variantId: f.sku,qty: 2 }],acceptedQuoteHash: q.digest }))
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
  ...["01376_sql_guard","01377_sql_code","01378_sql_raise"].map(id => [`parity_LC9_${id}`,{ digest: "invalid" },"subscription_edit_quote_required"]),
  ...["01379_sql_guard","01380_sql_code","01381_sql_raise"].map(id => [`parity_LC9_${id}`,{ version: 0 },"subscription_edit_stale_template"]),
  ...["01382_sql_guard","01383_sql_code","01384_sql_raise"].map(id => [`parity_LC9_${id}`,{ expired: true },"subscription_edit_quote_expired"]),
  ...["01385_sql_guard","01386_sql_code","01387_sql_raise"].map(id => [`parity_LC9_${id}`,{ client: null },"subscription_command_invalid_input"]),
  ...["01388_sql_guard","01389_sql_code","01390_sql_raise"].map(id => [`parity_LC9_${id}`,{ foreign: true },"subscription_command_forbidden"]),
  ...["01391_sql_guard","01392_sql_code","01393_sql_raise"].map(id => [`parity_LC9_${id}`,{ version: 2 },"subscription_edit_stale_template"]),
] as const;
it.each(recorderCases)("%s",async (_name,patch,reason) => {
  const f = await fixture(), p = patch as { action?: string; digest?: string; version?: number; expired?: boolean; client?: null; foreign?: boolean };
  const expiry = p.expired ? f.at : (await pool.query("SELECT $1::timestamptz+interval '1 hour' AS at",[f.at])).rows[0].at;
  const digest = p.digest ?? hash(randomUUID()), action = p.action ?? "update_bundle";
  const args = [f.actor,p.foreign ? f.other : p.client === null ? null : f.client,f.subscription,action,digest,p.version ?? 1,expiry,{},{},{},f.at];
  const before = await snapshot(f);
  if (reason) { await expect(rpc(pool,"subscription_quote_preview_record",args)).rejects.toMatchObject({ message: reason,code: "22023" }); expect(await snapshot(f)).toEqual(before); }
  else expect(await rpc(pool,"subscription_quote_preview_record",args)).toMatchObject({ subscription_id: f.subscription,client_id: f.client,actor_id: f.actor,action,quote_hash: digest,template_version: 1,status: "previewed" });
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
  if (kind === "used") {
    const event = randomUUID(); await pool.query("INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,payload) VALUES($1,$2,'subscription.customer_self_service.update_package_template',$3,'{}')",[event,f.subscription,randomUUID()]);
    await rpc(pool,"subscription_quote_preview_mark_accepted",[q.preview.id,"original-parity-key",event,f.at]);
  }
  const now = kind === "expired" ? q.preview.expires_at : f.at;
  const code = kind === "action" ? "subscription_command_unsupported_action" : kind === "owner" ? "subscription_command_forbidden"
    : kind === "missing" ? "subscription_edit_quote_required" : kind === "expired" ? "subscription_edit_quote_expired" : "subscription_edit_quote_already_used";
  const before = await snapshot(f);
  await expect(rpc(pool,"subscription_quote_preview_take",[f.actor,kind === "owner" ? f.other : f.client,f.subscription,
    kind === "action" ? "unsupported" : "update_package_template",kind === "missing" ? hash("missing") : q.digest,1,key,now])).rejects.toMatchObject({ message: code,code: "22023" });
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
function sizedEditor(f: Fixture) {
  const options: SizedEditorOptions = { now: () => f.at,
    policy: { minimumCoreUnits: 1,maximumCoreLines: 3,maximumAddonLines: 3,maximumQuantity: 100,allowedCadences: [28,30],maximumExclusions: 8,maximumCatalogExclusions: 16,
      fixedThroughCycle: 2,graduationCycle: 3,portionModes: { full: { mode: "full",factor: 1 },reduced: { mode: "reduced",factor: 0.5 } } },
    withTransaction: async work => { const db = await pool.connect(); await db.query("BEGIN"); try { const result = await work(db); await db.query("COMMIT"); return result; }
      catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); } },
    readFacts: async () => ({ subscriptionId: f.subscription,clientId: f.client,subjectRef: f.subscription,exclusions: [],snapshot: { revision: 1 } }),
    resolveOptInNeed: async () => ({ dailyNeed: 1,snapshot: { revision: 1 } }),
    readCatalog: async () => [{ variantId: f.sku,sku: f.sku,groupId: f.sku,isAddon: false,sellable: true,physicalSize: 100,demandPerUnit: 30,
      documentRevisionId: f.sku,documentDigest: hash(f.sku),verified: true,exclusions: [],sellableNow: 100 }],
    assertCurrentFacts: async () => {},proposePortion: async ({ current }) => current.map(line => ({ variantId: line.variantId,qty: 1 })),
    quotePort: { createServerAuthoritativeQuote: async request => {
      const lines = request.lines.map(line => richLine(line.sku,line.quantity)),total = money(lines.reduce((sum,line) => sum+line.lineSubtotalGross.amountMinor,0));
      return { quote: { lines,currency: "XXX",taxIncluded: true,discounts: [],totalGross: total,subtotalGross: total,discountTotalGross: money(0),netTotal: total,taxTotal: money(0) } };
    } } };
  return createPostgresSizedEditor(options);
}
it.each([28,30])("edit_consent_wrapped_exact_actor_equality[update_plan_length,%s]",async planDays => {
  const f = await fixture(), actor = { actorId: f.actor,clientId: f.client },api = editor(f),request = { subscriptionId: f.subscription,action: "update_plan_length" as const,planDays };
  const preview = await api.preview(actor,request),before = await snapshot(f);
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
  expect(preview.editConsent?.lines[0]).toMatchObject({ agreedUnitMinor: 137,newUnitMinor: 137,deltaMinor: 0 });
  await expect(api.apply({ ...actor,actorId: f.other },"sized-other-actor",{ ...request,acceptedQuoteHash: preview.quoteHash })).rejects.toMatchObject({ message: "subscription_edit_quote_actor_mismatch" });
  expect(await snapshot(f)).toEqual(before);
  expect((await api.apply(actor,"sized-same-actor",{ ...request,acceptedQuoteHash: preview.quoteHash })).status).toBe(noop ? "noop" : "applied");
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
it.each(["swap_base_line","add_addon","remove_addon","update_addon_quantity","update_base_mix","update_portion"] as const)("edit_consent_wrapped_exact_actor_equality[%s]",async action => {
  const f = await fixture(), target = await extraSku(f,["add_addon","remove_addon","update_addon_quantity"].includes(action),["remove_addon","update_addon_quantity"].includes(action));
  const fields = action === "swap_base_line" ? { fromVariantId: f.sku,toVariantId: target }
    : action === "update_base_mix" ? { base: [{ variantId: target,qty: 2 }] }
      : action === "update_portion" ? { portionMode: "full" } : { variantId: target,...(action === "remove_addon" ? {} : { qty: 2 }) };
  const input = { subscriptionId: f.subscription,expectedTemplateVersion: 1,action,...fields } as ExactSubscriptionEditRequest;
  const actor = { actorId: f.actor,clientId: f.client },api = editor(f),preview = await api.preview(actor,input),before = await snapshot(f);
  await expect(api.apply({ ...actor,actorId: f.other },"exact-action-other",{ ...input,acceptedQuoteHash: preview.quoteHash })).rejects.toMatchObject({ message: "subscription_edit_quote_actor_mismatch" });
  expect(await snapshot(f)).toEqual(before);
  expect(["applied","noop"]).toContain((await api.apply(actor,"exact-action-same",{ ...input,acceptedQuoteHash: preview.quoteHash })).status);
});

it("edit_consent_prune_defaults_and_native_tie_break",async () => {
  const f = await fixture(),a = await record(f),b = await record(f);
  await pool.query("UPDATE public.subscription_quote_previews SET expires_at=$2::timestamptz-interval '8 days' WHERE subscription_id=$1",[f.subscription,f.at]);
  expect(await prune("7 days",1,f.at)).toBe(1);
  const kept = [a.preview.id,b.preview.id].sort()[1];
  expect((await pool.query("SELECT id FROM public.subscription_quote_previews WHERE subscription_id=$1",[f.subscription])).rows).toEqual([{ id: kept }]);
  expect((await pool.query("SELECT public.customer_self_service_prune_subscription_quote_previews() AS deleted")).rows[0].deleted).toBe(1);
});
it("edit_consent_actor_id_every_writer",async () => {
  const writers = (await pool.query("SELECT proname,prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace AND prosrc LIKE '%INSERT INTO public.subscription_quote_previews(%' ORDER BY proname")).rows;
  expect(writers.map(row => row.proname)).toEqual(["subscription_quote_preview_record"]);
  expect(writers[0].prosrc).toContain("actor_id=EXCLUDED.actor_id");
  expect(writers[0].prosrc).toContain("VALUES(s.id,p_client_id,p_actor_id");
});
