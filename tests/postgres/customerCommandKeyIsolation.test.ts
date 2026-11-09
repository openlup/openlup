import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, qualifiedAdminPostgresStartupOptions, type QualifiedPostgresInstallation, type QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { createNativeRenewalCodec, createPostgresRenewalStore } from "@openlup/platform/subscriptions";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const migration = readFileSync("db/platform/migrations/20261106050000_customer_command_key_isolation.sql", "utf8");
// The runner installs the additive quote column once; upgrade fixtures replace only routines.
const forward = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION"));
const oldPause = readFileSync("db/platform/migrations/20260812100000_customer_subscription_pause_actor.sql", "utf8").match(/CREATE FUNCTION[\s\S]*?\n\$\$;/u)![0].replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");
const oldControl = readFileSync("db/platform/migrations/20260813200000_customer_subscription_control.sql", "utf8");
const oldBundle = ["preview", "apply"].map(action => oldControl.match(new RegExp(`CREATE FUNCTION public.customer_subscription_${action}_bundle_as_actor\\([\\s\\S]*?\\n\\$\\$;`, "u"))![0].replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")).join("\n");
const at = "2026-11-06T00:00:00Z", later = "2027-01-01T00:00:00Z";
const commandKey = (actor: string, key: string) => `command:${createHash("sha256").update(`${actor}:${key}`).digest("hex")}`;

describe.each(["legacy", "qualified-v2", "qualified-admin"] as const)("customer key isolation on %s", profile => {
  let container: PostgresContainer, owner: Pool, runtime: Pool;
  const pools: Pool[] = [];
  const pool = (url: string, options?: string) => { const db = new Pool({ connectionString: url, options }); pools.push(db); return db; };
  beforeAll(async () => {
    if (!await dockerAvailable()) throw new Error("Customer command key isolation requires real PostgreSQL");
    container = await runPostgresContainer({ name: `customer-key-${profile}-${process.pid}`, password: "synthetic-conformance" });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Customer key PostgreSQL unavailable");
    const bootstrap = pool(container.connectionString), admin = profile === "qualified-admin";
    const login = (name: string) => { const url = new URL(container.connectionString); url.username = name; return url.toString(); };
    let installation: { generation: "legacy" } | QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation = { generation: "legacy" };
    if (profile !== "legacy") {
      await bootstrap.query(`CREATE ROLE key_m LOGIN ${admin ? "NOINHERIT NOSUPERUSER CREATEROLE" : "INHERIT SUPERUSER NOCREATEROLE"} NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance';
        ALTER DATABASE postgres OWNER TO key_m;
        CREATE ROLE key_r LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance';
        CREATE ROLE key_s LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
      installation = { generation: profile, roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: "key_m", runtimeLogin: "key_r", restoreLogin: "key_s" };
    }
    owner = pool(login(profile === "legacy" ? "postgres" : "key_m"), installation.generation === "qualified-v2" ? qualifiedPostgresStartupOptions(installation)
      : installation.generation === "qualified-admin" ? qualifiedAdminPostgresStartupOptions(installation) : undefined);
    const runner = createPostgresMigrationRunner({ connectionString: "injected" }, { installation, poolFactory: () => owner });
    await runner.apply();
    expect(await runner.apply()).toEqual({ applied: [] });
    if (profile === "legacy") await bootstrap.query(`CREATE ROLE key_r LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'; GRANT authenticated TO key_r`);
    runtime = pool(login("key_r"));
  }, postgresSetupTimeoutMs);
  afterAll(async () => { await closePostgres(container, pools); }, postgresTeardownTimeoutMs);

  async function actor<T>(principal: string, work: (db: PoolClient) => Promise<T>) {
    const db = await runtime.connect();
    try {
      await db.query("BEGIN"); await db.query("SET LOCAL ROLE authenticated");
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: principal, role: "authenticated" })]);
      expect((await db.query("SELECT current_user,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS elevated")).rows).toEqual([{ current_user: "authenticated", elevated: false }]);
      const result = await work(db); await db.query("COMMIT"); return result;
    } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  }
  async function system<T>(work: (db: PoolClient) => Promise<T>) {
    const db = await (profile === "legacy" ? owner : runtime).connect();
    try {
      await db.query("BEGIN");
      if (profile !== "legacy") {
        await db.query("SET LOCAL ROLE service_role");
        expect((await db.query("SELECT current_user,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS elevated")).rows).toEqual([{ current_user: "service_role", elevated: false }]);
      }
      const result = await work(db); await db.query("COMMIT"); return result;
    } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  }
  async function fixture() {
    const principal = randomUUID(), client = randomUUID(), subscription = randomUUID(), sku = randomUUID(), list = randomUUID();
    await owner.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)", [client, `${client}@example.invalid`, principal]);
    await owner.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Synthetic','ZZ','XXX',$2)", [list, at]);
    await owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Synthetic')", [sku, `synthetic-${sku}`]);
    await owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription) VALUES($1,$1,$2,'Synthetic',true)", [sku, `SYNTHETIC-${sku}`]);
    await owner.query("INSERT INTO public.price_entries(variant_id,price_list_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'subscription',100,$3)", [sku, list, at]);
    await owner.query(`INSERT INTO public.subscriptions(id,client_id,status,cadence_days,next_cycle_at,started_at,price_list_id,currency_code)
      VALUES($1,$2,'active',17,$3,$4,$5,'XXX')`, [subscription, client, later, at, list]);
    await owner.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code) VALUES($1,$2,1,0,false,100,'XXX')", [subscription, sku]);
    await owner.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref)
      VALUES($1,'XXX','synthetic-stock','sandbox',$2,'synthetic-authorization')`, [subscription, at]);
    return { principal, client, subscription, sku, list };
  }
  const pause = (f: Awaited<ReturnType<typeof fixture>>, key: string) => actor(f.principal, async db => (await db.query("SELECT public.customer_subscription_pause_as_actor($1,$2) AS result", [f.subscription, key])).rows[0].result.subscriptionAction);
  const events = async (subscription: string) => (await owner.query("SELECT id,event_type,idempotency_key,payload FROM public.subscription_events WHERE subscription_id=$1 ORDER BY id", [subscription])).rows;
  const resumeFixture = (subscription: string) => owner.query("UPDATE public.subscriptions SET status='active' WHERE id=$1", [subscription]);
  const core = (f: Awaited<ReturnType<typeof fixture>>) => JSON.stringify([{ variantId: f.sku, qty: 2 }]);
  const previewBundle = (f: Awaited<ReturnType<typeof fixture>>, key: string) => actor(f.principal, async db =>
    (await db.query("SELECT public.customer_subscription_preview_bundle_as_actor($1,$2,$3) AS result", [f.subscription, key, core(f)])).rows[0].result.preview);
  const applyBundle = (f: Awaited<ReturnType<typeof fixture>>, key: string, hash: string) => actor(f.principal, async db =>
    (await db.query("SELECT public.customer_subscription_apply_bundle_as_actor($1,$2,$3,$4) AS result", [f.subscription, key, hash, core(f)])).rows[0].result.subscriptionAction);
  const state = async (subscription: string) => (await owner.query(`SELECT jsonb_build_object(
    'subscription',(SELECT to_jsonb(s) FROM public.subscriptions s WHERE id=$1),
    'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.subscription_events e WHERE subscription_id=$1),
    'quotes',(SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM public.subscription_edit_quotes q WHERE subscription_id=$1),
    'windows',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM public.subscription_pause_windows w WHERE subscription_id=$1),
    'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM public.subscription_lines l WHERE subscription_id=$1)) AS state`, [subscription])).rows[0].state;
  const identity = (principal: string) => ({ derivation: "principal-sha256.v1", actorId: principal });


  it.each([false, true])("isolates pause from graduation, including legacy=%s and a pre-claimed fallback", async legacy => {
    for (const full of [true, false]) {
      const f = await fixture(), raw = `${full ? "starter-graduation" : "starter-cadence-normalize"}:${f.subscription}:1`;
      if (legacy) await owner.query(oldPause);
      try { expect(await pause(f, raw)).toMatchObject({ status: "applied" }); }
      finally { if (legacy) await owner.query(forward); }
      const customer = await events(f.subscription);
      expect(customer[0].idempotency_key).toBe(legacy ? raw : commandKey(f.principal, raw));
      if (legacy) {
        await resumeFixture(f.subscription); await owner.query(oldPause);
        try { await pause(f, `system:${raw}`); } finally { await owner.query(forward); }
      }
      const before = await events(f.subscription);
      const retained = { version: "native.renewal-terms.v1", minimumPayableMinor: 1, normalCadenceDays: [28],
        starterPack: { schemaVersion: "1", starterIntervalDays: 17, basisTemplateVersion: 1,
          delivery2: { discountBps: 0, discountMinor: 0, basisSubtotalMinor: 100 }, graduation: { cadenceDays: 28,
            lines: [{ sku: `SYNTHETIC-${f.sku}`, qty: 2, sortOrder: 0, isAddon: false,
              quoteLine: { unitPriceGross: { amountMinor: 100 }, lineSubtotalGross: { amountMinor: 200 } } }] } } };
      const cycle = randomUUID(), order = randomUUID();
      // Owner-created retained lineage; the public store below executes every production query.
      await owner.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) VALUES($1,$2,$3,'paid'),($4,$2,'2026-12-01T00:00:00Z','paid')", [cycle, f.subscription, at, randomUUID()]);
      await owner.query("INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,status,currency_code,total_amount_minor) VALUES($1,$2,$3,'pending_payment','XXX',0)", [order, f.client, cycle]);
      await owner.query(`INSERT INTO public.subscription_activations(order_id,client_id,subscription_id,cadence_days,state,payment_fingerprint,activation_idempotency_key,declare_idempotency_key,activated_at)
        VALUES($1,$2,$3,17,'active',$4,$5,$6,$7)`, [order, f.client, f.subscription, "a".repeat(64), randomUUID(), randomUUID(), at]);
      await owner.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3,$4)", [order, f.subscription, JSON.stringify({ templateId: "synthetic", shippingAmountMinor: 0, renewalTerms: retained }), at]);
      await owner.query("UPDATE public.subscription_renewal_terms SET next_cycle_number=2 WHERE subscription_id=$1", [f.subscription]);
      await owner.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,$2,1,100)", [f.subscription, `SYNTHETIC-${f.sku}`]);
      await owner.query("UPDATE public.subscriptions SET template_version=$2 WHERE id=$1", [f.subscription, full ? 1 : 2]);
      await system(async db => {
        const store = createPostgresRenewalStore(db, createNativeRenewalCodec(), work => work(db));
        const snapshot = await store.buildCycleSnapshots({ subscriptionId: f.subscription, scheduledAt: later, scheduledInstant: Date.parse(later) });
        expect(snapshot.templateSnapshot.cadenceDays).toBe(28);
        expect(snapshot.templateSnapshot.lines[0].quantity).toBe(full ? 2 : 1);
      });
      const after = await events(f.subscription);
      expect(after.filter(e => e.event_type.startsWith("subscription.customer_self_service"))).toEqual(before);
      expect(after.find(e => e.event_type === (full ? "subscription.starter_graduated" : "subscription.starter_cadence_normalized"))?.idempotency_key).toBe(legacy ? `system:system:${raw}` : raw);
    }
  });

  it.each([false, true])("records dunning exhaustion once without consuming customer history, legacy=%s", async legacy => {
    const f = await fixture(), cycle = randomUUID(), caseId = randomUUID(), raw = `dunning-exhausted:${caseId}`;
    if (legacy) await owner.query(oldPause);
    try { await pause(f, raw); } finally { if (legacy) await owner.query(forward); }
    const before = await events(f.subscription);
    await owner.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) VALUES($1,$2,$3,'payment_pending')", [cycle, f.subscription, later]);
    await owner.query("INSERT INTO public.subscription_dunning_cases(id,subscription_id,cycle_id,client_id,retry_attempt,idempotency_key) VALUES($1,$2,$3,$4,4,$5)", [caseId, f.subscription, cycle, f.client, randomUUID()]);
    const fail = () => system(async db => (await db.query("SELECT public.dunning_lifecycle_handle_failure($1,$2,'temporary','Synthetic',4,NULL,'synthetic-expired','/recover') AS result", [caseId, at])).rows[0].result);
    expect(await fail()).toMatchObject({ terminal: true, paused: false });
    const after = await events(f.subscription);
    expect(after.filter(e => e.event_type === "subscription.customer_self_service.pause")).toEqual(before);
    expect(after.filter(e => e.event_type === "dunning_ladder_exhausted")).toEqual([expect.objectContaining({ idempotency_key: legacy ? `system:${raw}` : raw })]);
    await fail(); expect(await events(f.subscription)).toEqual(after);
  });

  it("replays legacy and hashed pauses once and refuses foreign ownership and action", async () => {
    const f = await fixture(), raw = "legacy-pause-key";
    await owner.query(oldPause);
    let original;
    try { original = await pause(f, raw); } finally { await owner.query(forward); }
    const before = await events(f.subscription);
    expect(await pause(f, raw)).toMatchObject({ status: "replayed", eventId: original.eventId });
    expect(await events(f.subscription)).toEqual(before);
    const another = await fixture();
    expect(await pause(another, raw)).toMatchObject({ status: "applied" });
    expect((await events(another.subscription))[0]).toMatchObject({ idempotency_key: commandKey(another.principal, raw),
      payload: { payload: { commandKeyIdentity: identity(another.principal) } } });
    await resumeFixture(f.subscription);
    const fresh = "new-pause-key";
    const first = await pause(f, fresh);
    expect(await pause(f, fresh)).toMatchObject({ status: "replayed", eventId: first.eventId });
    expect((await events(f.subscription)).filter(e => e.idempotency_key === commandKey(f.principal, fresh))).toHaveLength(1);
    expect((await owner.query("SELECT count(*)::int AS n FROM public.subscription_pause_windows WHERE subscription_id=$1", [f.subscription])).rows).toEqual([{ n: 2 }]);
    await expect(actor(randomUUID(), db => db.query("SELECT public.customer_subscription_pause_as_actor($1,$2)", [f.subscription, raw]))).rejects.toMatchObject({ code: "22023" });
    await resumeFixture(f.subscription);
    await owner.query("INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload) VALUES($1,'dunning_ladder_exhausted',$2,'{}')", [f.subscription, "foreign-system-key"]);
    expect(await pause(f, "foreign-system-key")).toMatchObject({ status: "applied" });
    await resumeFixture(f.subscription);
    await owner.query("INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload) VALUES($1,'subscription.customer_self_service.cancel',$2,'{\"action\":\"cancel\"}')", [f.subscription, commandKey(f.principal, "wrong-action-key")]);
    await expect(pause(f, "wrong-action-key")).rejects.toMatchObject({ code: "23505" });
  });

  it.each([false, true])("isolates bundle quote/event keys and preserves accepted replay, legacy=%s", async legacy => {
    const f = await fixture(), key = `dunning-exhausted:${randomUUID()}`, core = JSON.stringify([{ variantId: f.sku, qty: 2 }]);
    const preview = () => actor(f.principal, async db => (await db.query("SELECT public.customer_subscription_preview_bundle_as_actor($1,$2,$3) AS result", [f.subscription, key, core])).rows[0].result.preview);
    const apply = (hash: string) => actor(f.principal, async db => (await db.query("SELECT public.customer_subscription_apply_bundle_as_actor($1,$2,$3,$4) AS result", [f.subscription, key, hash, core])).rows[0].result.subscriptionAction);
    if (!legacy) await owner.query("INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload) VALUES($1,'dunning_ladder_exhausted',$2,'{}')", [f.subscription, key]);
    if (legacy) await owner.query(oldBundle);
    let first, quote;
    try { quote = await preview(); first = await apply(quote.quoteHash); } finally { if (legacy) await owner.query(forward); }
    const before = await events(f.subscription);
    expect(before.find(e => e.event_type === "subscription.customer_self_service.update_bundle")?.idempotency_key).toBe(legacy ? key : commandKey(f.principal, key));
    expect(await apply(quote.quoteHash)).toMatchObject({ status: "replayed", eventId: first.eventId });
    const storedQuote = (await owner.query("SELECT command_key_identity FROM public.subscription_edit_quotes WHERE subscription_id=$1", [f.subscription])).rows[0];
    expect(storedQuote.command_key_identity).toEqual(legacy ? null : identity(f.principal));
    if (!legacy) expect(before.find(e => e.event_type === "subscription.customer_self_service.update_bundle")?.payload.commandKeyIdentity).toEqual(identity(f.principal));
    expect(await events(f.subscription)).toEqual(before);
    expect((await owner.query("SELECT count(*)::int AS n FROM public.subscription_edit_quotes WHERE subscription_id=$1", [f.subscription])).rows).toEqual([{ n: 1 }]);
  });


  it("refuses the reserved command prefix at all three customer entries without false replay", async () => {
    const f = await fixture(), key = "reserved-prefix-key";
    await pause(f, key); await resumeFixture(f.subscription);
    const before = await state(f.subscription), reserved = commandKey(f.principal, key);
    const refusal = { code: "22023", message: "subscription_command_reserved_idempotency_key" };
    await expect(pause(f, reserved)).rejects.toMatchObject(refusal);
    await expect(previewBundle(f, reserved)).rejects.toMatchObject(refusal);
    await expect(applyBundle(f, reserved, "a".repeat(64))).rejects.toMatchObject(refusal);
    expect(await state(f.subscription)).toEqual(before);
  });

  it.each(["pause", "update_bundle"])("refuses a legacy %s event stored at a distinct command's derived key", async action => {
    const f = await fixture(), key = "ambiguous-event-key", raw = commandKey(f.principal, key);
    await owner.query(`${oldPause}\n${oldBundle}`);
    let quoteHash = "a".repeat(64);
    try {
      if (action === "pause") await pause(f, raw);
      else { quoteHash = (await previewBundle(f, raw)).quoteHash; await applyBundle(f, raw, quoteHash); }
    } finally { await owner.query(forward); }
    await resumeFixture(f.subscription);
    const before = await state(f.subscription);
    const refusal = { code: "23505", message: "subscription_command_ambiguous_idempotency_key" };
    await expect(pause(f, key)).rejects.toMatchObject(refusal);
    await expect(previewBundle(f, key)).rejects.toMatchObject(refusal);
    await expect(applyBundle(f, key, quoteHash)).rejects.toMatchObject(refusal);
    expect(await state(f.subscription)).toEqual(before);
  });

  it("refuses an unmarked legacy quote at the derived key before preview, apply or pause", async () => {
    const f = await fixture(), key = "ambiguous-quote-key", raw = commandKey(f.principal, key);
    await owner.query(oldBundle);
    let quote;
    try { quote = await previewBundle(f, raw); } finally { await owner.query(forward); }
    const before = await state(f.subscription);
    const refusal = { code: "23505", message: "subscription_command_ambiguous_idempotency_key" };
    await expect(previewBundle(f, key)).rejects.toMatchObject(refusal);
    await expect(applyBundle(f, key, quote.quoteHash)).rejects.toMatchObject(refusal);
    await expect(pause(f, key)).rejects.toMatchObject(refusal);
    expect(await state(f.subscription)).toEqual(before);
  });

  it.each(["pause", "update_bundle"])("refuses reuse of a legacy %s key for another customer action", async action => {
    const f = await fixture(), key = "legacy-other-action-key";
    await owner.query(`${oldPause}\n${oldBundle}`);
    let quote;
    try {
      quote = await previewBundle(f, key);
      if (action === "pause") await pause(f, key);
      else await applyBundle(f, key, quote.quoteHash);
    } finally { await owner.query(forward); }
    await resumeFixture(f.subscription);
    const before = await state(f.subscription);
    if (action === "pause") {
      await expect(applyBundle(f, key, quote.quoteHash)).rejects.toMatchObject({ code: "23505", message: "subscription_edit_idempotency_conflict" });
      await expect(previewBundle(f, key)).rejects.toMatchObject({ code: "23505", message: "subscription_edit_idempotency_conflict" });
    } else await expect(pause(f, key)).rejects.toMatchObject({ code: "23505", message: "subscription_lifecycle_idempotency_conflict" });
    const stranger = await fixture();
    await expect(actor(stranger.principal, db => db.query("SELECT public.customer_subscription_pause_as_actor($1,$2)", [f.subscription, key])))
      .rejects.toMatchObject({ code: "22023", message: "subscription_lifecycle_forbidden" });
    expect(await state(f.subscription)).toEqual(before);
  });

  it("accepts a legacy in-flight quote once and marks only the new hashed event", async () => {
    const f = await fixture(), key = "legacy-inflight-quote";
    await owner.query(oldBundle);
    let quote;
    try { quote = await previewBundle(f, key); } finally { await owner.query(forward); }
    const first = await applyBundle(f, key, quote.quoteHash), before = await state(f.subscription);
    expect(first.status).toBe("applied");
    expect(await applyBundle(f, key, quote.quoteHash)).toMatchObject({ status: "replayed", eventId: first.eventId });
    expect(await state(f.subscription)).toEqual(before);
    expect(before.quotes).toEqual([expect.objectContaining({ idempotency_key: key, command_key_identity: null, accepted_event_id: first.eventId })]);
    expect(before.events).toEqual([expect.objectContaining({ idempotency_key: commandKey(f.principal, key),
      payload: expect.objectContaining({ commandKeyIdentity: identity(f.principal) }) })]);
  });

  it("keeps all new customer keys disjoint from system key forms", async () => {
    for (const prefix of ["starter-graduation", "starter-cadence-normalize", "dunning-exhausted", "system:dunning-exhausted"]) {
      const f = await fixture(), key = `${prefix}:${f.subscription}:1`;
      await pause(f, key);
      const [event] = await events(f.subscription);
      expect(event.idempotency_key).toBe(commandKey(f.principal, key));
      expect(event.idempotency_key).toMatch(/^command:[0-9a-f]{64}$/u);
      expect(event.idempotency_key).not.toMatch(/^(?:system:)*(?:starter-graduation|starter-cadence-normalize|dunning-exhausted):/u);
    }
  });
});
