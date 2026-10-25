import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { reviewedBatchBytes, reviewedBatchPaths } from "../../scripts/reviewed-batch-rail.js";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertBatchedForward, batchedFunctionDefinitions, readReviewedForwardRegistry, sqlSha256, sqlStatements, type BatchedForwardBinding } from "../../scripts/reviewed-platform-forward.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { imageIo, imageReference, pullWithRetry, readCiImage } from "../../scripts/ci-image-pull.mjs";
import { readManagedMigrationChain } from "../../scripts/public-ci-pgtap.mjs";
import { assertBatchCatalog, assertSameSnapshot, batchSnapshot } from "./reviewedBatchCatalog.js";

import { AT, later, call, renewal, prepareOriginal, failure, positive, unchangedIdentity, type Renewal } from "./subscriptionNativeFixture.js";
import { createNewPurchaseStockAvailabilityPort } from "@openlup/platform/inventory";
import { deriveOfferAvailability } from "../../src/domains/commerce/offerAvailability.js";

const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
const fixture = (pin: BatchedForwardBinding) => reviewedBatchBytes(process.cwd(), process.cwd(), pin);
const managedImage = readCiImage("managed-batch-postgres"), nativeImage = readCiImage("test-postgres");
async function pullPinnedImage(graph: "native" | "managed", io = imageIo): Promise<string> {
  return pullWithRetry(graph === "native" ? nativeImage : managedImage, io);
}

describe("pinned image selection (Docker-free)", () => {
  it.each(["native", "managed"] as const)("reuses the exact local gate pin for %s without pulling", async graph => {
    const image = graph === "native" ? nativeImage : managedImage;
    const reference = imageReference(image, image.sources.at(-1));
    const pulls: string[] = [];
    const io = {
      exec: async (args: string[]) => {
        if (args[0] === "pull") pulls.push(args[1]);
        if (args[2] !== reference) throw new Error("No such image");
        return JSON.stringify([reference]);
      },
      sleep: async () => { throw new Error("warm gate must not wait"); },
      now: () => 0,
    };
    expect(await pullPinnedImage(graph, io)).toBe(reference);
    expect(pulls).toEqual([]);
  });
});

