import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresSubscriptionWinback, type NativeWinbackOptions } from "@openlup/platform/subscriptions";
import { selectPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { nativeStoreFunctionDefinitions, sqlStatements } from "../../scripts/reviewed-platform-forward.js";
import { qualifiedPostgresStartupOptions, qualifiedAdminPostgresStartupOptions, qualifiedPostgresCatalogPayload, qualifiedAdminPostgresCatalogPayload,
  readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "@openlup/platform/migrations";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

const file = "db/platform/migrations/20261106140000_subscriber_winback_policy.sql";
const sql = readFileSync(file, "utf8"), hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const manifest: PlatformMigrationManifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const signatures = ["public.subscriber_retention_plan_due(text,integer,timestamptz)", "public.subscriber_retention_eligibility_refusal(text,text,timestamptz)",
  "public.subscriber_retention_create_intent(text,text,uuid,text,text,text,text,integer,text,text,text)", "public.subscriber_retention_claim_intent(text,text,timestamptz)"];
const installed = ["f68525bc72873d1f9b2f7547dd01c33fec39ef3fb65c8e56ac415a0bd4ec539a", "a9acfd02598b73facfc37a11df762259cd8be15850bf48ee1e45a74857e30da3"];
const staticPreimages = ["cdcdc7de6fe13e33dc724e9d59ef934cb6ec49eda1e0c3a5ec8126cff5911c71", "73db45b446497d31fa49e8afba95834fcd757c19120a49acf02ab5909e76de6c"];
const profiles = ["legacy", "qualified-bootstrap", "qualified-separate", "restricted-managed", "restricted-operator"] as const;
const password = "synthetic-conformance", lock = "openlup:public-platform-migrations:v1";
const defaults = { requireRetentionConsent: true, minCancellationAgeDays: 14, maxCancellationAgeDays: 120 };
type Row = Record<string, unknown>;
async function catalog(db: PoolClient) {
  return (await db.query(`SELECT p.oid::regprocedure::text AS name,p.prosrc AS body,
    (to_jsonb(p)-'prosrc'-'proargdefaults')||jsonb_build_object('arguments',pg_get_function_arguments(p.oid)) AS attributes
    FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[]) ORDER BY p.proname`, [signatures])).rows;
}

describe.each(profiles)("native winback: %s", profile => {
  let container: PostgresContainer | undefined, bootstrap: Pool, owner: Pool, runtime: Pool;
  let runtimeUrl: string, before: Awaited<ReturnType<typeof catalog>>, after: Awaited<ReturnType<typeof catalog>>;
  const pools: Pool[] = [];
  const pool = (connectionString: string, options = "", max = 1) => { const p = new Pool({ connectionString, options, max }); pools.push(p); return p; };
  const qualified = profile !== "legacy", restricted = profile.startsWith("restricted");
  const operator = profile === "restricted-operator", separate = profile === "qualified-separate";
  beforeAll(async () => {
    container = await runPostgresContainer({ name: `subscription-winback-${profile}-${process.pid}`, password });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Winback PostgreSQL unavailable");
    bootstrap = pool(container.connectionString);
    const login = (name: string) => { const u = new URL(container!.connectionString); u.username = name; u.password = password; return u.toString(); };
    const mode = operator ? "operator-provisioned" as const : "installer-managed" as const;
    const m = restricted || separate ? "winback_m" : "postgres", r = "winback_r", s = "winback_s", o = "winback_o";
    if (qualified) {
      for (const role of [r,s]) await bootstrap.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      if (m !== "postgres") {
        await bootstrap.query(`CREATE ROLE ${m} LOGIN ${restricted ? "NOINHERIT NOSUPERUSER" : "INHERIT SUPERUSER"} NOCREATEDB ${restricted && !operator ? "CREATEROLE" : "NOCREATEROLE"} NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
        await bootstrap.query(`ALTER DATABASE postgres OWNER TO ${m}`);
      }
      if (operator) {
        await bootstrap.query(`CREATE ROLE ${o} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
        const control = pool(login(o));
        for (const group of ["anon","authenticated","service_role","platform_acquisition_owner","platform_acquisition_runtime","openlup_retained_import_owner"]) {
          await bootstrap.query(`CREATE ROLE ${group} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
          await bootstrap.query(`GRANT ${group} TO ${o} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
          await control.query(`GRANT ${group} TO ${m} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY ${o}`);
          if (["anon","authenticated","service_role","platform_acquisition_runtime"].includes(group)) {
            await control.query(`GRANT ${group} TO ${r} WITH ADMIN FALSE, INHERIT ${group === "service_role" ? "TRUE" : "FALSE"}, SET TRUE GRANTED BY ${o}`);
          }
        }
      }
    }
    const selection = { generation: "qualified-v2" as const, roleMode: mode, migrationLogin: m, bootstrapLogin: "postgres", runtimeLogin: r, restoreLogin: s };
    const adminSelection = operator
      ? { ...selection, generation: "qualified-admin" as const, roleMode: "operator-provisioned" as const, operatorLogin: o }
      : { ...selection, generation: "qualified-admin" as const, roleMode: "installer-managed" as const };
    const startup = !qualified ? "" : restricted ? qualifiedAdminPostgresStartupOptions(adminSelection) : qualifiedPostgresStartupOptions(selection);
    owner = !qualified ? bootstrap : pool(login(m), startup);
    const plan = !qualified ? manifest : restricted ? selectPlatformMigrationManifest(manifest,"qualified-admin",{roleMode:mode})
      : selectPlatformMigrationManifest(manifest,"qualified-v2",{migrationIsBootstrap:!separate,hasRestore:true});
    const db = await owner.connect();
    try {
      await db.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lock]);
      const units = [plan.baseline,...plan.forward].filter(u => u.file !== file);
      for (const [position,unit] of units.entries()) {
        const bytes = readFileSync(unit.file); expect(hash(bytes)).toBe(unit.sha256);
        await db.query("BEGIN");
        try {
          await db.query(bytes.toString());
          if (qualified) await db.query("INSERT INTO public.platform_schema_migrations(catalog_path,sha256,position) VALUES($1,$2,$3)", [unit.file,unit.sha256,position]);
          await db.query("COMMIT");
        } catch (error) { await db.query("ROLLBACK"); throw error; }
      }
      before = await catalog(db);
      const pre = new Map<string,string>(), staticStatements = new Map<string,string>();
      for (const unit of units) {
        for (const entry of nativeStoreFunctionDefinitions(readFileSync(unit.file),signatures,true)) pre.set(...entry);
        for (const statement of sqlStatements(readFileSync(unit.file,"utf8"),true,false,true)) {
          for (const signature of nativeStoreFunctionDefinitions(Buffer.from(statement),signatures,true).keys()) staticStatements.set(signature,statement);
        }
      }
      // The replacement uses the static header with the installed body; the
      // catalog attribute comparison below proves the installed header agrees.
      for (const statement of sqlStatements(sql,false,false,true)) {
        const signature = [...nativeStoreFunctionDefinitions(Buffer.from(statement),signatures).keys()][0]!;
        expect(statement.split("AS $$")[0]!.replace("CREATE OR REPLACE ","CREATE "))
          .toBe(staticStatements.get(signature)!.split("AS $$")[0]);
      }
      for (const [i,signature] of signatures.slice(0,2).entries()) {
        expect(pre.get(signature)).toBe(staticPreimages[i]);
        expect(hash(before.find(row => String(row.name).startsWith(signature.split("(")[0]!.replace("public.","")))!.body)).toBe(installed[i]);
      }
      await db.query(sql); after = await catalog(db);
      if (qualified) await db.query("INSERT INTO public.platform_schema_migrations(catalog_path,sha256,position) VALUES($1,$2,$3)", [file,hash(sql),units.length]);
      const payload = !qualified ? selectedCatalogProjectionPayload(await readSelectedCatalogProjection(db)) : restricted
        ? await qualifiedAdminPostgresCatalogPayload(db,adminSelection,lock) : await qualifiedPostgresCatalogPayload(db,selection,lock);
      mkdirSync(".context/scratch/subscription-winback-inventory", {recursive:true});
      writeFileSync(`.context/scratch/subscription-winback-inventory/${profile}.json`,JSON.stringify({profile,sha256:hash(payload)})+"\n");
      console.info(`winback-inventory ${profile} ${hash(payload)}`);
    } finally { await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[lock]); db.release(); }
    runtimeUrl = !qualified ? container.connectionString : login(r);
  }, postgresSetupTimeoutMs);
  afterAll(() => closePostgres(container,pools), postgresTeardownTimeoutMs);

  it("starts from installed DO-patched bodies and replaces only bodies, preserving attributes and ACLs", () => {
    expect(before).toHaveLength(4); expect(after).toHaveLength(4);
    for (const old of before) {
      const current = after.find(row => row.name === old.name)!;
      expect(current.attributes).toEqual(old.attributes);
      const statement = sqlStatements(sql,false,false,true).find(s => s.startsWith(`CREATE OR REPLACE FUNCTION public.${String(old.name).split("(")[0]}`))!;
      expect(current.body).toBe(statement.match(/AS \$\$([\s\S]*)\$\$;$/u)![1]);
    }
    expect(readFileSync(`packages/platform/sql/${file.split("/").at(-1)}`,"utf8")).toBe(sql);
  });

  describe.each(["UTC","Etc/GMT-9","Etc/GMT+5"])("zone %s", zone => {
    let now: Date, selected: string[];
    const query = async (name: string,args: unknown[] = [], db: Pool = runtime) => (await db.query(`SELECT public.${name}(${args.map((_,i) => `$${i+1}`).join(",")}) AS value`,args)).rows[0]!.value;
    const policy = async (value: Row) => owner.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscriber_winback_policy',$1) ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text",[JSON.stringify(value)]);
    const seed = async (days = 20, customer = true, status = "cancelled") => {
      const id = randomUUID(), client = randomUUID(), email = `${client}@example.invalid`, ended = new Date(now.getTime()-days*86400000);
      selected.push(id);
      await owner.query("INSERT INTO public.clients(id,email,first_name,country) VALUES($1,$2,'Sample','AA')",[client,email]);
      await owner.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,status,ended_at,started_at) VALUES($1::uuid,$2::uuid,28,$3,$4,$3,$3::timestamptz-interval '500 days')",[id.toUpperCase(),client.toUpperCase(),ended,status]);
      if (customer) await owner.query("INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,occurred_at) VALUES($1,'subscription.customer_self_service.cancel',$2,$3)",[id,`cancel:${id}`,ended]);
      return {id,client,email,ended};
    };
    const consent = async (email: string, state = "granted") => query("communications_record_recipient_consent",[hash(email),"retention_marketing",state,now],owner);
    const plan = () => query("subscriber_retention_plan_due",["winback",100,now]);
    const intents = () => owner.query("SELECT * FROM public.subscriber_retention_intents ORDER BY created_at,id").then(r => r.rows);
    const eventCount = () => owner.query("SELECT count(*)::integer AS n FROM public.subscription_events WHERE event_type='subscription.winback.email_sent' AND subscription_id=ANY($1::uuid[])",[selected]).then(r => r.rows[0]!.n);
    const accepted = { state: "accepted" as const, deliveryReference: "delivery:winback", attemptCount: 1 };
    const failed = { state: "failed" as const, deliveryReference: null, attemptCount: 1 };
    const worker = (overrides: Partial<NativeWinbackOptions> = {}) => createPostgresSubscriptionWinback({
      withSession: async work => { const db = await runtime.connect(); try { return await work(db); } finally { db.release(); } },
      delivery: { readReceipt: async key => { const row = (await runtime.query("SELECT * FROM public.transactional_delivery_read_receipt($1)",[key])).rows[0];
        return row ? { state: row.state, deliveryReference: row.delivery_reference, attemptCount: row.attempt_count } : null; },
        send: async command => { await query("transactional_delivery_record_accepted",[command.idempotencyKey,hash(command.idempotencyKey),accepted.deliveryReference]); return accepted; } },
      bind: async input => ({ recipientReference: `client:${input.clientId}`, templateReference: "subscriber-winback-v1" }), ...overrides });
    beforeAll(async () => { runtime = pool(runtimeUrl,`-c TimeZone=${zone}`,4); await owner.query("SELECT set_config('TimeZone',$1,false)",[zone]); });
    beforeEach(async () => {
      // Keep unrelated append-only histories intact. Old synthetic subscriptions
      // leave the scan window; only this witness's mutable winback state resets.
      await owner.query("UPDATE public.subscriptions SET ended_at=now()-interval '400 days' WHERE status='cancelled'");
      await owner.query("DELETE FROM public.subscriber_retention_intents; DELETE FROM public.subscriber_profiles; DELETE FROM public.communication_recipient_consents; DELETE FROM public.transactional_delivery_receipts");
      await owner.query("DELETE FROM public.commerce_settings WHERE key='subscriber_winback_policy'");
      await owner.query("INSERT INTO public.communication_delivery_controls(control_key,enabled) VALUES('subscriber-retention',true) ON CONFLICT(control_key) DO UPDATE SET enabled=true");
      now = (await owner.query("SELECT now() AS at")).rows[0]!.at;
      selected = [];
    });
    it("selects only positive customer cancellation evidence in the configured [14,120) window", async () => {
      await policy({...defaults,requireRetentionConsent:false});
      for (const days of [14,20,119,13,120,121]) await seed(days);
      await seed(20,false); await seed(20,true,"active");
      expect(await plan()).toMatchObject({scanned:3,planned:3,refused:0});
      expect(await intents()).toHaveLength(3);
    });
    it("keeps native consent required by default and separate from newsletter/offers", async () => {
      const f = await seed();
      await query("communications_record_recipient_consent",[hash(f.email),"marketing_newsletter","granted",now],owner);
      expect(await plan()).toMatchObject({planned:0,refused:1});
      expect((await intents())[0]).toMatchObject({refusal:"consent_missing"});
    });
    it("maps the lifecycle owner's positive customer marker, including uppercase UUID input and replay", async () => {
      await policy({requireRetentionConsent:false});
      const f = await seed(20,false,"active"), key = `customer-cancel:${f.id}`;
      const args = [f.client.toUpperCase(),key,f.id.toUpperCase(),"cancel",{},f.ended];
      expect(await query("subscription_apply_lifecycle_action",args,owner)).toMatchObject({subscriptionAction:{status:"applied",subscriptionStatus:"cancelled"}});
      expect(await query("subscription_apply_lifecycle_action",args,owner)).toMatchObject({subscriptionAction:{status:"replayed",subscriptionStatus:"cancelled"}});
      expect((await owner.query("SELECT occurred_at FROM public.subscription_events WHERE subscription_id=$1 AND event_type='subscription.customer_self_service.cancel'",[f.id])).rows)
        .toEqual([{occurred_at:f.ended}]);
      expect(await plan()).toMatchObject({scanned:1,planned:1});
    });
    it("admits a trusted-host retention grant and supports explicit consent-off configuration", async () => {
      const f = await seed(); await consent(f.email);
      expect(await plan()).toMatchObject({planned:1});
      await policy({...defaults,requireRetentionConsent:false}); await seed();
      expect(await plan()).toMatchObject({planned:1});
    });
    it("uses configured timing values without changing other retention kinds or seeding policy", async () => {
      await policy({requireRetentionConsent:false,minCancellationAgeDays:1,maxCancellationAgeDays:3});
      await seed(2); await seed(4);
      expect(await plan()).toMatchObject({planned:1,scanned:1});
      expect(await query("subscriber_retention_plan_due",["paid_cycle_recap",100,now])).toMatchObject({scanned:0});
      expect(await query("subscriber_retention_plan_due",["review_request",100,now])).toMatchObject({scanned:0});
    });
    it("refuses malformed policy before writing an intent", async () => {
      await policy({requireRetentionConsent:"false"}); await seed();
      await expect(plan()).rejects.toMatchObject({code:"22023"}); expect(await intents()).toEqual([]);
    });
    it("distinguishes old and current episode events, preserving later-episode eligibility", async () => {
      await policy({requireRetentionConsent:false});
      const old = await seed(), current = await seed();
      for (const [f,at] of [[old,new Date(old.ended.getTime()-86400000)],[current,now]] as const) {
        await owner.query("INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,occurred_at) VALUES($1,'subscription.winback.email_sent',$2,$3)",[f.id,`old:${f.id}`,at]);
      }
      expect(await plan()).toMatchObject({scanned:1,planned:1});
      expect((await intents())[0]!.subscription_id).toBe(old.id);
    });
    it("sends before recording acceptance and dedupes across restart and recancellation", async () => {
      await policy({requireRetentionConsent:false}); const f = await seed();
      const send = vi.fn(async (command: {idempotencyKey:string}) => {
        expect(await eventCount()).toBe(0); expect((await intents())[0]!.status).toBe("dispatching");
        expect(command.idempotencyKey).toBe(`winback:${f.id}`);
        await query("transactional_delivery_record_accepted",[command.idempotencyKey,hash(command.idempotencyKey),accepted.deliveryReference]); return accepted;
      });
      expect(await worker({delivery:{readReceipt:async () => null,send}}).run()).toMatchObject({sent:1,failed:0});
      expect(await eventCount()).toBe(1);
      await owner.query("UPDATE public.subscriptions SET ended_at=ended_at+interval '1 day' WHERE id=$1",[f.id]);
      await owner.query("INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,occurred_at) SELECT id,'subscription.customer_self_service.cancel','recancel:'||id,ended_at FROM public.subscriptions WHERE id=$1",[f.id]);
      expect(await worker().run()).toMatchObject({scanned:0,sent:0}); expect(send).toHaveBeenCalledTimes(1);
    });
    it("keeps failed sends retryable and never records a success event for failure", async () => {
      await policy({requireRetentionConsent:false}); await seed();
      expect(await worker({delivery:{readReceipt:async () => failed,send:async () => failed}}).run()).toMatchObject({failed:1,sent:0});
      expect(await eventCount()).toBe(0); expect((await intents())[0]!.status).toBe("failed");
      expect(await worker().run()).toMatchObject({sent:1,failed:0}); expect(await eventCount()).toBe(1);
    });
    it("suppresses a later eligible episode with an old event and subscription-wide accepted receipt", async () => {
      await policy({requireRetentionConsent:false}); const f = await seed();
      await owner.query("INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,occurred_at) VALUES($1,'subscription.winback.email_sent',$2,$3)",
        [f.id,`previous-episode:${f.id}`,new Date(f.ended.getTime()-86400000)]);
      await query("transactional_delivery_record_accepted",[`winback:${f.id}`,hash(`winback:${f.id}`),accepted.deliveryReference]);
      const send = vi.fn(async () => accepted);
      expect(await worker({delivery:{readReceipt:async () => accepted,send}}).run()).toMatchObject({scanned:0,sent:0});
      expect(await intents()).toEqual([]); expect(send).not.toHaveBeenCalled();
    });
    it("reconciles an expired ambiguous acceptance without resending", async () => {
      await policy({requireRetentionConsent:false}); await seed();
      const send = vi.fn(async (command: {idempotencyKey:string}) => {
        await query("transactional_delivery_record_accepted",[command.idempotencyKey,hash(command.idempotencyKey),accepted.deliveryReference]); throw new Error("acceptance_response_lost");
      });
      expect(await worker({delivery:{readReceipt:async () => null,send}}).run()).toMatchObject({failed:1});
      await owner.query("UPDATE public.subscriber_retention_intents SET dispatch_claim_expires_at=now()-interval '1 second'");
      expect(await worker().run()).toMatchObject({deduped:1,sent:0,failed:0});
      expect((await intents())[0]!.status).toBe("accepted"); expect(await eventCount()).toBe(1); expect(send).toHaveBeenCalledTimes(1);
    });
    it("serializes two sessions under the subscription-wide send identity", async () => {
      await policy({requireRetentionConsent:false}); await seed(); await plan();
      let entered!: () => void, release!: () => void;
      const inside = new Promise<void>(resolve => {entered=resolve;}), held = new Promise<void>(resolve => {release=resolve;});
      const send = vi.fn(async () => accepted);
      const first = worker({delivery:{readReceipt:async () => null,send},bind:async input => {
        entered(); await held; return {recipientReference:`client:${input.clientId}`,templateReference:"subscriber-winback-v1"};
      }}).run();
      try { await inside; expect(await worker({delivery:{readReceipt:async () => null,send}}).run()).toMatchObject({busy:1,sent:0}); }
      finally { release(); }
      expect(await first).toMatchObject({sent:1,failed:0}); expect(send).toHaveBeenCalledTimes(1);
    // Explicit race bound; normal execution has no timer wait, only deterministic session barriers.
    }, 30_000);
    it("retains browser refusal and the selected runtime authority", async () => {
      const db = await runtime.connect();
      try {
        if (qualified) expect((await db.query("SELECT rolsuper OR rolbypassrls AS elevated FROM pg_roles WHERE rolname=current_user")).rows[0]!.elevated).toBe(false);
        await db.query("BEGIN"); await db.query("SET LOCAL ROLE authenticated");
        await expect(db.query("SELECT public.subscriber_retention_plan_due('winback',1)")).rejects.toMatchObject({code:"42501"});
      } finally { await db.query("ROLLBACK"); db.release(); }
    });
  });
});