// Always part of the required test aggregate. Neither absent Docker nor absent
// PostgreSQL/pgTAP can turn a control proof into a skipped test or lexical PASS.
describe.each(["native", "managed"] as const)("exact batch catalog gate: %s", graph => {
  const portable = graph === "native";
  const directory = portable ? "db/platform/migrations" : "supabase/migrations";
  const pins = registry.batchedForwards!.filter(pin => pin.path.startsWith(directory));
  let container: PostgresContainer | undefined;
  let db: Pool;
  let connection: PoolClient;
  const preceding: Buffer[] = [];
  let replayRoot: string;
  let paths: string[];
  let interleaved: string;
  const applyCommittedBefore = async (limit: string) => {
    for (const path of paths.filter(path => path < limit && !pins.some(pin => pin.path === path))) {
      const bytes = readFileSync(join(replayRoot, path));
      if (portable && path !== interleaved) {
        const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
        expect([manifest.baseline, ...manifest.forward].find(unit => unit.file === path).sha256).toBe(sqlSha256(bytes));
      }
      preceding.push(bytes);
      await db.query(bytes.toString().replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
    }
    paths = paths.filter(path => path >= limit);
  };
  beforeAll(async () => {
    // Refuse holes before any fixture can fill a missing predecessor.
    reviewedBatchPaths(process.cwd(), directory, pins);
    for (const pin of pins) fixture(pin);
    replayRoot = mkdtempSync(join(tmpdir(), "openlup-batch-pg-"));
    cpSync(directory, join(replayRoot, directory), { recursive: true });
    // Stay between the 18:00 pin and the next pin on either rail without replacing committed bytes.
    const free = Array.from({ length: 60 }, (_, second) => `${directory}/202610241805${String(second).padStart(2, "0")}_unpinned_gate_probe.sql`)
      .find(path => !existsSync(join(replayRoot, path)));
    if (!free) throw new Error("Reviewed batch gate has no free interleaved probe filename");
    interleaved = free;
    writeFileSync(join(replayRoot, interleaved), "SELECT set_config('openlup.batch_interleaved', 'applied', false);", { flag: "wx" });
    paths = reviewedBatchPaths(replayRoot, directory, pins);
    if (!await dockerAvailable()) throw new Error("Reviewed batch gate requires real PostgreSQL and pgTAP");
    const image = await pullPinnedImage(graph);
    container = await runPostgresContainer({ name: `reviewed-batch-${graph}-${process.pid}`, password: "synthetic-conformance", image });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Reviewed batch PostgreSQL unavailable");
    db = new Pool({ connectionString: portable ? container.connectionString : container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:"), max: 1 });
    // Keep transaction/savepoint proofs on one connection even after expected refusals.
    connection = await db.connect();
    db.query = connection.query.bind(connection) as typeof db.query;
    expect((await db.query("SHOW standard_conforming_strings")).rows).toEqual([{ standard_conforming_strings: "on" }]);
    if (!portable) {
      // Same prerequisites and default-ACL discipline as public-ci-pgtap.
      await db.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
      for (const role of ["postgres", "supabase_admin"]) for (const scope of ["", " IN SCHEMA public"]) for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
        await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC, anon, authenticated, service_role`);
      }
      await db.query(`CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
        DO $$ DECLARE fn regprocedure; BEGIN
          FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p
            JOIN pg_depend d ON d.objid=p.oid AND d.classid='pg_proc'::regclass
            JOIN pg_extension e ON e.oid=d.refobjid WHERE e.extname='pgtap' AND d.deptype='e'
          LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres',fn); END LOOP;
        END $$;
        SET ROLE postgres; SET search_path=public,extensions; SELECT extensions.no_plan()`);
    }
    if (!portable) {
      readManagedMigrationChain(process.cwd()); // Verifies the committed complete managed prefix.
      expect(sqlSha256(readFileSync(`${directory}/00000000000000_platform_schema_baseline.sql`))).toBe(registry.baselineSha256);
    }
    await applyCommittedBefore(pins[0]!.path);
    // Reset dump session settings. Validate bodies of every new forward in PG.
    await db.query("SET check_function_bodies=on; SET search_path=public,extensions");
  }, postgresSetupTimeoutMs); // Includes a first managed PG17 image pull and the complete prefix.
  afterAll(async () => { connection?.release(); await closePostgres(container, db); if (replayRoot) rmSync(replayRoot, { recursive: true, force: true }); }, postgresTeardownTimeoutMs);

const previewSignature = 'public.subscription_command_preview(uuid,uuid,text,uuid,text,jsonb,timestamptz)';
const applySignature = 'public.subscription_command_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz)';
async function commandDefinition(signature=previewSignature):Promise<string> {
 return (await db.query('SELECT pg_get_functiondef($1::regprocedure) definition',[signature])).rows[0].definition;
}
async function commandFixture() {
 const f = await renewal(db);
 await db.query('DELETE FROM public.subscription_renewal_operations WHERE id=$1', [f.operation]);
 await db.query("UPDATE public.subscriptions SET next_cycle_at=$2,started_at='2026-01-01' WHERE id=$1", [f.subscription, later(200)]);
 const list = (await db.query("INSERT INTO public.price_lists(name,region_code,currency) VALUES('N2 command fixture','ZZ','XXX') RETURNING id")).rows[0].id;
 const sku = (await db.query('SELECT id FROM public.catalog_skus WHERE sku=$1', [f.snapshot.lines[0].sku])).rows[0].id;
 await db.query("UPDATE public.subscriptions SET price_list_id=$2,currency_code='XXX' WHERE id=$1", [f.subscription, list]);
 await db.query("UPDATE public.catalog_skus SET sellable_in_subscription=true,status='active' WHERE id=$1", [sku]);
 await db.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor,valid_from) VALUES($1,$2,350,'2026-01-01')", [list, sku]);
 await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,2,0,100,'XXX')", [f.subscription, sku]);
 await db.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [f.subscription]);
 const addon = randomUUID();
 await db.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1::uuid,$1::text,'Addon')", [addon]);
 await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status,sellable_in_subscription) VALUES($1::uuid,$1::uuid,$1::text,'Addon','active',true)", [addon]);
 await db.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor,valid_from) VALUES($1,$2,70,'2026-01-01')", [list, addon]);
 return {...f, actor:randomUUID(), sku, list, addon};
}
type Fixture = Awaited<ReturnType<typeof commandFixture>>;
const bundle = (f:Fixture) => ({coreLines:[{variantId:f.sku, qty:2}], compositionConstraint:{kind:'units', value:2}, expectedTemplateVersion:1});
async function raw(f:Fixture, key:string, action:string, payload:unknown={}, at=AT, apply=false) {
 // Explicit native SQL only. No TypeScript command store or replay short circuit.
 return (await db.query(`WITH receipt AS MATERIALIZED (SELECT public.subscription_command_${apply ? 'apply' : 'preview'}(
 $1::uuid,$2::uuid,$3::text,$4::uuid,$5::text,$6::jsonb,$7::timestamptz) result)
 SELECT result,result::text bytes FROM receipt`, [f.actor, f.client, key, f.subscription, action, JSON.stringify(payload), at])).rows[0] as {result:Record<string,unknown>;bytes:string};
}
async function effects(xmin=false) {
 const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
 const result: Record<string,unknown> = {};
 for (const {tablename} of tables) {
  const name = String(tablename).replaceAll('"', '""');
  result[tablename] = (await db.query(`SELECT count(*)::int count,COALESCE(jsonb_agg(
   ${xmin ? "jsonb_build_object('columns',to_jsonb(t),'xmin',t.xmin::text)" : 'to_jsonb(t)'}
   ORDER BY to_jsonb(t)::text),'[]'::jsonb) rows FROM public."${name}" t`)).rows[0];
 }
 return result;
}
type Scenario = {name:string; action?:string; payload?:(f:Fixture)=>unknown; setup?:(f:Fixture)=>Promise<unknown>; at?:string; status?:string; error?:string; apply?:boolean};
const scenarios: Scenario[] = [
 {name:'resize', action:'resize_bundle', payload:f=>({...bundle(f), coreLines:[{variantId:f.sku,qty:3}]})},
 {name:'update-bundle', action:'update_bundle'},
 {name:'update-package-template', action:'update_package_template',status:'noop', payload:f=>({...bundle(f),addonLines:[]})},
 {name:'cadence', action:'update_plan_length', payload:()=>({planDays:21,expectedTemplateVersion:1})},
 {name:'cadence-explicit', action:'update_plan_length', payload:()=>({cadenceDays:14,expectedTemplateVersion:1})},
 {name:'add-addon', action:'add_addon', payload:f=>({variantId:f.addon,qty:1,expectedTemplateVersion:1})},
 ...['remove_addon','update_addon_quantity'].map(action=>({name:action,action,payload:(f:Fixture)=>({variantId:f.addon,qty:2,expectedTemplateVersion:1}),setup:(f:Fixture)=>db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code) VALUES($1,$2,1,1,true,70,'XXX')",[f.subscription,f.addon])})),
 ...['set_next_cycle_date','skip_next_cycle','slide_next_cycle','cancel','pause','resume','order_now','reactivate','multi_cycle_prepaid'].map(action=>({name:`preview-${action}`,action,status:'refused'})),
 {name:'not-active',status:'refused',setup:f=>db.query("UPDATE public.subscriptions SET status='cancelled' WHERE id=$1",[f.subscription])},
 {name:'locked',status:'refused',setup:f=>db.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,$2,'payment_pending')",[f.subscription,later(200)])},
 {name:'dunning',status:'refused',setup:f=>db.query("INSERT INTO public.subscription_dunning_cases(subscription_id,client_id,idempotency_key) VALUES($1,$2,'n2-dunning')",[f.subscription,f.client])},
 {name:'expired-edit-window',status:'refused',at:later(500)},
 {name:'edit-window-boundary',status:'refused',at:later(128)},
 {name:'missing-payment-method',status:'refused',setup:f=>db.query('DELETE FROM public.subscription_method_states WHERE subscription_id=$1',[f.subscription])},
 {name:'stale-template',status:'refused',setup:f=>db.query('UPDATE public.subscriptions SET template_version=2 WHERE id=$1',[f.subscription])},
 {name:'missing-template',status:'refused',payload:f=>({...bundle(f),expectedTemplateVersion:undefined})},
 {name:'invalid-cadence',status:'refused',payload:f=>({...bundle(f),cadenceDays:91})},
 {name:'invalid-template-type',status:'refused',payload:f=>({...bundle(f),expectedTemplateVersion:'bad'})},
 {name:'overflow-template',status:'refused',payload:f=>({...bundle(f),expectedTemplateVersion:'999999999999999999999'})},
 {name:'missing-price-list',status:'refused',setup:f=>db.query('UPDATE public.subscriptions SET price_list_id=NULL,currency_code=NULL WHERE id=$1',[f.subscription])},
 {name:'invalid-composition',status:'refused',payload:f=>({...bundle(f),compositionConstraint:{version:1,data:{}}})},
 {name:'bundle-total-mismatch',action:'update_bundle',status:'refused',payload:f=>({...bundle(f),coreLines:[{variantId:f.sku,qty:3}]})},
 {name:'addon-not-found',action:'remove_addon',status:'refused',payload:f=>({variantId:f.addon,expectedTemplateVersion:1})},
 {name:'empty-lines',status:'refused',payload:f=>({...bundle(f),coreLines:[]})},
 {name:'invalid-lines',status:'refused',payload:f=>({...bundle(f),coreLines:[{variantId:'bad',qty:0}]})},
 {name:'duplicate-lines',status:'noop',payload:f=>({...bundle(f),coreLines:[{variantId:f.sku,qty:1},{variantId:f.sku,qty:1}]})},
 {name:'catalog-unavailable',status:'refused',setup:f=>db.query('DELETE FROM public.price_entries WHERE price_list_id=$1',[f.list])},
 {name:'invalid-preview-accepted-hash',error:'22023',payload:f=>({...bundle(f),acceptedQuoteHash:'a'.repeat(64)})},
 {name:'invalid-preview-payload',error:'22023',payload:()=>[]},
 {name:'forbidden',error:'22023',setup:async f=>{f.client=randomUUID();}},
 // N2 preview has no quote-expired refusal: an expired apply quote and an expired edit window are distinct.
 {name:'fresh-after-unrelated-expired-quote',setup:async f=>{await raw(f,'old-expired-n2-quote','resize_bundle',{...bundle(f),cadenceDays:21});await db.query("UPDATE public.subscription_edit_quotes SET expires_at='2026-01-01' WHERE subscription_id=$1",[f.subscription]);}},
 {name:'apply-expired-quote',apply:true,status:'refused',at:later(1)},
 {name:'apply-stale-template',apply:true,status:'refused',setup:f=>db.query('UPDATE public.subscriptions SET template_version=2 WHERE id=$1',[f.subscription])},
 {name:'apply-resize',apply:true},
];
async function proveFreshCommandDifferential() {
 const n2Definition = await commandDefinition();
 const n2Apply = await commandDefinition(applySignature);
 const sql = sqlStatements(fixture(pins.find(pin => pin.path.includes("20261024170000"))!).toString())
  .find(statement => statement.startsWith('CREATE FUNCTION public.subscription_command_preview('))!
  .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
 const preFold = sql.replace("(r.command->'payload')-'acceptedQuoteHash'", "r.command->'payload'-'acceptedQuoteHash'");
 expect(preFold).not.toBe(sql);
 expect(scenarios).toHaveLength(43);
 for (const scenario of scenarios) {
  await db.query('BEGIN');
  try {
   const f = await commandFixture(), key = `fresh-${scenario.name}`;
   let payload = scenario.payload ? scenario.payload(f) : {...bundle(f),cadenceDays:21};
   if (scenario.apply) {
    const preview = await raw(f, key, 'resize_bundle', payload);
    payload = {...payload as Record<string,unknown>, acceptedQuoteHash:preview.result.quoteHash};
   }
   await scenario.setup?.(f);
   // Two UUID defaults are nondeterministic incidental receipt identities. Fix them in this
   // rolled-back fixture only; no returned bytes or row columns are masked/normalized.
   for (const table of ['subscription_edit_quotes','subscription_command_receipts']) {
    const id = randomUUID();
    await db.query(`ALTER TABLE public.${table} ALTER COLUMN id SET DEFAULT '${id}'::uuid`);
   }
   // Successful apply also inserts an event. Fix its incidental identity for the same reason.
   if (scenario.apply) for (const table of ['subscription_events','subscription_lines']) await db.query(`ALTER TABLE public.${table} ALTER COLUMN id SET DEFAULT '${randomUUID()}'::uuid`);
   const baseline = await effects();
   await db.query('SAVEPOINT differential');
   async function run() {
    await db.query('SAVEPOINT expected_error');
    let outcome: unknown;
    try {
     const response = await raw(f, key, scenario.action ?? 'resize_bundle', payload, scenario.at ?? AT, scenario.apply);
     expect(scenario.error,scenario.name).toBeUndefined();
     expect(response.result.status,scenario.name).toBe(scenario.status ?? (scenario.apply ? 'applied' : 'previewed'));
     outcome = {bytes:response.bytes};
    } catch (error) {
     if (!scenario.error) throw error;
     expect(error).toMatchObject({code:scenario.error});
     outcome = {code:(error as {code:string}).code, message:(error as Error).message};
     await db.query('ROLLBACK TO expected_error');
    }
    await db.query('RELEASE SAVEPOINT expected_error');
    return {outcome,effects:await effects()};
   }
   await db.query(preFold);
   const before = await run();
   await db.query('ROLLBACK TO differential');
   expect(await effects()).toEqual(baseline);
   await db.query(sql);
   const after = await run();
   // Literal UTF-8 byte equality of JSONB text responses and complete ordered table snapshots.
   expect(JSON.stringify(after), scenario.name).toBe(JSON.stringify(before));
  } finally { await db.query('ROLLBACK'); }
 }
 expect(await commandDefinition()).toBe(n2Definition);
 expect(await commandDefinition(applySignature)).toBe(n2Apply);
}

  async function managedFailureFixture() {
    const client = randomUUID(), subscription = randomUUID(), cycle = randomUUID(), order = randomUUID();
    await db.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `m10-control-${client}@example.invalid`]);
    await db.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,currency,status,started_at,next_cycle_at) VALUES($1,$2,28,'XTS','active','2026-01-01','2026-10-01')", [subscription, client]);
    await db.query("INSERT INTO public.subscription_cycles(id,subscription_id,cycle_number,scheduled_at,status,engine_idempotency_key,retry_attempt) VALUES($1,$2,2,'2026-10-01','payment_failed',$3,1)", [cycle, subscription, randomUUID()]);
    await db.query("INSERT INTO public.commerce_orders(id,client_id,currency,region_code,status,total_cents,subtotal_cents,mode,subscription_id,subscription_cycle_id) VALUES($1,$2,'XTS','ZZ','draft',2680,2680,'subscription_cycle',$3,$4)", [order,client,subscription,cycle]);
    await db.query("SET LOCAL ROLE service_role");
    const intent = (await db.query("SELECT public.commerce_payment_control_create_intent($1,'subscription_cycle',$2,$3,$4,2680,'XTS','{}') AS r",[randomUUID(),order,subscription,cycle])).rows[0].r.paymentIntent.id;
    await db.query("SET LOCAL ROLE postgres");
    await db.query("UPDATE public.commerce_orders SET status='pending_payment' WHERE id=$1", [order]);
    const payment = (await db.query("SELECT payment_id FROM public.commerce_payment_intents WHERE id=$1",[intent])).rows[0].payment_id;
    const attempt = randomUUID();
    await db.query("INSERT INTO public.commerce_payment_attempts(id,payment_intent_id,payment_id,provider,idempotency_key,status,amount_cents,currency) VALUES($1,$2,$3,'example',$4,'failed',2680,'XTS')",[attempt,intent,payment,randomUUID()]);
    return { client, subscription, cycle, order, intent, payment, attempt };
  }
  type ManagedFailure = Awaited<ReturnType<typeof managedFailureFixture>>;
  const legacyFailure = async (f: ManagedFailure, key = randomUUID(), rung = 1) => {
    await db.query("SET LOCAL ROLE service_role");
    try {
      return (await db.query("SELECT public.subscription_handle_payment_failure_dunning($1,$2,$3,$4,$5,$6,NULL,'declined','2026-10-25'::timestamptz,'soft_retryable') AS r",[key,f.cycle,f.subscription,f.order,f.intent,rung])).rows[0].r;
    } finally { await db.query("SET LOCAL ROLE postgres"); }
  };
  const appliedEvent = async (f: ManagedFailure, attempt = f.attempt, rung = 1) => {
    await db.query("INSERT INTO public.subscription_events(subscription_id,cycle_id,event_type,idempotency_key,payload) VALUES($1,$2,'subscription.payment_failed',$3,$4)",[f.subscription,f.cycle,randomUUID(),{source:'payment.control.v0',paymentIntentId:f.intent,paymentAttemptId:attempt,retryAttempt:rung}]);
  };
  async function seedLegacyBackfills() {
    for (const mode of ["unique", "ambiguous", "missing event", "revoked token", "closed", "historical receipt"] as const) {
      const f = await managedFailureFixture();
      const result = await legacyFailure(f);
      if (mode !== "missing event") await appliedEvent(f);
      if (mode === "ambiguous") {
        const other = randomUUID();
        await db.query("INSERT INTO public.commerce_payment_attempts(id,payment_intent_id,payment_id,provider,idempotency_key,status,amount_cents,currency) VALUES($1,$2,$3,'example',$4,'failed',2680,'XTS')",[other,f.intent,f.payment,randomUUID()]);
        await appliedEvent(f,other);
      }
      if (mode === "historical receipt") {
        const newer = randomUUID();
        await db.query("INSERT INTO public.commerce_payment_attempts(id,payment_intent_id,payment_id,provider,idempotency_key,status,amount_cents,currency) VALUES($1,$2,$3,'example',$4,'failed',2680,'XTS')",[newer,f.intent,f.payment,randomUUID()]);
        await appliedEvent(f,newer,2);
        await db.query("UPDATE public.subscription_cycles SET retry_attempt=2 WHERE id=$1",[f.cycle]);
        await legacyFailure(f,randomUUID(),2);
      }
      if (mode === "revoked token") await db.query("UPDATE public.subscription_payment_recovery_tokens SET revoked_at='2026-10-26' WHERE case_id=$1",[result.subscriptionDunning.caseId]);
      if (mode === "closed") await db.query("UPDATE public.subscription_dunning_cases SET status='recovered',recovered_at='2026-10-26' WHERE id=$1",[result.subscriptionDunning.caseId]);
    }
  }

  if (!portable) it("installs the selected subset without the excluded reader role; seals helpers and refuses fresh legacy NULL", async () => {
    await db.query("BEGIN");
    try {
      // The historical baseline requires this role. Remove its baseline-only
      // grants/policies in this disposable transaction before testing the subset.
      await db.query("RESET ROLE; DROP OWNED BY openlup_mcp_reader; DROP ROLE openlup_mcp_reader; CREATE ROLE m10_control_host_reader NOLOGIN; SET ROLE postgres");
      expect((await db.query("SELECT 1 FROM pg_roles WHERE rolname='openlup_mcp_reader'")).rows).toEqual([]);
      const selected = ["20261024155000", "20261024185000", "20261024185100", "20261024160000", "20261025090000", "20261025090100", "20261024182000"];
      for (const version of selected) await db.query(fixture(pins.find(p => p.path.includes(version))!).toString());
      const port = pins.find(p => p.path.includes("20261025090000"))!;
      for (const fn of port.functions.filter(f => f.beforeSha256 === null)) {
        const inner = fn.signature.includes("before_cancel_fence") || fn.signature.includes("before_sub_lock");
        for (const role of ["anon", "authenticated", "m10_control_host_reader", "service_role"]) {
          expect((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed",[role,fn.signature])).rows[0].allowed).toBe(role === "service_role" && !inner);
        }
      }
      const f = await managedFailureFixture();
      await appliedEvent(f); // Identity exists durably, but NULL must never infer it.
      const before = await batchSnapshot(db);
      await db.query("SAVEPOINT legacy_null; SET LOCAL ROLE service_role");
      await expect(db.query("SELECT public.subscription_handle_payment_failure_dunning($1,$2,$3,$4,$5,1,NULL,'declined','2026-10-25'::timestamptz,'soft_retryable')",[randomUUID(),f.cycle,f.subscription,f.order,f.intent])).rejects.toMatchObject({code:"55000",message:"subscription_dunning_failed_attempt_unattributed"});
      await db.query("ROLLBACK TO legacy_null; SET LOCAL ROLE postgres");
      assertSameSnapshot(before, await batchSnapshot(db));
      await db.query("SET LOCAL ROLE service_role");
      const response = (await db.query("SELECT public.subscription_handle_payment_failure_dunning($1,$2,$3,$4,$5,1,NULL,'declined','2026-10-25'::timestamptz,'soft_retryable',$6) r",[randomUUID(),f.cycle,f.subscription,f.order,f.intent,f.attempt])).rows[0].r;
      expect(response.subscriptionDunning).toMatchObject({status:"open",replayed:false});
      const opened = (await db.query("SELECT public.subscription_open_dunning_from_failed_payment_result($1,$2,NULL,'declined','2026-10-25'::timestamptz,'soft_retryable',$3) r",[randomUUID(),f.intent,f.attempt])).rows[0].r;
      expect(opened.subscriptionWebhookDunning).toMatchObject({opened:true,replayed:true});
      await db.query("SET LOCAL ROLE postgres");
      for (const role of ["anon", "authenticated", "m10_control_host_reader", "service_role"]) {
        await db.query("SAVEPOINT denied; SET LOCAL ROLE " + role);
        await expect(db.query("SELECT public.subscription_open_dunning_before_sub_lock('control-denied',$1,NULL,NULL,now(),NULL,$2)",[f.intent,f.attempt])).rejects.toMatchObject({code:"42501"});
        await db.query("ROLLBACK TO denied; SET LOCAL ROLE postgres");
        if (role !== "service_role") {
          await db.query("SAVEPOINT public_denied; SET LOCAL ROLE " + role);
          await expect(db.query("SELECT public.subscription_open_dunning_from_failed_payment_result('control-denied',$1,NULL,NULL,now(),NULL,$2)",[f.intent,f.attempt])).rejects.toMatchObject({code:"42501"});
          await db.query("ROLLBACK TO public_denied; SET LOCAL ROLE postgres");
        }
      }
      await db.query("SAVEPOINT absent_role");
      const seam = pins.find(p => p.path.includes("20261024175000"))!;
      const statements = sqlStatements(fixture(seam).toString());
      await db.query(statements[0]!);
      await expect(db.query(statements[1]!)).rejects.toMatchObject({code:"42704"});
      await db.query("ROLLBACK TO absent_role");
    } finally { await db.query("ROLLBACK"); }
  }, 120_000);

  it.each(pins)("proves exact objects, ACLs and rows after the integrated prefix: $path", async pin => {
    await applyCommittedBefore(pin.path);
    if (pin.path > interleaved) expect((await db.query("SELECT current_setting('openlup.batch_interleaved') AS value")).rows).toEqual([{ value: "applied" }]);
    const bytes = fixture(pin);
    assertBatchedForward(pin, bytes, preceding);
    if (!portable && pin.path.includes("20261025090000")) {
      await db.query("BEGIN");
      try {
        await seedLegacyBackfills();
        const old = await batchSnapshot(db);
        await db.query(bytes.toString());
        await assertBatchCatalog(db, pin, bytes, old, await batchSnapshot(db));
        await db.query("SAVEPOINT catalog_attack");
        for (const attack of [
          "UPDATE public.subscription_dunning_cases SET failed_payment_attempt_id=NULL WHERE failed_payment_attempt_id IS NOT NULL;",
          "UPDATE public.commerce_idempotency_keys SET metadata='{}' WHERE scope='subscription.dunning.failure';",
          "GRANT EXECUTE ON FUNCTION public.subscription_open_dunning_before_sub_lock(text,uuid,text,text,timestamptz,text,uuid) TO service_role;",
          "ALTER TABLE public.subscription_dunning_cases VALIDATE CONSTRAINT subscription_dunning_cases_failed_attempt_fkey;",
          "ALTER TABLE public.subscription_dunning_cases ALTER COLUMN failure_observation_result SET DEFAULT '{}'::jsonb;",
        ]) {
          await db.query(attack);
          await expect(assertBatchCatalog(db,pin,bytes,old,await batchSnapshot(db)),attack).rejects.toThrow();
          await db.query("ROLLBACK TO catalog_attack");
        }
      } finally { await db.query("ROLLBACK"); }
    }
    const before = await batchSnapshot(db);
    await db.query("BEGIN");
    try {
      await db.query(bytes.toString());
      await assertBatchCatalog(db, pin, bytes, before, await batchSnapshot(db));
      if (!portable && pin.path.endsWith("20261024185000_provider_refund_evidence.sql")) {
        await db.query(`GRANT EXECUTE ON FUNCTION ${pin.functions[0]!.signature} TO authenticated`);
        await expect(assertBatchCatalog(db, pin, bytes, before, await batchSnapshot(db))).rejects.toThrow();
      }
    } finally { await db.query("ROLLBACK"); }
    assertSameSnapshot(before, await batchSnapshot(db));
    const attacks = portable && pin.path.includes("20261024184000")
      ? [`REVOKE EXECUTE ON FUNCTION ${pin.functions[0]!.signature} FROM PUBLIC;`]
      : portable && /20261024184[56]00/u.test(pin.path)
        ? [`GRANT EXECUTE ON FUNCTION ${pin.functions[0]!.signature} TO authenticated;`]
      : !portable && pin.path.includes("20261024175000")
        ? ["CREATE INDEX unpinned_existing_table_index ON public.subscriptions(id);"] : [];
    for (const attack of attacks) {
      const sql = bytes.toString() + "\n" + attack;
      const repinned = { ...pin, sha256: sqlSha256(sql), statements: sqlStatements(sql).map(statement => ({ sha256: sqlSha256(statement), ...(!/^CREATE(?: OR REPLACE)? FUNCTION /u.test(statement) ? { sql: statement } : {}) })) };
      if (!portable) expect(() => assertBatchedForward(repinned, Buffer.from(sql), preceding)).not.toThrow();
      await db.query("BEGIN");
      try {
        await db.query(sql);
        await expect(assertBatchCatalog(db, repinned, Buffer.from(sql), before, await batchSnapshot(db)), attack).rejects.toThrow();
      } finally { await db.query("ROLLBACK"); }
      assertSameSnapshot(before, await batchSnapshot(db));
    }
    await db.query(bytes.toString());
    preceding.push(bytes);
    if (portable && pin.path.includes('20261024170000')) await proveFreshCommandDifferential();

    if (!portable) {
    const tap = (await db.query(`SELECT extensions.is(
      (SELECT count(*) FROM pg_proc WHERE oid=ANY(ARRAY(SELECT to_regprocedure(name) FROM unnest($1::text[]) name))),
      $2::bigint,$3::text) AS result`, [pin.functions.map(fn => fn.signature), pin.functions.length, `${pin.path}: exact pinned function identities exist`])).rows[0].result;
    expect(tap).toMatch(/^ok [0-9]+ - /u);
    }
  }, 120_000);
  if (!portable) it("retains all nine donor-current CREATE hashes after both inert ports", async () => {
    const current = new Map<string,string>();
    for (const pin of pins) for (const [signature,digest] of batchedFunctionDefinitions(fixture(pin))) current.set(signature,digest);
    const port = pins.find(p => p.path.includes("20261025090000"))!;
    const advance = pins.find(p => p.path.includes("20261025090100"))!;
    for (const fn of port.functions) {
      const final = advance.functions.find(f => f.signature === fn.signature) ?? fn;
      expect(current.get(fn.signature)).toBe(final.afterSha256);
      const body = sqlStatements(fixture(advance.functions.includes(final) ? advance : port).toString()).find(sql => batchedFunctionDefinitions(Buffer.from(sql)).has(fn.signature))!;
      expect((await db.query("SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure",[fn.signature])).rows[0].prosrc).toBe(/AS (\$[a-z_0-9]*\$)([\s\S]*)\1;$/iu.exec(body)![2]);
    }
  });

  if (portable) {
const scoped = async (fn:()=>Promise<void>) => { await db.query('BEGIN'); try { await fn(); } finally { await db.query('ROLLBACK'); } };
const normalDueSignature = 'public.subscription_stock_wait_normal_due(integer,timestamptz)';
// The old filter-after-LIMIT body is an executable mutant, confined to a savepoint.
const normalDueAfterLimit = `CREATE OR REPLACE FUNCTION public.subscription_stock_wait_normal_due(p_limit integer DEFAULT 50,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
 SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.scheduled_at,d.subscription_id),'[]'::jsonb)
 FROM public.subscription_list_due_renewals(p_now,p_limit) d
 WHERE NOT EXISTS(SELECT 1 FROM public.subscription_stock_wait_cases c
  WHERE c.subscription_id=d.subscription_id AND c.scheduled_at=d.scheduled_at AND c.state IN ('waiting','stock_secured'));
$$`;
// These rows use the same committed native prefix and landed, registry-pinned N3 bytes as the catalog gate above.
it.each([
 { name: '(i) backlog larger than limit', limit: 2, states: ['waiting','stock_secured','waiting',null,null,null] },
 { name: '(ii) backlog exactly at limit', limit: 2, states: ['waiting','waiting',null,null,null] },
 { name: '(iii) interleaved normal rows', limit: 3, states: [null,'waiting',null,'stock_secured',null,null] },
 { name: '(iv) no waiting rows', limit: 2, states: [null,null,null] },
] as const)('N3 normal_due $name', async ({limit,states}) => scoped(async () => {
 // Isolate this page from other gate witnesses; all changes roll back.
 await db.query("UPDATE public.subscriptions SET status='paused' WHERE status='active'");
 const normal: {subscriptionId:string;scheduled:string}[] = [];
 for (const [index,state] of states.entries()) {
  // Reverse insertion order within each tie, using fixed UUIDs so a missing
  // subscription-id tie-break cannot hide behind the base reader's own result.
  const f = await renewal(db,10,1,`00000000-0000-4000-8000-${String(states.length-index).padStart(12,'0')}`);
  const scheduled = later(-24 + Math.floor(index / 2));
  await db.query('UPDATE public.subscriptions SET next_cycle_at=$2 WHERE id=$1',[f.subscription,scheduled]);
  await db.query('UPDATE public.subscription_renewal_operations SET scheduled_at=$2 WHERE id=$1',[f.operation,scheduled]);
  if (state) await db.query(`INSERT INTO public.subscription_stock_wait_cases(
   subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,
   due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits)
   VALUES($1,$2,$3,$4,2,$5,'{}',$6,$7,$8,'[]')`,
   [f.subscription,f.client,f.operation,scheduled,state,f.snapshot,f.fingerprint,f.identity]);
  else normal.push({subscriptionId:f.subscription,scheduled});
 }
 // At this clock the claim leases have expired: waits also occupy the base page.
 const base = (await db.query(`SELECT to_jsonb(d) AS row FROM public.subscription_list_due_renewals($1,500) d`,[later(1)])).rows.map(r=>r.row);
 expect(base).toHaveLength(states.length);
 const expectedIds = normal.sort((a,b)=>a.scheduled.localeCompare(b.scheduled)||a.subscriptionId.localeCompare(b.subscriptionId))
  .slice(0,limit).map(row=>row.subscriptionId);
 const expected = expectedIds.map(id=>base.find(row=>row.subscription_id===id));
 expect(expected).toHaveLength(limit);
 const definition = await commandDefinition(normalDueSignature);
 await db.query('SAVEPOINT n3_filter_after_limit');
 try {
  await db.query(normalDueAfterLimit);
  const oldPage = await call(db,'subscription_stock_wait_normal_due',[limit,later(1)]);
  if (states.some(state=>state!==null)) {
   expect(oldPage).not.toEqual(expected);
   expect(oldPage.length).toBeLessThan(limit);
  } else expect(oldPage).toEqual(expected);
 } finally {
  await db.query('ROLLBACK TO n3_filter_after_limit');
  await db.query('RELEASE SAVEPOINT n3_filter_after_limit');
 }
 expect(await commandDefinition(normalDueSignature)).toBe(definition);
 const before = await effects(true);
 expect(await call(db,'subscription_stock_wait_normal_due',[limit,later(1)])).toEqual(expected);
 expect(await effects(true)).toEqual(before);
 if (states.every(state=>state===null)) {
  const page = (await db.query('SELECT to_jsonb(d) AS row FROM public.subscription_list_due_renewals($1,$2) d',[later(1),limit])).rows.map(r=>r.row);
  expect(expected).toEqual(page);
 }
}));
const n3Candidates='public.subscription_stock_wait_candidates(integer,timestamptz)';
const n3Frozen='public.subscription_stock_wait_frozen(uuid,timestamptz)';
const n3Deficits='public.subscription_stock_wait_deficits(jsonb,uuid,timestamptz)';
async function waitingCase(f:Renewal) {
 await call(db,'subscription_refuse_renewal_preflight',[f.operation,f.token,'inventory_unavailable',AT]);
 return (await db.query(`INSERT INTO public.subscription_stock_wait_cases(subscription_id,client_id,renewal_operation_id,
  scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits)
  VALUES($1,$2,$3,$4,2,'waiting','{}',$5,$6,$7,'[]') RETURNING id`,
  [f.subscription,f.client,f.operation,AT,f.snapshot,f.fingerprint,f.identity])).rows[0].id as string;
}
async function frozenWitness() {
 const f=await renewal(db);await waitingCase(f);
 const frozen=await call(db,'subscription_stock_wait_frozen',[f.subscription,AT]);
 expect(frozen).toMatchObject({operationId:f.operation,snapshot:f.snapshot});
 const before=await effects(true);
 expect(await call(db,'subscription_stock_wait_frozen',[f.subscription,AT])).toEqual(frozen);
 expect(await effects(true)).toEqual(before);
 for(const [name,sql] of [
  ['paused',"UPDATE public.subscriptions SET status='paused' WHERE id=$1"],
  ['superseded',"UPDATE public.subscriptions SET next_cycle_at=next_cycle_at+interval '1 day' WHERE id=$1"],
 ] as const) {
  await db.query('SAVEPOINT frozen_state');
  try {
   await db.query(sql,[f.subscription]);
   const snapshot=await effects(true);
   expect(await call(db,'subscription_stock_wait_frozen',[f.subscription,AT]),name).toBeNull();
   expect(await effects(true)).toEqual(snapshot);
  }finally{await db.query('ROLLBACK TO frozen_state');await db.query('RELEASE SAVEPOINT frozen_state');}
 }
}
async function pausedWaitWitness() {
 const f=await renewal(db),id=await waitingCase(f);
 await db.query("UPDATE public.subscriptions SET status='paused' WHERE id=$1",[f.subscription]);
 const before=await effects(true);
 await call(db,'subscription_stock_wait_candidates',[500,later(1)]);
 expect((await db.query('SELECT state FROM public.subscription_stock_wait_cases WHERE id=$1',[id])).rows)
  .toEqual([{state:'waiting'}]);
 expect(await effects(true)).toEqual(before);
 await db.query("UPDATE public.subscriptions SET status='cancelled' WHERE id=$1",[f.subscription]);
 await call(db,'subscription_stock_wait_candidates',[500,later(1)]);
 expect((await db.query('SELECT state,block_reason FROM public.subscription_stock_wait_cases WHERE id=$1',[id])).rows)
  .toEqual([{state:'closed',block_reason:'schedule_superseded'}]);
 const closed=await effects(true);
 await call(db,'subscription_stock_wait_candidates',[500,later(1)]);
 expect(await effects(true)).toEqual(closed);
}
async function deficitWitness() {
 const f=await renewal(db,2);
 await call(db,'fulfillment_reserve_subscription_renewal',[f.operation,f.token,900,AT]);
 await db.query(`UPDATE public.fulfillment_inventory_reservation_lines SET quantity=1 WHERE reservation_id IN
  (SELECT id FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=$1)`,[f.operation]);
 const snapshot={...f.snapshot,lines:f.snapshot.lines.map(line=>({...line,quantity:3}))};
 const input=[JSON.stringify(snapshot),f.operation,AT];
 const before=await effects(true);
 expect(await call(db,'subscription_stock_wait_deficits',input)).toEqual([
  {sku:f.snapshot.lines[0].sku,requiredUnits:3,reservedUnits:1,availableUnits:1,missingUnits:1}]);
 expect(await effects(true)).toEqual(before);
 await db.query('UPDATE public.fulfillment_stock_current SET for_sale_quantity=3,total_quantity=3 WHERE source_key=$1',[f.source]);
 const stocked=await effects(true);
 expect(await call(db,'subscription_stock_wait_deficits',input)).toEqual([]);
 expect(await effects(true)).toEqual(stocked);
 await db.query('SAVEPOINT deficit_refusal');
 await db.query("UPDATE public.fulfillment_stock_current SET stale_after=$2 WHERE source_key=$1",[f.source,later(0.5)]);
 await expect(call(db,'subscription_stock_wait_deficits',[input[0],f.operation,later(1)])).rejects.toMatchObject({message:'stock_wait_stock_stale',code:'P0001'});
 await db.query('ROLLBACK TO deficit_refusal');await db.query('RELEASE SAVEPOINT deficit_refusal');
 expect(await effects(true)).toEqual(stocked);
}
async function resumedWitness() {
 const f=await renewal(db),original=await prepareOriginal(db,f);
 const id=(await db.query(`INSERT INTO public.subscription_stock_wait_cases(subscription_id,client_id,renewal_operation_id,
  scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits)
  VALUES($1,$2,$3,$4,2,'stock_secured','{}',$5,$6,$7,'[]') RETURNING id`,
  [f.subscription,f.client,f.operation,AT,f.snapshot,f.fingerprint,f.identity])).rows[0].id;
 for(const state of ['stock_secured','closed']) {
  await db.query('UPDATE public.subscription_stock_wait_cases SET state=$2 WHERE id=$1',[id,state]);
  const before=await effects(true);
  expect(await call(db,'subscription_stock_wait_mark_resumed',[original.orderId]),state).toBeNull();
  expect(await effects(true)).toEqual(before);
 }
 await db.query("UPDATE public.subscription_stock_wait_cases SET state='stock_secured' WHERE id=$1",[id]);
 await call(db,'payment_truth_ingest_event',[`resume-${f.operation}`,'e'.repeat(64),`resume-key-${f.operation}`,
  original.settlementIntentId,'captured',f.snapshot.totalAmountMinor,'XXX',later(1),null,null,
  {externalRef:`resume-${f.operation}`},null,null,'recovered']);
 // Closed callbacks must also be no-ops after payment; the unpaid predicate cannot mask this arm.
 await db.query("UPDATE public.subscription_stock_wait_cases SET state='closed' WHERE id=$1",[id]);
 const paidClosed=await effects(true);
 expect(await call(db,'subscription_stock_wait_mark_resumed',[original.orderId])).toBeNull();
 expect(await effects(true)).toEqual(paidClosed);
 await db.query("UPDATE public.subscription_stock_wait_cases SET state='stock_secured' WHERE id=$1",[id]);
 // Native fulfillment proof is a consumed original reservation and a recorded shipment.
 await db.query("UPDATE public.fulfillment_inventory_reservations SET status='consumed' WHERE renewal_operation_id=$1",[f.operation]);
 await db.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('ctl5-port','3pl',true) ON CONFLICT DO NOTHING");
 const shipment=(await db.query(`INSERT INTO public.fulfillment_shipments(order_id,port_key,provider_type,create_idempotency_key)
  VALUES($1,'ctl5-port','3pl',$2) RETURNING id`,[original.orderId,`create-${f.operation}`])).rows[0].id;
 await db.query('SAVEPOINT resumed_refusal');
 await db.query("INSERT INTO public.commerce_order_holds(order_id,reason,status,idempotency_key) VALUES($1,'manual_support','active',$2)",[original.orderId,`hold-${f.operation}`]);
 await expect(call(db,'subscription_stock_wait_mark_resumed',[original.orderId])).rejects.toMatchObject({code:'22023',message:'stock_wait_realization_admission_missing'});
 await db.query('ROLLBACK TO resumed_refusal');await db.query('RELEASE SAVEPOINT resumed_refusal');
 for(const status of ['paid','fulfillment_pending','fulfilled']) {
  await db.query('SAVEPOINT paid_realization');
  try {
   await db.query('UPDATE public.commerce_orders SET status=$2 WHERE id=$1',[original.orderId,status]);
   const result=await call(db,'subscription_stock_wait_mark_resumed',[original.orderId]);
   expect(result,status).toMatchObject({state:'resumed',order_id:original.orderId,fulfillment_id:shipment});
   expect((await db.query("SELECT count(*)::integer count FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription_stock_wait.resumed'",[id])).rows)
    .toEqual([{count:1}]);
   const resumed=await effects(true);
   expect(await call(db,'subscription_stock_wait_mark_resumed',[original.orderId])).toEqual(result);
   expect(await effects(true)).toEqual(resumed);
  }finally{await db.query('ROLLBACK TO paid_realization');await db.query('RELEASE SAVEPOINT paid_realization');}
 }
}
async function eligiblePageWitness() {
 // Stock-only refusals carrying a provider observation must not fill the page before filtering.
 await db.query("UPDATE public.subscriptions SET status='paused' WHERE status='active'");
 const invalid=await renewal(db),valid=await renewal(db);
 await waitingCase(invalid);await waitingCase(valid);
 await db.query('UPDATE public.subscription_renewal_operations SET scheduled_at=$2 WHERE id=$1',[invalid.operation,later(-1)]);
 await db.query('UPDATE public.subscriptions SET next_cycle_at=$2 WHERE id=$1',[invalid.subscription,later(-1)]);
 await db.query('UPDATE public.subscription_stock_wait_cases SET scheduled_at=$2 WHERE renewal_operation_id=$1',[invalid.operation,later(-1)]);
 await db.query(`INSERT INTO public.subscription_renewal_outcomes(renewal_operation_id,operation_fingerprint,event_key,outcome,reason,external_ref,occurred_at)
  VALUES($1,$2,'provider-stock-observation','refused','inventory_unavailable','provider-owned',$3)`,[invalid.operation,invalid.fingerprint,AT]);
 expect(await call(db,'subscription_stock_wait_frozen',[invalid.subscription,later(-1)])).toBeNull();
 const result=await call(db,'subscription_stock_wait_candidates',[1,later(1)]);
 expect(result.map((row:{operationId:string})=>row.operationId)).toEqual([valid.operation]);
}
it.each([
 {name:'frozen active/current and read-only replay',witness:frozenWitness},
 {name:'paused wait survives; cancellation closes once',witness:pausedWaitWitness},
 {name:'own/available deficit split and stale refusal',witness:deficitWitness},
 {name:'eligible recovery filtered before page limit',witness:eligiblePageWitness},
 {name:'unpaid/closed noop and paid realization replay',witness:resumedWitness},
])('N3 donor state/noop/refusal: $name',async row=>scoped(row.witness),120_000);
it.each([
 {name:'frozen active obligation predicate',signature:n3Frozen,witness:frozenWitness,
  from:"s.status='active' AND s.next_cycle_at=p_scheduled_at",to:'s.next_cycle_at=p_scheduled_at'},
 {name:'frozen current schedule predicate',signature:n3Frozen,witness:frozenWitness,
  from:"s.status='active' AND s.next_cycle_at=p_scheduled_at",to:"s.status='active'"},
 {name:'paused close predicate',signature:n3Candidates,witness:pausedWaitWitness,from:"s.status='cancelled' OR",to:"s.status<>'active' OR"},
 {name:'available excludes own hold',signature:n3Deficits,witness:deficitWitness,
  from:"THEN (promise->>'available_quantity')::bigint ELSE",to:"THEN (promise->>'available_quantity')::bigint+own_qty ELSE"},
 {name:'deficit predicate credits own hold',signature:n3Deficits,witness:deficitWitness,
  from:'IF own_qty+available<required THEN',to:'IF own_qty<required AND available<required THEN'},
 {name:'missing units credit both components',signature:n3Deficits,witness:deficitWitness,
  from:"'missingUnits',required-own_qty-available",to:"'missingUnits',required-GREATEST(available,own_qty)"},
 {name:'paid fulfillment-pending realization',signature:'public.subscription_stock_wait_mark_resumed(uuid)',witness:resumedWitness,
  from:"status IN ('paid','fulfillment_pending','fulfilled')",to:"status IN ('paid','fulfilled')"},
 {name:'closed paid realization noop',signature:'public.subscription_stock_wait_mark_resumed(uuid)',witness:resumedWitness,
  from:"IF c.state='closed' OR EXISTS",to:'IF false OR EXISTS'},
 {name:'unpaid realization noop',signature:'public.subscription_stock_wait_mark_resumed(uuid)',witness:resumedWitness,
  from:"OR EXISTS(SELECT 1 FROM public.commerce_orders WHERE id=p_order_id AND status='pending_payment') THEN RETURN NULL;",to:'OR false THEN RETURN NULL;'},
 {name:'eligibility before LIMIT',signature:n3Candidates,witness:eligiblePageWitness,
  from:'AND public.subscription_stock_wait_frozen(op.subscription_id,op.scheduled_at) IS NOT NULL',to:''},
])('N3 predicate/assignment mutant fails: $name',async mutant=>scoped(async()=>{
 const definition=await commandDefinition(mutant.signature),body=definition.replace(mutant.from,mutant.to);
 expect(body).not.toBe(definition);
 await db.query('SAVEPOINT n3_mutant');
 try {
  await db.query(body);
  await expect(mutant.witness()).rejects.toThrow();
 }finally{await db.query('ROLLBACK TO n3_mutant');await db.query('RELEASE SAVEPOINT n3_mutant');}
 expect(await commandDefinition(mutant.signature)).toBe(definition);
}),120_000);
it.each([
 {name:'resumed case',state:'resumed',eligible:true},
 {name:'closed case',state:'closed',eligible:true},
 {name:'stale-schedule waiting case',state:'waiting',stale:true,eligible:true},
 {name:'stale-schedule secured case',state:'stock_secured',stale:true,eligible:true},
 {name:'live lease',lease:true,eligible:false},
 {name:'succeeded operation',terminal:'succeeded',eligible:false},
 {name:'refused operation',terminal:'refused',eligible:false},
 {name:'paused subscription',status:'paused',eligible:false},
 {name:'cancelled subscription',status:'cancelled',eligible:false},
])('N3 normal_due eligibility: $name',async scenario=>scoped(async()=>{
 await db.query("UPDATE public.subscriptions SET status='paused' WHERE status='active'");
 const f=await renewal(db);
 const expected=(await db.query('SELECT to_jsonb(d) AS row FROM public.subscription_list_due_renewals($1,1) d',[later(1)])).rows.map(r=>r.row);
 expect(expected).toHaveLength(1);
 expect(expected[0].subscription_id).toBe(f.subscription);
 if(scenario.state) await db.query(`INSERT INTO public.subscription_stock_wait_cases(
  subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,
  due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits)
  VALUES($1,$2,$3,$4,2,$5,'{}',$6,$7,$8,'[]')`,
  [f.subscription,f.client,f.operation,scenario.stale?later(-1):AT,scenario.state,f.snapshot,f.fingerprint,f.identity]);
 if(scenario.lease) await db.query('UPDATE public.subscription_renewal_operations SET lease_expires_at=$2 WHERE id=$1',[f.operation,later(2)]);
 if(scenario.terminal) await db.query('UPDATE public.subscription_renewal_operations SET state=$2,terminal_outcome=$2,terminal_at=$3 WHERE id=$1',[f.operation,scenario.terminal,AT]);
 if(scenario.status) await db.query('UPDATE public.subscriptions SET status=$2 WHERE id=$1',[f.subscription,scenario.status]);
 const before=await effects(true);
 expect(await call(db,'subscription_stock_wait_normal_due',[1,later(1)])).toEqual(scenario.eligible?expected:[]);
 expect(await effects(true)).toEqual(before);
}));
async function decline(available=2, lines=1) {
 const f = await renewal(db,available,lines), original = await prepareOriginal(db,f);
 expect((await reservation(f)).status).toBe('committed');
 const input = {...failure(),evidenceKey:`decline-${f.operation}`};
 await call(db,'subscription_retry_apply_failure',[f.operation,`failure-${f.operation}`,input]);
 expect((await call(db,'subscription_retry_read',[f.operation])).state).toBe('waiting');
 expect((await reservation(f)).status).toBe('released');
 return {...f,original};
}
async function atp(f:Renewal,at=later(25),renewalExemption=false) {
 return call(db,'inventory_available_to_promise',[f.source,f.snapshot.lines[0].sku,at,renewalExemption]);
}
async function reservation(f:Renewal) {
 return (await db.query('SELECT * FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=$1',[f.operation])).rows[0];
}
async function recover(f:Renewal) {
 return call(db,'subscription_retry_record_recovery',[f.operation,`paid-${f.operation}`,positive(f)]);
}
async function outOfBand(f:Awaited<ReturnType<typeof decline>>) {
 await call(db,'payment_truth_ingest_event',[`oob-${f.operation}`,'e'.repeat(64),`oob-key-${f.operation}`,f.original.settlementIntentId,'captured',f.snapshot.totalAmountMinor,'XXX',later(1),null,null,{externalRef:`oob-${f.operation}`},null,null,'recovered']);
}
async function cohort() {
 const stale:Awaited<ReturnType<typeof decline>>[]=[];
 for (let n=0;n<4;n++) { const f=await decline(); await outOfBand(f); stale.push(f); }
 // Each guard is necessary independently, even when externally settled ledgers differ.
 await db.query("UPDATE public.subscription_cycles SET status='payment_pending' WHERE renewal_operation_id=$1",[stale[0].operation]);
 await db.query("UPDATE public.commerce_settlement_intents SET status='failed',settled_at=NULL WHERE id=$1",[stale[1].original.settlementIntentId]);
 const genuine=[await decline(),await decline(),await decline()];
 for (const [index,f] of genuine.entries()) await db.query('UPDATE public.subscription_retry_obligations SET next_retry_at=$2 WHERE renewal_operation_id=$1',[f.operation,later(index===2?24.5:25)]);
 const records=(await db.query('SELECT id,renewal_operation_id FROM public.subscription_retry_obligations WHERE renewal_operation_id=ANY($1::uuid[]) ORDER BY next_retry_at,id',[genuine.map(f=>f.operation)])).rows;
 return {stale,genuine,expected:records.map(r=>r.id)};
}
it('X restores paid lines to ATP, preserves future subscription stock, refuses a one-time offer and has zero-delta recovery replay',async()=>scoped(async()=>{
 const f=await decline(2,2);
 expect((await reservation(f)).status).toBe('released');
 const before=await atp(f);expect(before).toMatchObject({available_quantity:0,hard_hold_quantity:0,soft_subscription_demand_quantity:2});
 const result=await recover(f);
 expect(result).toMatchObject({state:'recovered',next_retry_at:null});
 expect((await reservation(f))).toMatchObject({status:'committed',expires_at:null,terminal_reason:null});
 const paidAtp=await atp(f);expect(paidAtp).toMatchObject({available_quantity:0,hard_hold_quantity:2,soft_subscription_demand_quantity:0});
 expect(await atp(f,later(25),true)).toMatchObject({available_quantity:0,hard_hold_quantity:2});
 for(const line of f.snapshot.lines) expect(await call(db,'inventory_available_to_promise',[f.source,line.sku,later(25),false])).toMatchObject({available_quantity:0,hard_hold_quantity:2});
 expect((await db.query('SELECT status FROM public.subscription_cycles WHERE renewal_operation_id=$1',[f.operation])).rows[0].status).toBe('paid');
 // Move the observation clock into the next cycle's soft-priority horizon.
 expect(await atp(f,later(25+15*24))).toMatchObject({available_quantity:0,hard_hold_quantity:2,soft_subscription_demand_quantity:2});
 const sku=f.snapshot.lines[0].sku;
 const readRows=await call(db,'inventory_new_purchase_stock_read',[f.source,JSON.stringify([sku]),later(25)]);
 expect(readRows).toMatchObject([{sku,available:0,availableForNewPurchases:0,activeHolds:2}]);
 const port=createNewPurchaseStockAvailabilityPort({readPort:{read:async()=>new Map(readRows.map(row=>[row.sku,row]))},functionMissingFallback:null,functionMissingError:'absent',defaultLowStockThreshold:1,defaultHorizonDays:14,deriveOfferAvailability,observe:console},{mode:'new_purchase'});
 const offer=await port.getAvailability({items:[{sku,productSlug:'fixture',variantId:randomUUID(),requestedQuantity:1,checkoutMode:'one_time'}]});
 expect(offer[0]).toMatchObject({status:'out_of_stock',sellableNow:0,visibleInConfigurator:false});
 const snapshot=await batchSnapshot(db);
 expect(await recover(f)).toEqual(result);assertSameSnapshot(snapshot,await batchSnapshot(db));expect(await atp(f)).toEqual(paidAtp);
 await unchangedIdentity(db,f);
 await db.query('SAVEPOINT replay_conflict');
 await expect(call(db,'subscription_retry_record_recovery',[f.operation,`paid-${f.operation}`,{...positive(f),amountMinor:1}])).rejects.toMatchObject({code:'23505'});
 await db.query('ROLLBACK TO replay_conflict');assertSameSnapshot(snapshot,await batchSnapshot(db));
}));
it('Y filters beyond LIMIT, keeps due ordering/ties, clamps and future rows, and makes no writes',async()=>scoped(async()=>{
 const f=await cohort(),before=await batchSnapshot(db);
 const rows=await call(db,'subscription_retry_candidates',[2,later(26)]);
 expect(rows.map(row=>row.id)).toEqual(f.expected.slice(0,2));
 expect(await call(db,'subscription_retry_candidates',[50,later(24)])).toEqual([]);
 expect((await call(db,'subscription_retry_candidates',[0,later(26)])).map(row=>row.id)).toEqual(f.expected.slice(0,1));
 expect((await call(db,'subscription_retry_candidates',[1000,later(26)])).map(row=>row.id)).toEqual(f.expected);
 expect((await call(db,'subscription_retry_candidates',[null,later(26)])).map(row=>row.id)).toEqual(f.expected.slice(0,1));
 assertSameSnapshot(before,await batchSnapshot(db));
 for(const row of [...f.stale,...f.genuine]) await unchangedIdentity(db,row);
}));

it('preserves the donor existing-addon noop without repricing and rejects both earlier bodies',async()=>scoped(async()=>{
 const f=await commandFixture();
 // A new add-on follows the existing path and aligns the future price lines.
 const initial={variantId:f.addon,qty:2,expectedTemplateVersion:1};
 const added=await raw(f,'addon-first','add_addon',initial);
 expect(added.result).toMatchObject({status:'previewed'});
 expect((await raw(f,'addon-first','add_addon',{...initial,acceptedQuoteHash:added.result.quoteHash},AT,true)).result)
  .toMatchObject({status:'applied',templateVersion:2});
 expect((await db.query(`SELECT quantity,unit_price_minor FROM public.subscription_lines
  WHERE subscription_id=$1 AND variant_id=$2`,[f.subscription,f.addon])).rows)
  .toEqual([{quantity:2,unit_price_minor:'70'}]);
 const payload={...initial,expectedTemplateVersion:2};
 const nextCycleAt=(await db.query('SELECT to_jsonb(next_cycle_at) value FROM public.subscriptions WHERE id=$1',[f.subscription])).rows[0].value;
 async function witness(key:string) {
  const before=await effects(true);
  const preview=await raw(f,key,'add_addon',payload);
  expect(preview.result.status,`${key}: existing-addon preview status`).toBe('noop');
  expect(preview.result).toEqual({status:'noop',subscriptionId:f.subscription,action:'add_addon',
   subscriptionStatus:'active',nextCycleAt,templateVersion:2,eventId:null});
  const stored=await effects(true);
  // The receipt is the only write: quotes, every stored line/price, events and versions retain even xmin.
  for(const name of Object.keys(before).filter(name=>name!=='subscription_command_receipts'))
   expect(stored[name],name).toEqual(before[name]);
  expect((await db.query(`SELECT status,quote_hash,result FROM public.subscription_command_receipts
   WHERE actor_id=$1 AND idempotency_key=$2`,[f.actor,key])).rows)
   .toEqual([{status:'noop',quote_hash:null,result:preview.result}]);
  expect(await raw(f,key,'add_addon',payload)).toEqual(preview);
  const applied=await raw(f,key,'add_addon',payload,AT,true);
  expect(applied.result).toEqual({...preview.result,status:'replayed',originalStatus:'noop'});
  expect(await raw(f,key,'add_addon',payload,AT,true)).toEqual(applied);
  expect((await raw(f,key,'add_addon',{...payload,qty:3},AT,true)).result)
   .toMatchObject({status:'refused',reason:'subscription_command_idempotency_conflict'});
  expect(await effects(true)).toEqual(stored);
 }
 await witness('same-addon-noop');
 // Drift both catalogue prices after locking the core/add-on at 350/70.
 await db.query('UPDATE public.price_entries SET unit_price_minor=999 WHERE price_list_id=$1',[f.list]);
 await witness('same-addon-price-drift');
 // A different quantity still attempts an append and hits the existing duplicate refusal.
 expect((await raw(f,'different-addon-qty','add_addon',{...payload,qty:3})).result)
  .toMatchObject({status:'refused',reason:'subscription_edit_invalid_lines'});
 const definition=await commandDefinition();
 const predicate="p_action IN ('add_addon','update_addon_quantity')";
 const append="   addons:=addons||jsonb_build_array(jsonb_build_object('variantId',p_payload->>'variantId','qty',GREATEST(1,COALESCE((p_payload->>'qty')::integer,1))));";
 const guard=`   IF NOT EXISTS(SELECT 1 FROM public.subscription_lines WHERE subscription_id=s.id
    AND variant_id=(p_payload->>'variantId')::uuid AND is_addon
    AND quantity=GREATEST(1,COALESCE((p_payload->>'qty')::integer,1))) THEN
 ${append}
   END IF;`;
 for(const [name,body] of [['unconditional-append',append],['guard-only',guard]]) {
  const mutant=definition.replace(predicate,"p_action='update_addon_quantity'").replace(append,body);
  expect(mutant).not.toBe(definition);
  await db.query('SAVEPOINT addon_mutant');
  try {
   await db.query(mutant);
   const key=`mutant-${name}`;
   await expect(witness(key)).rejects.toThrow(`${key}: existing-addon preview status`);
  }finally{await db.query('ROLLBACK TO addon_mutant');await db.query('RELEASE SAVEPOINT addon_mutant');}
  expect(await commandDefinition()).toBe(definition);
 }
}),120_000);

// Legacy donor names describe provenance only; commands use the native generic vocabulary.
const noopRows = [
 {donor:'swap_recipe',action:'update_bundle',changed:'refused',reason:'subscription_edit_invalid_lines',
  payload:(f:Fixture)=>bundle(f),change:(f:Fixture)=>({...bundle(f),coreLines:[{variantId:f.addon,qty:2}]})},
 {donor:'update_bundle changed cadence',action:'update_bundle',changed:'previewed',coreOnlyMutant:true,
  payload:(f:Fixture)=>({...bundle(f),cadenceDays:28,addonLines:[{variantId:f.addon,qty:2}]}),
  change:(f:Fixture)=>({...bundle(f),cadenceDays:21,addonLines:[{variantId:f.addon,qty:2}]})},
 {donor:'update_bundle changed supplied add-ons',action:'update_bundle',changed:'previewed',coreOnlyMutant:true,
  payload:(f:Fixture)=>({...bundle(f),cadenceDays:28,addonLines:[{variantId:f.addon,qty:2}]}),
  change:(f:Fixture)=>({...bundle(f),cadenceDays:28,addonLines:[{variantId:f.addon,qty:3}]})},
 {donor:'update_bundle all supplied fields equal',action:'update_bundle',changed:'refused',reason:'subscription_command_bundle_total_mismatch',
  payload:(f:Fixture)=>({...bundle(f),cadenceDays:28,addonLines:[{variantId:f.addon,qty:2}]}),
  change:(f:Fixture)=>({...bundle(f),cadenceDays:28,addonLines:[{variantId:f.addon,qty:2}],coreLines:[{variantId:f.sku,qty:3}]})},
 {donor:'add_addon',action:'add_addon',changed:'refused',reason:'subscription_edit_invalid_lines',
  payload:(f:Fixture)=>({variantId:f.addon,qty:2,expectedTemplateVersion:1}),
  change:(f:Fixture)=>({variantId:f.addon,qty:3,expectedTemplateVersion:1})},
 {donor:'update_addon_quantity',action:'update_addon_quantity',changed:'previewed',
  payload:(f:Fixture)=>({variantId:f.addon,qty:2,expectedTemplateVersion:1}),
  change:(f:Fixture)=>({variantId:f.addon,qty:3,expectedTemplateVersion:1})},
 {donor:'update_recipe_mix',action:'update_bundle',changed:'refused',reason:'subscription_command_bundle_total_mismatch',
  payload:(f:Fixture)=>({...bundle(f),coreLines:[{variantId:f.sku.toUpperCase(),qty:1},{variantId:f.sku,qty:1}]}),
  change:(f:Fixture)=>({...bundle(f),coreLines:[{variantId:f.sku,qty:3}]})},
 {donor:'update_plan_length',action:'update_plan_length',changed:'previewed',
  payload:(f:Fixture)=>({...bundle(f),planDays:28}),change:(f:Fixture)=>({...bundle(f),planDays:21})},
 // Native resize has no persisted portion mode/factor; those remain host policy.
 {donor:'set_portion_mode (native line/cadence equivalent)',action:'resize_bundle',changed:'previewed',
  payload:(f:Fixture)=>bundle(f),change:(f:Fixture)=>({...bundle(f),coreLines:[{variantId:f.sku,qty:3}]})},
 {donor:'update_package_template',action:'update_package_template',changed:'previewed',
  payload:(f:Fixture)=>({...bundle(f),planDays:28,addonLines:[{variantId:f.addon,qty:2}]}),
  change:(f:Fixture)=>({...bundle(f),planDays:21,addonLines:[{variantId:f.addon,qty:2}]})},
 {donor:'slide_next_cycle',action:'slide_next_cycle',changed:'refused',reason:'subscription_command_preview_unsupported',
  payload:()=>({newNextCycleAt:later(201)}),change:()=>({newNextCycleAt:later(224)})},
] satisfies {donor:string;action:string;changed:string;reason?:string;coreOnlyMutant?:boolean;payload:(f:Fixture)=>unknown;change:(f:Fixture)=>unknown}[];
it.each(noopRows)('N2 donor $donor: price-drift noop, changed-state boundary and predicate mutant',async row=>scoped(async()=>{
 const f=await commandFixture();
 await db.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
  VALUES($1,$2,2,1,true,70,'XXX')`,[f.subscription,f.addon]);
 await db.query('UPDATE public.price_entries SET unit_price_minor=999 WHERE price_list_id=$1',[f.list]);
 const nextCycleAt=(await db.query('SELECT to_jsonb(next_cycle_at) value FROM public.subscriptions WHERE id=$1',[f.subscription])).rows[0].value;
 const payload=row.payload(f);
 async function witness(key:string) {
  const before=await effects(true);
  const preview=await raw(f,key,row.action,payload);
  expect(preview.result.status,`${key}: semantic noop`).toBe('noop');
  expect(preview.result).toEqual({status:'noop',subscriptionId:f.subscription,action:row.action,
   subscriptionStatus:'active',nextCycleAt,templateVersion:1,eventId:null});
  const after=await effects(true);
  for(const name of Object.keys(before).filter(name=>name!=='subscription_command_receipts'))
   expect(after[name],`${row.donor}: ${name} columns/xmin`).toEqual(before[name]);
  type ReceiptSnapshot={count:number;rows:{columns:Record<string,unknown>;xmin:string}[]};
  const previous=before.subscription_command_receipts as ReceiptSnapshot;
  const stored=after.subscription_command_receipts as ReceiptSnapshot;
  expect(stored.count).toBe(previous.count+1);
  const inserted=stored.rows.filter(r=>r.columns.actor_id===f.actor && r.columns.idempotency_key===key);
  expect(inserted).toHaveLength(1);
  expect(inserted[0].columns).toMatchObject({status:'noop',quote_hash:null,result:preview.result});
  expect(stored.rows.filter(r=>r!==inserted[0])).toEqual(previous.rows);
  expect(await raw(f,key,row.action,payload,later(500))).toEqual(preview);
  expect((await raw(f,key,row.action,payload,AT,true)).result).toEqual({...preview.result,status:'replayed',originalStatus:'noop'});
  expect(await effects(true)).toEqual(after);
 }
 await witness(`table-noop-${row.action}`);
 async function changedWitness(key:string) {
  const changed=await raw(f,key,row.action,row.change(f));
  expect(changed.result.status,`${key}: changed supplied field`).toBe(row.changed);
  if('reason' in row) expect(changed.result.reason).toBe(row.reason);
  if(row.changed==='previewed') {
   expect(changed.result.quoteHash).toEqual(expect.any(String));
   const lines=changed.result.lines as {unitPriceMinor:number}[];
   expect(lines.every(line=>line.unitPriceMinor===999)).toBe(true);
  }
 }
 await changedWitness(`table-changed-${row.action}`);
 const definition=await commandDefinition();
 if('coreOnlyMutant' in row && row.coreOnlyMutant) {
  const mutant=definition.replace("v_noop:=core_matches AND cadence=s.cadence_days AND (NOT p_payload ? 'addonLines' OR addon_matches);",'v_noop:=core_matches;');
  expect(mutant).not.toBe(definition);
  await db.query('SAVEPOINT core_only_mutant');
  try {
   await db.query(mutant);
   const key=`core-only-mutant-${row.donor}`;
   await expect(changedWitness(key)).rejects.toThrow(`${key}: changed supplied field`);
  }finally{await db.query('ROLLBACK TO core_only_mutant');await db.query('RELEASE SAVEPOINT core_only_mutant');}
  expect(await commandDefinition()).toBe(definition);
 }
 const predicate=row.action==='add_addon' || row.action==='update_addon_quantity'
  ? "p_action IN ('add_addon','update_addon_quantity')"
  : row.action==='slide_next_cycle' ? "v_noop:=s.status='active'" : `ELSIF p_action='${row.action}' THEN`;
 const removed=row.action==='add_addon' ? "p_action='update_addon_quantity'"
  : row.action==='update_addon_quantity' ? "p_action='add_addon'"
  : row.action==='slide_next_cycle' ? "v_noop:=false AND s.status='active'" : 'ELSIF false THEN';
 const mutant=definition.replace(predicate,removed);
 expect(mutant).not.toBe(definition);
 await db.query('SAVEPOINT truth_table_mutant');
 try {
  await db.query(mutant);
  const key=`table-mutant-${row.action}`;
  await expect(witness(key)).rejects.toThrow(`${key}: semantic noop`);
 }finally{await db.query('ROLLBACK TO truth_table_mutant');await db.query('RELEASE SAVEPOINT truth_table_mutant');}
 expect(await commandDefinition()).toBe(definition);
}),120_000);

// CTL-5: assert requested state and quoted prices, rather than only preview status.
const changeRows = [
 {name:'plan core quantity and cadence',action:'update_plan_length',addon:1,coreQty:3,addonQty:1,cadence:21,
  payload:(f:Fixture)=>({...bundle(f),coreLines:[{variantId:f.sku,qty:3}],planDays:21})},
 {name:'plan core variant at unchanged cadence',action:'update_plan_length',coreVariant:true,coreQty:2,addonQty:0,cadence:28,
  payload:(f:Fixture)=>({...bundle(f),coreLines:[{variantId:f.addon,qty:2}],planDays:28})},
 {name:'native cadence-only expansion',action:'update_plan_length',coreQty:2,addonQty:0,cadence:21,
  payload:()=>({planDays:21,expectedTemplateVersion:1})},
 ...[null,[]].map(coreLines=>({name:`plan invalid core ${coreLines===null?'null':'empty'}`,action:'update_plan_length',
  reason:'subscription_edit_invalid_lines',payload:()=>({coreLines,planDays:21,expectedTemplateVersion:1})})),
 {name:'bundle all fields',action:'update_bundle',addon:1,coreQty:3,addonQty:2,cadence:21,
  payload:(f:Fixture)=>({...bundle(f),coreLines:[{variantId:f.sku,qty:3}],addonLines:[{variantId:f.addon,qty:2}],cadenceDays:21})},
 {name:'resize preserves addons',action:'resize_bundle',addon:1,coreQty:3,addonQty:1,cadence:21,
  payload:(f:Fixture)=>({...bundle(f),coreLines:[{variantId:f.sku,qty:3}],addonLines:[],cadenceDays:21})},
 {name:'package replaces addons',action:'update_package_template',addon:1,coreQty:3,addonQty:0,cadence:21,
  payload:(f:Fixture)=>({...bundle(f),coreLines:[{variantId:f.sku,qty:3}],addonLines:[],planDays:21})},
 ...[undefined,null,0,-1].map(qty=>({name:`add normalized ${String(qty)}`,action:'add_addon',coreQty:2,addonQty:1,cadence:28,
  payload:(f:Fixture)=>({variantId:f.addon,qty,expectedTemplateVersion:1})})),
 ...['add_addon','remove_addon','update_addon_quantity'].map(action=>({name:`${action} ignores cadence`,action,
  addon:action==='add_addon'?0:1,coreQty:2,addonQty:action==='remove_addon'?0:3,cadence:28,
  payload:(f:Fixture)=>({variantId:f.addon,qty:3,cadenceDays:21,planDays:14,expectedTemplateVersion:1})})),
 ...['remove_addon','update_addon_quantity'].map(action=>({name:`${action} UUID equality`,action,addon:1,
  coreQty:2,addonQty:action==='remove_addon'?0:3,cadence:28,
  payload:(f:Fixture)=>({variantId:f.addon.toUpperCase(),qty:3,expectedTemplateVersion:1})})),
];
type ChangeRow=typeof changeRows[number];
async function changeWitness(row:ChangeRow,key:string) {
 const f=await commandFixture();
 if('addon' in row && row.addon) await db.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
  VALUES($1,$2,$3,1,true,70,'XXX')`,[f.subscription,f.addon,row.addon]);
 const payload=row.payload(f);
 if(row.action==='remove_addon') expect((await raw(f,`${key}-invalid`,'remove_addon',
  {...payload,variantId:'bad'})).result).toMatchObject({status:'refused',reason:'subscription_command_addon_not_found'});
 // Version/payment/window refusals keep their native codes; drift cannot consume the quote.
 expect((await raw(f,`${key}-stale`,row.action,{...payload,expectedTemplateVersion:99})).result)
  .toMatchObject({status:'refused',reason:'subscription_edit_stale_template'});
 const before='reason' in row?await effects(true):undefined;
 const preview=await raw(f,key,row.action,payload);
 if('reason' in row) {
  expect(preview.result,`${key}: invalid core refusal`).toMatchObject({status:'refused',reason:row.reason});
  const after=await effects(true);
  for(const name of Object.keys(before!).filter(name=>name!=='subscription_command_receipts'))
   expect(after[name],`${key}: receipt-only ${name}`).toEqual(before![name]);
  type ReceiptSnapshot={count:number;rows:{columns:Record<string,unknown>;xmin:string}[]};
  const previous=before!.subscription_command_receipts as ReceiptSnapshot;
  const stored=after.subscription_command_receipts as ReceiptSnapshot;
  expect(stored.count).toBe(previous.count+1);
  const inserted=stored.rows.filter(r=>r.columns.actor_id===f.actor && r.columns.idempotency_key===key);
  expect(inserted).toHaveLength(1);
  expect(inserted[0].columns).toMatchObject({status:'refused',quote_hash:null,result:preview.result});
  expect(stored.rows.filter(r=>r!==inserted[0])).toEqual(previous.rows);
  expect(await raw(f,key,row.action,payload,later(500))).toEqual(preview);
  expect(await effects(true)).toEqual(after);
  return;
 }
 expect(preview.result.status,`${key}: change preview`).toBe('previewed');
 const expected=[{variantId:'coreVariant' in row && row.coreVariant?f.addon:f.sku,quantity:row.coreQty,
  isAddon:false,sortOrder:0,unitPriceMinor:'coreVariant' in row && row.coreVariant?70:350,currency:'XXX'},
  ...(row.addonQty?[{variantId:f.addon,quantity:row.addonQty,isAddon:true,sortOrder:1,unitPriceMinor:70,currency:'XXX'}]:[])];
 expect(preview.result.lines,`${key}: requested quote lines`).toEqual(expected);
 const accepted={...payload,acceptedQuoteHash:preview.result.quoteHash};
 const quoted=await effects(true);
 expect((await raw(f,key,row.action,{...accepted,auditDrift:true},AT,true)).result)
  .toMatchObject({status:'refused',reason:'subscription_command_idempotency_conflict'});
 expect(await effects(true)).toEqual(quoted);
 expect((await raw(f,key,row.action,accepted,AT,true)).result).toMatchObject({status:'applied',templateVersion:2});
 expect((await db.query(`SELECT variant_id AS "variantId",quantity,is_addon AS "isAddon",sort_order AS "sortOrder",
  unit_price_minor::integer AS "unitPriceMinor",currency_code AS currency FROM public.subscription_lines
  WHERE subscription_id=$1 ORDER BY sort_order`,[f.subscription])).rows,`${key}: applied quote lines`).toEqual(expected);
 expect((await db.query('SELECT cadence_days,template_version FROM public.subscriptions WHERE id=$1',[f.subscription])).rows)
  .toEqual([{cadence_days:row.cadence,template_version:2}]);
 expect((await db.query(`SELECT l.line_ordinal,l.sku,l.quantity,l.unit_amount_minor::integer AS amount
  FROM public.subscription_renewal_term_lines l WHERE subscription_id=$1 ORDER BY line_ordinal`,[f.subscription])).rows)
  .toEqual(await Promise.all(expected.map(async(line,index)=>({line_ordinal:index+1,
   sku:(await db.query('SELECT sku FROM public.catalog_skus WHERE id=$1',[line.variantId])).rows[0].sku,
   quantity:line.quantity,amount:line.unitPriceMinor}))));
 const applied=await effects(true);
 for(let n=0;n<2;n++) expect((await raw(f,key,row.action,accepted,later(500),true)).result)
  .toMatchObject({status:'replayed',originalStatus:'applied',templateVersion:2});
 expect(await effects(true)).toEqual(applied);
 const noopPayload={...payload,expectedTemplateVersion:2,...(row.action==='update_plan_length'
  ?{coreLines:expected.filter(line=>!line.isAddon).map(line=>({variantId:line.variantId,qty:line.quantity}))}:{})};
 const noop=await raw(f,`${key}-noop`,row.action,noopPayload);
 // The donor has no remove-missing no-op: its receipt records the existing refusal.
 expect(noop.result,row.name).toMatchObject(row.action==='remove_addon'
  ?{status:'refused',reason:'subscription_command_addon_not_found'}:{status:'noop'});
 const after=await effects(true);
 for(const name of Object.keys(applied).filter(name=>name!=='subscription_command_receipts'))
  expect(after[name],`${key}: receipt-only ${name}`).toEqual(applied[name]);
 expect(await raw(f,`${key}-noop`,row.action,noopPayload,later(500))).toEqual(noop);
 expect(await effects(true)).toEqual(after);
}
it.each(changeRows)('N2 change/apply/noop/refusal: $name',async row=>scoped(()=>changeWitness(row,`change-${row.name}`)),120_000);
it.each([
 {name:'plan assignment',row:'plan core quantity and cadence',from:"core:=COALESCE(p_payload->'coreLines',core);",to:'NULL;'},
 ...['null','empty'].map(kind=>({name:`plan invalid core fallback ${kind}`,row:`plan invalid core ${kind}`,
  from:"core:=COALESCE(p_payload->'coreLines',core);",
  to:"IF p_payload->'coreLines' IN ('null'::jsonb,'[]'::jsonb) THEN NULL; ELSE core:=COALESCE(p_payload->'coreLines',core); END IF;"})),
 {name:'add quantity normalization',row:'add normalized undefined',
  from:"'qty',GREATEST(1,COALESCE((p_payload->>'qty')::integer,1))));",to:"'qty',p_payload->'qty'));"},
 ...['add_addon','remove_addon','update_addon_quantity'].map(action=>({name:`cadence scope ${action}`,row:`${action} ignores cadence`,
  from:"CASE WHEN p_action IN ('update_bundle','resize_bundle','update_package_template','update_plan_length')",to:'CASE WHEN true'})),
 {name:'addon existence UUID',row:'remove_addon UUID equality',
  from:"WHERE v->>'variantId'=lower(p_payload->>'variantId'))",to:"WHERE v->>'variantId'=p_payload->>'variantId')"},
 {name:'addon update UUID',row:'update_addon_quantity UUID equality',
  from:"CASE WHEN v->>'variantId'=lower(p_payload->>'variantId') THEN",to:"CASE WHEN v->>'variantId'=p_payload->>'variantId' THEN"},
 {name:'addon remove UUID',row:'remove_addon UUID equality',
  from:"OR v->>'variantId'<>lower(p_payload->>'variantId');",to:"OR v->>'variantId'<>p_payload->>'variantId';"},
])('N2 change assignment mutant fails: $name',async mutant=>scoped(async()=>{
 const definition=await commandDefinition(),body=definition.replace(mutant.from,mutant.to);
 expect(body).not.toBe(definition);
 await db.query('SAVEPOINT change_mutant');
 try {
  await db.query(body);
  await expect(changeWitness(changeRows.find(row=>row.name===mutant.row)!,`mutant-${mutant.name}`)).rejects.toThrow();
 }finally{await db.query('ROLLBACK TO change_mutant');await db.query('RELEASE SAVEPOINT change_mutant');}
 expect(await commandDefinition()).toBe(definition);
}),120_000);

it('preserves the other predicate conjuncts, normalized add quantity and native refusal guards',async()=>scoped(async()=>{
 const f=await commandFixture();
 await db.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
  VALUES($1,$2,1,1,true,70,'XXX')`,[f.subscription,f.addon]);
 await db.query('UPDATE public.price_entries SET unit_price_minor=999 WHERE price_list_id=$1',[f.list]);
 for(const qty of [undefined,null,0,-1,1]) {
  const payload={variantId:f.addon.toUpperCase(),qty,expectedTemplateVersion:1};
  const key=`normalized-add-${String(qty)}`;
  expect((await raw(f,key,'add_addon',payload)).result.status).toBe('noop');
 }
 const coreChanged={...bundle(f),coreLines:[{variantId:f.sku,qty:3}]};
 const cases:[string,unknown,string][]=[
  ['update_addon_quantity',{variantId:f.addon,qty:0,expectedTemplateVersion:1},'refused'],
  ['update_plan_length',{...coreChanged,planDays:28},'previewed'],
  ['update_package_template',{...bundle(f),planDays:28,addonLines:[]},'previewed'],
  ['update_package_template',{...coreChanged,planDays:28,addonLines:[{variantId:f.addon,qty:1}]},'previewed'],
  ['update_bundle',{...bundle(f),addonLines:[]},'previewed'],
  ['resize_bundle',{...bundle(f),cadenceDays:21},'previewed'],
  ['slide_next_cycle',{newNextCycleAt:'bad-date'},'refused'],
  ['slide_next_cycle',{newNextCycleAt:'2026-99-99'},'refused'],
  ['slide_next_cycle',{},'refused'],
 ];
 for(const [index,[action,payload,status]] of cases.entries())
  expect((await raw(f,`conjunct-${index}`,action,payload)).result.status,`${action} ${index}`).toBe(status);
 // Native package guards still run before no-op detection.
 for(const [name,sql,reason] of [
  ['version',"UPDATE public.subscriptions SET template_version=2 WHERE id=$1",'subscription_edit_stale_template'],
  ['payment',"DELETE FROM public.subscription_method_states WHERE subscription_id=$1",'subscription_command_payment_blocked'],
  ['window',"UPDATE public.subscriptions SET next_cycle_at='2026-09-01' WHERE id=$1",'subscription_edit_window_closed'],
 ] as const) {
  await db.query('SAVEPOINT noop_guard');
  try {
   await db.query(sql,[f.subscription]);
   expect((await raw(f,`noop-guard-${name}`,'resize_bundle',bundle(f))).result).toMatchObject({status:'refused',reason});
  }finally{await db.query('ROLLBACK TO noop_guard');await db.query('RELEASE SAVEPOINT noop_guard');}
 }
}));

it('returns stored raw receipts with zero counts/columns/xmin delta across committed replays interleaved with a later command', async () => {
 const f = await commandFixture(), key = 'zero-delta-n2-preview', payload = {...bundle(f),cadenceDays:21};
 const original = await raw(f,key,'resize_bundle',payload);
 expect(original.result).toMatchObject({status:'previewed',canApply:true});

 async function replay(phase:string,expected:typeof original,count=3) {
  for (let i=0;i<count;i++) {
   const before = await effects(true);
   const result = await raw(f,key,'resize_bundle',payload,later(500));
   expect(result.bytes).toBe(expected.bytes);
   const after = await effects(true);
   expect(JSON.stringify(after)).toBe(JSON.stringify(before));
   const receipt = (await db.query('SELECT result::text bytes,xmin::text xmin FROM public.subscription_command_receipts WHERE actor_id=$1 AND idempotency_key=$2',[f.actor,key])).rows[0];
   expect(result.bytes).toBe(receipt.bytes);
   expect(Object.keys(before).length,phase).toBeGreaterThan(100);
   expect(receipt.xmin).toBeDefined();
  }
 }
 await replay('before-later-command',original);
 const laterCommand = await raw(f,'later-n2-slide-command','slide_next_cycle',{newNextCycleAt:later(300)},AT,true);
 expect(laterCommand.result).toMatchObject({status:'applied'});
 await replay('after-later-command',original);
 const applied = await raw(f,key,'resize_bundle',{...payload,acceptedQuoteHash:original.result.quoteHash},AT,true);
 expect(applied.result).toMatchObject({status:'applied'});
 await replay('after-apply-stored-result',applied);
 const before = await effects(true);
 expect((await raw(f,key,'update_plan_length',payload)).result).toMatchObject({status:'refused',reason:'subscription_command_idempotency_conflict'});
 expect((await raw(f,key,'resize_bundle',{...payload,expectedTemplateVersion:2})).result).toMatchObject({status:'refused',reason:'subscription_command_idempotency_conflict'});
 for (let i=0;i<3;i++) expect((await raw(f,key,'resize_bundle',{...payload,acceptedQuoteHash:original.result.quoteHash},later(500),true)).result)
  .toEqual({...applied.result,status:'replayed',originalStatus:'applied'});
 expect(await effects(true)).toEqual(before);
 // The witness must reject a same-value write (including one hidden from column comparisons).
 const unchanged = await effects(true);
 await db.query('UPDATE public.subscription_command_receipts SET result=result WHERE actor_id=$1 AND idempotency_key=$2',[f.actor,key]);
 const mutated = await effects(true);
 expect(mutated).not.toEqual(unchanged);
 expect((mutated.subscription_command_receipts as {rows:unknown[]}).rows).not.toEqual((unchanged.subscription_command_receipts as {rows:unknown[]}).rows);
},120_000);

it('replays a stored refusal and an apply-created receipt directly, without public-table writes', async () => {
 const f = await commandFixture();
 const refusal = await raw(f,'fresh-n2-unsupported','cancel');
 expect(refusal.result).toMatchObject({status:'refused',reason:'subscription_command_preview_unsupported'});
 const cancelled = await raw(f,'fresh-n2-cancel-apply','cancel',{},AT,true);
 expect(cancelled.result).toMatchObject({status:'applied',subscriptionStatus:'cancelled'});
 const before = await effects(true);
 for (let i=0;i<3;i++) {
  expect((await raw(f,'fresh-n2-unsupported','cancel',{},later(500))).bytes).toBe(refusal.bytes);
  expect((await raw(f,'fresh-n2-cancel-apply','cancel',{},later(500))).bytes).toBe(cancelled.bytes);
 }
 expect(await effects(true)).toEqual(before);
},120_000);

  }

  if (!portable) it("keeps the exact notification seeds idempotent and preserves disabled local controls", async () => {
    const pin = pins.find(pin => pin.path.endsWith("20261024182000_subscription_lifecycle_message_scan.sql"))!;
    const seed = pin.statements.find(statement => statement.sql?.startsWith("INSERT INTO public.comms_notification_controls"))!.sql!;
    await db.query("BEGIN");
    try {
      await db.query("UPDATE public.comms_notification_controls SET enabled=false WHERE slug='subscription-stock-wait-started'");
      const before = await batchSnapshot(db);
      await db.query(seed); await db.query(seed);
      assertSameSnapshot(before,await batchSnapshot(db));
      const result = (await db.query(`SELECT extensions.is((SELECT enabled FROM public.comms_notification_controls
        WHERE slug='subscription-stock-wait-started'),false,'seed replay preserves disabled local control') AS result`)).rows[0].result;
      expect(result).toMatch(/^ok [0-9]+ - /u);
    } finally { await db.query("ROLLBACK"); }
  },120_000);

  it("proves the catalog observer rejects planted effects and pgTAP finishes cleanly", async () => {
    const pin = pins.at(-1)!;
    const bytes = fixture(pin);
    // Start from a proved chain; use an empty expected delta to falsify the
    // observer itself. The mutations are test-authored, not reviewer-authored.
    const empty = { ...pin, functions: [] };
    for (const attack of [
      "CREATE FUNCTION private.unpinned_control_probe() RETURNS text LANGUAGE sql AS $$ SELECT 'attack'; $$",
      "CREATE TABLE public.unpinned_control_probe(id integer)",
      "GRANT DELETE ON public.subscriptions TO anon",
      "ALTER TABLE public.subscriptions ADD COLUMN unpinned_control_probe integer",
      "INSERT INTO public.clients(id,email) VALUES ('d9000000-0000-4000-8000-000000000099','control-plant@example.invalid')",
    ]) {
      if (portable && attack.includes("private.")) continue; // Covered by the managed graph; native has no private schema.
      const before = await batchSnapshot(db);
      await db.query("BEGIN");
      try {
        await db.query(attack);
        await expect(assertBatchCatalog(db, empty, Buffer.alloc(0), before, await batchSnapshot(db)), attack).rejects.toThrow();
      } finally { await db.query("ROLLBACK"); }
      assertSameSnapshot(before, await batchSnapshot(db));
    }
    if (!portable) {
      const rows = (await db.query("SELECT * FROM extensions.finish() AS result")).rows;
      expect(rows.map(row => row.result)).toEqual([`1..${pins.length}`]);
    }
  }, 120_000);
  it("ignores vacuum freeze bookkeeping in catalog snapshots", async () => {
    await db.query("SET LOCAL ROLE postgres");
    try {
      const before = await batchSnapshot(db);
      await db.query("VACUUM (FREEZE) pg_catalog.pg_class, pg_catalog.pg_proc");
      assertSameSnapshot(before, await batchSnapshot(db));
    } finally { if (!portable) await db.query("SET ROLE postgres"); }
  }, 120_000);
});

it.each([
  ["db/platform/migrations", "20261024184000", "20261024183000"],
  ["db/platform/migrations", "20261024184500", "20261024184000"],
  ["db/platform/migrations", "20261024184600", "20261024184500"],
  ["supabase/migrations", "20261024184000", "20261024175000"],
  ["supabase/migrations", "20261024185000", "20261024175000"],
])("refuses a landed later pin over an absent predecessor: %s %s", (directory, later, missing) => {
  const root = mkdtempSync(join(tmpdir(), "openlup-batch-pg-hole-"));
  const pins = registry.batchedForwards!.filter(pin => pin.path.startsWith(directory));
  try {
    for (const pin of pins.filter(pin => later.includes("185000") ? pin.path.includes(later) || pin.path < `${directory}/20261024170000` : pin.path <= pins.find(pin => pin.path.includes(later))!.path && !pin.path.includes(missing))) {
      mkdirSync(dirname(join(root, pin.path)), { recursive: true });
      writeFileSync(join(root, pin.path), fixture(pin));
    }
    expect(pins.some(pin => pin.path.includes(missing))).toBe(true);
    expect(() => reviewedBatchPaths(root, directory, pins)).toThrow("reviewed batch requires every earlier same-rail pin landed first");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
