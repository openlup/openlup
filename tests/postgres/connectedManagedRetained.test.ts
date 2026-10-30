import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { env as processEnvironment } from "node:process";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureManagedSourceGraph, managedIdentityEvidence, mapManagedRetainedBusiness }
  from "../../server/adapters/postgres/connectedManagedRetained.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureConnectedNativeStore, type ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const managed = (() => {
  const operator = randomUUID();
  let owner: Pool | undefined, container: PostgresContainer | undefined;
  return { operator, get owner() { if (!owner) throw new Error("Managed stack not started"); return owner; },
    async start() {
      // Only the opt-in real-source runner supplies this owned loopback port.
      // Required root shards always start the shared stock-PG17 adapter.
      const realPort = processEnvironment.OPENLUP_M14_MANAGED_SOURCE_PORT;
      if (realPort !== undefined) {
        if (!/^\d{4,5}$/u.test(realPort) || Number(realPort) > 65535 || Number(realPort) < 1024)
          throw new Error("Real managed witness requires a valid loopback port");
        owner = new Pool({ connectionString: `postgresql://supabase_admin:postgres@127.0.0.1:${realPort}/postgres`, max: 2 });
      } else {
        container = await runManagedCompatPostgres({ name: `m14-managed-source-${process.pid}`, password: "synthetic-transfer" });
        if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Managed adapter source unavailable");
        owner = new Pool({ connectionString: container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:"), max: 2 });
      }
      await owner.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
      for (const role of ["postgres", "supabase_admin"]) for (const scope of ["", " IN SCHEMA public"])
        for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"])
          await owner.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC,anon,authenticated,service_role`);
      const baseline = readFileSync("supabase/migrations/00000000000000_platform_schema_baseline.sql");
      if (createHash("sha256").update(baseline).digest("hex")
        !== "fb4de62d4ccf30dca83075b41ea2769ddf74165ecd47d21875790ed5f397ccbe") throw new Error("Managed baseline pin mismatch");
      await owner.query("SET ROLE postgres; SET search_path=public,extensions");
      await owner.query(baseline.toString().replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
      await owner.query("RESET ROLE");
      // CLI 2.122 seeds this service table. Keep the positive source limited to
      // the finite admitted profile; unknown nonempty service data still refuses.
      if (realPort !== undefined) await owner.query("DELETE FROM _realtime.feature_flags");
      await owner.query("INSERT INTO public.admin_users(id,email,role,is_machine_actor) VALUES($1,$2,'admin',false)",
        [operator, `${operator}@example.invalid`]);
    },
    async stop() {
      await closePostgres(container, owner);
    } };
})();
const sourceId = "managed-retained-synthetic";
const clientId = randomUUID(), userId = randomUUID(), orderId = randomUUID(), paymentId = randomUUID(), intentId = randomUUID();
const subscriptionId = randomUUID(), productId = randomUUID(), skuId = randomUUID(), priceListId = randomUUID(), lineId = randomUUID();
const paidOrderId = randomUUID(), paidPaymentId = randomUUID(), paidIntentId = randomUUID(), settlementBatchId = randomUUID();
const settledRefId = randomUUID(), unpaidRefId = randomUUID();
const abandonedCases = (["expired", "cancelled"] as const).map(status => ({
  status, orderId: randomUUID(), paymentId: randomUUID(), intentId: randomUUID(),
  attemptId: randomUUID(), transitionId: randomUUID(), refId: randomUUID(),
}));
const contactId = randomUUID();
const email = "retained@example.invalid";
const selection: QualifiedPostgresInstallation = { generation: "qualified-v2", roleMode: "installer-managed",
  migrationLogin: "transfer_owner", bootstrapLogin: "postgres", runtimeLogin: "transfer_runtime", restoreLogin: "transfer_restore" };
const selected = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")),
  "qualified-v2", { migrationIsBootstrap: false, hasRestore: true });
let targetContainer: PostgresContainer | undefined;
let targetOwner: Pool | undefined, targetBootstrap: Pool | undefined;
let freshBaseline: ConnectedNativeStoreCapture;

beforeAll(async () => {
  await managed.start();
  targetContainer = await runPostgresContainer({ name: `m14-managed-target-${process.pid}`, password: "synthetic-transfer" });
  expect(await waitForPostgresTcpReady(targetContainer.connectionString)).toBe(true);
  targetBootstrap = new Pool({ connectionString: targetContainer.connectionString });
  await targetBootstrap.query(`CREATE ROLE transfer_owner LOGIN INHERIT SUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-transfer';
    ALTER DATABASE postgres OWNER TO transfer_owner;
    CREATE ROLE transfer_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-transfer';
    CREATE ROLE transfer_restore LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-transfer'`);
  const url = new URL(targetContainer.connectionString);
  url.username = selection.migrationLogin;
  const runnerUrl = url.toString();
  url.searchParams.set("options", qualifiedPostgresStartupOptions(selection));
  targetOwner = new Pool({ connectionString: url.toString() });
  const runner = createPostgresMigrationRunner({ connectionString: runnerUrl }, { installation: selection, poolFactory: () => targetOwner! });
  expect((await runner.apply()).applied).toEqual([selected.baseline, ...selected.forward].map(unit => unit.file));
  freshBaseline = await freshTarget();
  await managed.owner.query("INSERT INTO auth.users(id,email) VALUES($1,$2),($3,$4)",
    [userId, email, managed.operator, `${managed.operator}@example.invalid`]);
  await managed.owner.query("INSERT INTO public.clients(id,email,auth_user_id,lifecycle_stage) VALUES($1,$2,$3,'customer')",
    [clientId, email, userId]);
  await managed.owner.query(`INSERT INTO public.catalog_products(id,slug,status,name,description)
    VALUES($1,'retained-product','active','Retained product','[MINIMISED:UNBOUND_PERSONAL_FIELD]')`, [productId]);
  await managed.owner.query(`INSERT INTO public.catalog_skus
    (id,product_id,sku,title,pet_type,status,net_weight_g,kcal_per_unit,sellable_in_subscription)
    VALUES($1,$2,'retained-sku','Retained SKU','other','active',100,100,true)`, [skuId, productId]);
  await managed.owner.query("UPDATE public.catalog_products SET primary_sku_id=$2 WHERE id=$1", [productId, skuId]);
  await managed.owner.query("INSERT INTO public.price_lists(id,name,region_code,currency,status) VALUES($1,'Retained list','ZZ','XXX','active')", [priceListId]);
  await managed.owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor) VALUES($1,$2,'subscription',100)",
    [priceListId, skuId]);
  await managed.owner.query(`INSERT INTO public.subscriptions
    (id,client_id,cadence_days,currency,region_code,status,next_cycle_at,payment_method_ref,payment_method_kind)
    VALUES($1,$2,28,'XXX','ZZ','active','2027-01-01','synthetic-method','card')`, [subscriptionId, clientId]);
  await managed.owner.query(`INSERT INTO public.commerce_payment_method_refs
    (client_id,subscription_id,provider_kind,method_kind,provider_method_ref,provider_mandate_ref,status,active,consent_snapshot)
    VALUES($1,$2,'synthetic-provider','card','synthetic-method','synthetic-mandate','active',true,$3::jsonb)`,
  [clientId, subscriptionId, JSON.stringify({ recurringModel: "O", acceptedAt: "2026-01-01T00:00:00Z" })]);
  await managed.owner.query("INSERT INTO public.subscription_lines(id,subscription_id,variant_id,qty,sort_order) VALUES($1,$2,$3,1,0)",
    [lineId, subscriptionId, skuId]);
  await managed.owner.query(`INSERT INTO public.subscription_price_agreements
    (subscription_id,subscription_line_id,variant_id,currency,unit_price_gross_minor,template_version,source_action,idempotency_key)
    VALUES($1,$2,$3,'XXX',100,1,'synthetic_setup','source-price-agreement:1')`, [subscriptionId, lineId, skuId]);
  await managed.owner.query(`INSERT INTO public.subscription_cycles
    (subscription_id,cycle_number,scheduled_at,status,engine_idempotency_key)
    VALUES($1,0,'2026-11-01','cancelled','source-cycle:0')`, [subscriptionId]);
  await managed.owner.query(`INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload)
    VALUES($1,'created','source-subscription:1','{}')`, [subscriptionId]);
  await managed.owner.query(`INSERT INTO public.communication_contacts(id,normalized_email,display_email)
    VALUES($1,$2,$2)`, [contactId, email]);
  await managed.owner.query(`INSERT INTO public.communication_contact_links(contact_id,source_table,source_id)
    VALUES($1,'clients',$2)`, [contactId, clientId]);
  await managed.owner.query(`INSERT INTO public.communication_permissions(contact_id,purpose,state,source)
    VALUES($1,'marketing_newsletter','suppressed','synthetic_fixture')`, [contactId]);
  await managed.owner.query(`INSERT INTO public.commerce_orders
    (id,client_id,status,currency,subtotal_cents,total_cents,mode)
    VALUES($1,$2,'pending_payment','XXX',900,900,'one_time')`, [orderId, clientId]);
  await managed.owner.query(`INSERT INTO public.commerce_order_items
    (order_id,quantity,unit_price_cents,total_cents,discount_allocated_cents,effective_total_cents,
      effective_net_cents,allocation_ordinal)
    VALUES($1,1,900,900,0,900,833,1)`, [orderId]);
  await managed.owner.query(`INSERT INTO public.commerce_payments(id,order_id,provider,status,amount_cents,currency)
    VALUES($1,$2,'synthetic-provider','failed',900,'XXX')`, [paymentId, orderId]);
  await managed.owner.query(`INSERT INTO public.commerce_payment_intents
    (id,target_kind,order_id,payment_id,amount_cents,currency,status)
    VALUES($1,'one_time_order',$2,$3,900,'XXX','failed')`, [intentId, orderId, paymentId]);
  await managed.owner.query(`INSERT INTO public.commerce_payment_attempts
    (payment_intent_id,payment_id,provider,idempotency_key,status,amount_cents,currency)
    VALUES($1,$2,'synthetic-provider','source-attempt:1','failed',900,'XXX')`, [intentId, paymentId]);
  await managed.owner.query(`INSERT INTO public.commerce_payment_state_transitions
    (payment_intent_id,transition_kind,from_status,to_status,reason,idempotency_key)
    VALUES($1,'intent','created','failed','provider_refused','source-transition:1')`, [intentId]);
  await managed.owner.query(`INSERT INTO public.commerce_orders
    (id,client_id,status,currency,subtotal_cents,total_cents,tax_cents,mode)
    VALUES($1,$2,'paid','XXX',900,900,67,'one_time')`, [paidOrderId, clientId]);
  await managed.owner.query(`UPDATE public.outbox_events SET status='discarded',error='synthetic source policy skip'
    WHERE aggregate_id=$1 AND event_type='commerce.order.paid.email'`, [paidOrderId]);
  await managed.owner.query(`INSERT INTO public.commerce_order_items
    (order_id,quantity,unit_price_cents,total_cents,discount_allocated_cents,effective_total_cents,
      effective_net_cents,allocation_ordinal)
    VALUES($1,1,900,900,0,900,833,1)`, [paidOrderId]);
  await managed.owner.query(`INSERT INTO public.commerce_payments
    (id,order_id,provider,provider_payment_id,status,amount_cents,currency)
    VALUES($1,$2,'synthetic-provider','provider-paid:1','succeeded',900,'XXX')`, [paidPaymentId, paidOrderId]);
  await managed.owner.query(`INSERT INTO public.commerce_payment_intents
    (id,target_kind,order_id,payment_id,amount_cents,currency,status,provider_payment_id)
    VALUES($1,'one_time_order',$2,$3,900,'XXX','succeeded','provider-paid:1')`,
  [paidIntentId, paidOrderId, paidPaymentId]);
  await managed.owner.query(`INSERT INTO public.commerce_payment_attempts
    (payment_intent_id,payment_id,provider,idempotency_key,status,amount_cents,currency)
    VALUES($1,$2,'synthetic-provider','source-attempt:paid','succeeded',900,'XXX')`, [paidIntentId, paidPaymentId]);
  await managed.owner.query(`INSERT INTO public.commerce_payment_state_transitions
    (payment_intent_id,transition_kind,from_status,to_status,reason,idempotency_key)
    VALUES($1,'intent','processing','succeeded','provider_confirmed','source-transition:paid')`, [paidIntentId]);
  await managed.owner.query(`INSERT INTO public.payment_external_refs
    (id,payment_id,provider_kind,provider_payment_id,provider_session_id,raw_payload)
    VALUES($1,$2,'synthetic-provider','provider-paid:1','source-session:paid',$3::jsonb),
      ($4,$5,'synthetic-provider','provider-failed:ref','source-session:unpaid',$6::jsonb)`,
  [settledRefId, paidPaymentId, JSON.stringify({ sourceOnly: "settled-raw-payload-marker" }),
    unpaidRefId, paymentId, JSON.stringify({ sourceOnly: "unpaid-raw-payload-marker" })]);
  for (const abandoned of abandonedCases) {
    await managed.owner.query(`INSERT INTO public.commerce_orders
      (id,client_id,status,currency,subtotal_cents,total_cents,mode)
      VALUES($1,$2,'pending_payment','XXX',900,900,'one_time')`, [abandoned.orderId, clientId]);
    await managed.owner.query(`INSERT INTO public.commerce_order_items
      (order_id,quantity,unit_price_cents,total_cents,discount_allocated_cents,effective_total_cents,
        effective_net_cents,allocation_ordinal)
      VALUES($1,1,900,900,0,900,833,1)`, [abandoned.orderId]);
    await managed.owner.query(`INSERT INTO public.commerce_payments
      (id,order_id,provider,status,amount_cents,currency)
      VALUES($1,$2,'synthetic-provider',$3,900,'XXX')`, [abandoned.paymentId, abandoned.orderId, abandoned.status]);
    await managed.owner.query(`INSERT INTO public.commerce_payment_intents
      (id,target_kind,order_id,payment_id,amount_cents,currency,status)
      VALUES($1,'one_time_order',$2,$3,900,'XXX',$4)`,
    [abandoned.intentId, abandoned.orderId, abandoned.paymentId, abandoned.status]);
    await managed.owner.query(`INSERT INTO public.commerce_payment_attempts
      (id,payment_intent_id,payment_id,provider,idempotency_key,status,amount_cents,currency)
      VALUES($1,$2,$3,'synthetic-provider',$4,$5,900,'XXX')`,
    [abandoned.attemptId, abandoned.intentId, abandoned.paymentId,
      `abandoned-attempt:${abandoned.status}`, abandoned.status]);
    await managed.owner.query(`INSERT INTO public.commerce_payment_state_transitions
      (id,payment_intent_id,payment_attempt_id,transition_kind,from_status,to_status,reason,idempotency_key)
      VALUES($1,$2,$3,'intent','processing',$4,'abandoned',$5)`,
    [abandoned.transitionId, abandoned.intentId, abandoned.attemptId,
      abandoned.status, `abandoned-transition:${abandoned.status}`]);
    await managed.owner.query(`INSERT INTO public.payment_external_refs
      (id,payment_id,provider_kind,provider_payment_id,raw_payload)
      VALUES($1,$2,'synthetic-provider',$3,$4::jsonb)`,
    [abandoned.refId, abandoned.paymentId, `abandoned-provider:${abandoned.status}`,
      JSON.stringify({ sourceOnly: `abandoned-raw:${abandoned.status}` })]);
  }
  await managed.owner.query(`INSERT INTO public.payment_provider_settlement_batches
    (id,provider_kind,provider_batch_id,currency,status,gross_cents,fee_cents,net_cents)
    VALUES($1,'synthetic-provider','synthetic-batch:1','XXX','reconciled',900,0,900)`, [settlementBatchId]);
  await managed.owner.query(`INSERT INTO public.payment_provider_settlement_items
    (batch_id,provider_kind,provider_payment_id,payment_intent_id,payment_id,gross_cents,fee_cents,net_cents,currency,status)
    VALUES($1,'synthetic-provider','provider-paid:1',$2,$3,900,0,900,'XXX','matched')`,
  [settlementBatchId, paidIntentId, paidPaymentId]);
  await managed.owner.query(`INSERT INTO public.commerce_idempotency_keys
    (scope,idempotency_key,status,expires_at,metadata)
    VALUES('checkout','source-expired:1','completed','2020-01-01T00:00:00Z',$1::jsonb)`,
  [JSON.stringify({ clientId })]);
  await managed.owner.query(`INSERT INTO public.outbox_events
    (aggregate_type,aggregate_id,event_type,idempotency_key,payload,status,processed_at)
    VALUES('commerce_order',$1,'synthetic.completed','source-outbox:1','{}','processed','2026-01-01')`, [orderId]);
  await managed.owner.query("DELETE FROM public.communication_email_deliveries");
  await managed.owner.query(`INSERT INTO public.admin_audit_events
    (actor_admin_id,action,entity_type,entity_id,source,actor_kind)
    VALUES($1,'catalog_draft_upsert','catalog_product','synthetic','admin_ui','human')`, [managed.operator]);
  await managed.owner.query("UPDATE public.admin_audit_events SET request_id='other-person@example.invalid' WHERE actor_admin_id=$1",
    [managed.operator]);
}, postgresSetupTimeoutMs);
afterAll(async () => {
  try { await managed.stop(); }
  finally { await closePostgres(targetContainer, [targetOwner, targetBootstrap]); }
}, postgresTeardownTimeoutMs);

async function capture() {
  return captureManagedSourceGraph({ sourceId, maximumRows: 10000, maximumBytes: 64 * 1024 * 1024,
    source: { async withSnapshot(work) {
      const client = await managed.owner.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
        await client.query("COMMIT");
        return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    } },
  });
}

async function freshTarget() {
  return captureConnectedNativeStore({ sourceId: "qualified-target-before-managed-restore", catalogueId: selected.objectInventorySha256,
    maximumRows: 10000, maximumBytes: 64 * 1024 * 1024,
    source: { async withSnapshot(work) {
      const client = await targetOwner!.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
        await client.query("COMMIT");
        return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    } },
  });
}

it("projects typed managed obligations and leaves source history in the operator archive", async () => {
  const source = await capture();
  const fresh = await freshTarget();
  expect(Object.keys(source).sort()).toEqual(["dispositions", "observation", "sha256", "sourceId"]);
  expect(source.dispositions.find(value => value.relation === "auth.users")?.rows).toBe(2);
  expect(source.dispositions.find(value => value.relation === "storage.objects")?.rows).toBe(0);
  expect(source.dispositions.find(value => value.relation === "public.admin_audit_events"))
    .toMatchObject({ rows: 1, disposition: "retained-history", reason: "operator source archive; no transfer row" });
  for (const relation of ["public.payment_provider_settlement_batches", "public.payment_provider_settlement_items",
    "public.commerce_idempotency_keys"]) {
    expect(source.dispositions.find(value => value.relation === relation), relation)
      .toMatchObject({ rows: 1, disposition: "retained-history", reason: "operator source archive; no transfer row" });
  }
  expect(source.dispositions.find(value => value.relation === "public.payment_external_refs"))
    .toMatchObject({ rows: 4, disposition: "retained-history", reason: "operator source archive; no transfer row" });
  expect(source.dispositions.find(value => value.relation === "public.outbox_events")?.rows).toBeGreaterThan(0);
  expect(JSON.stringify(source)).not.toContain("catalog_draft_upsert");
  expect(JSON.stringify(source)).not.toContain("retained@example.invalid");
  expect(JSON.stringify(source)).not.toContain("other-person@example.invalid");
  const evidence = managedIdentityEvidence(source, "https://issuer.example.invalid/managed");
  expect(evidence.clients).toHaveLength(1);
  const mapped = await mapManagedRetainedBusiness({ capture: source,
    issuer: "https://issuer.example.invalid/managed", freshTarget: fresh, targetOwner: targetOwner! });
  expect(Object.keys(mapped).sort()).toEqual(["identitySubjects", "packet"]);
  expect(mapped.packet.compatible.tables.find(value => value.table === "commerce_orders")?.rows).toHaveLength(4);
  expect(mapped.packet.compatible.tables.find(value => value.table === "commerce_settlement_intents")?.rows).toHaveLength(2);
  expect(mapped.packet.compatible.tables.find(value => value.table === "commerce_settlement_transitions")?.rows).toHaveLength(2);
  expect(mapped.packet.compatible.tables.find(value => value.table === "subscription_renewal_terms")?.rows).toHaveLength(1);
  expect(mapped.packet.owned.find(value => value.table === "subscription_lines")?.rows).toHaveLength(1);
  const keyBefore = (await targetOwner!.query(
    "SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows;
  expect(await restoreConnectedNativeStore({ owner: targetOwner!, installation: selection,
    packet: mapped.packet, freshTarget: fresh })).toMatchObject({ replayed: false });
  expect((await targetOwner!.query("SELECT id,status,total_amount_minor::text FROM public.commerce_orders")).rows)
    .toEqual(expect.arrayContaining([{ id: orderId, status: "pending_payment", total_amount_minor: "900" },
      { id: paidOrderId, status: "paid", total_amount_minor: "900" }]));
  expect((await targetOwner!.query("SELECT id,status,amount_minor::text FROM public.commerce_settlement_intents")).rows)
    .toEqual(expect.arrayContaining([{ id: intentId, status: "failed", amount_minor: "900" },
      { id: paidIntentId, status: "settled", amount_minor: "900" }]));
  expect((await targetOwner!.query("SELECT external_ref FROM public.commerce_settlement_intents WHERE id=$1", [paidIntentId])).rows)
    .toEqual([{ external_ref: "provider-paid:1" }]);
  for (const abandoned of abandonedCases) {
    expect((await targetOwner!.query("SELECT id,status FROM public.commerce_orders WHERE id=$1", [abandoned.orderId])).rows)
      .toEqual([{ id: abandoned.orderId, status: "pending_payment" }]);
    expect((await targetOwner!.query("SELECT id FROM public.commerce_settlement_intents WHERE id=$1", [abandoned.intentId])).rows)
      .toEqual([]);
    expect((await targetOwner!.query("SELECT id FROM public.commerce_settlement_transitions WHERE id=$1", [abandoned.transitionId])).rows)
      .toEqual([]);
  }
  expect((await targetOwner!.query("SELECT to_regclass('public.payment_external_refs') AS relation")).rows)
    .toEqual([{ relation: null }]);
  expect((await targetOwner!.query("SELECT subscription_id,delivery_admission FROM public.subscription_renewal_terms")).rows)
    .toEqual([{ subscription_id: subscriptionId, delivery_admission: "blocked" }]);
  expect((await targetOwner!.query("SELECT recipient_fingerprint,purpose,state FROM public.communication_recipient_consents")).rows)
    .toEqual([{ recipient_fingerprint: createHash("sha256").update(email).digest("hex"),
      purpose: "marketing_newsletter", state: "suppressed" }]);
  expect(JSON.stringify(mapped.packet)).not.toContain("catalog_draft_upsert");
  expect(JSON.stringify(mapped.packet)).not.toContain("source-attempt:1");
  expect(JSON.stringify(mapped.packet)).not.toContain("other-person@example.invalid");
  expect(JSON.stringify(mapped.packet)).not.toContain("synthetic-batch:1");
  expect(JSON.stringify(mapped.packet)).not.toContain("source-expired:1");
  for (const sourceOnly of [settledRefId, unpaidRefId, "source-session:paid", "source-session:unpaid",
    "settled-raw-payload-marker", "unpaid-raw-payload-marker",
    ...abandonedCases.flatMap(value => [value.paymentId, value.intentId, value.attemptId,
      value.transitionId, value.refId, `abandoned-raw:${value.status}`])])
    expect(JSON.stringify(mapped.packet)).not.toContain(sourceOnly);
  const terminalOutbox = (await managed.owner.query<{ id: string }>(
    "SELECT id FROM public.outbox_events WHERE idempotency_key='source-outbox:1'")).rows[0]!.id;
  expect(mapped.packet.compatible.tables.find(value => value.table === "outbox_events")?.rows
    .some(value => (JSON.parse(value) as { id: string }).id === terminalOutbox)).toBe(false);
  expect((await targetOwner!.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows)
    .toEqual(keyBefore);
  for (const table of [...mapped.packet.compatible.tables, ...mapped.packet.owned]) {
    if (!table.rows.length) continue;
    const actual = (await targetOwner!.query<{ value: string }>(`SELECT pg_catalog.to_jsonb(t)::pg_catalog.text AS value
      FROM public."${table.table}" t`)).rows.map(row => row.value).sort();
    expect(actual, table.table).toEqual([...table.rows].sort());
  }
  expect((await restoreConnectedNativeStore({ owner: targetOwner!, installation: selection,
    packet: mapped.packet, freshTarget: fresh })).replayed).toBe(true);
}, postgresSetupTimeoutMs);

it("refuses conflicting mapped fields and an unexpired completed idempotency window", async () => {
  await managed.owner.query("UPDATE auth.users SET email='conflict@example.invalid' WHERE id=$1", [userId]);
  try {
    const source = await capture();
    expect(() => managedIdentityEvidence(source, "https://issuer.example.invalid/managed"))
      .toThrowError(/postgres_transfer_target_conflict:auth.users/);
  }
  finally { await managed.owner.query("UPDATE auth.users SET email=$2 WHERE id=$1", [userId, email]); }
  await managed.owner.query(`INSERT INTO public.commerce_idempotency_keys
    (scope,idempotency_key,status,expires_at,metadata)
    VALUES('checkout','source-checkout:1','completed','2099-01-01T00:00:00Z',$1::jsonb)`,
    [JSON.stringify({ clientId })]);
  try {
    const source = await capture(), fresh = freshBaseline;
    expect(source.dispositions.find(value => value.relation === "public.commerce_idempotency_keys")?.disposition)
      .toBe("requires-active-mapping");
    await expect(mapManagedRetainedBusiness({ capture: source, issuer: "https://issuer.example.invalid/managed",
      freshTarget: fresh, targetOwner: targetOwner! }))
      .rejects.toMatchObject({ code: "unsupported_table", table: "public.commerce_idempotency_keys" });
    await managed.owner.query("UPDATE public.commerce_idempotency_keys SET status='in_progress',expires_at='2020-01-01' WHERE idempotency_key='source-checkout:1'");
    const unfinished = await capture();
    await expect(mapManagedRetainedBusiness({ capture: unfinished, issuer: "https://issuer.example.invalid/managed",
      freshTarget: fresh, targetOwner: targetOwner! }))
      .rejects.toMatchObject({ code: "unsupported_table", table: "public.commerce_idempotency_keys" });
  } finally { await managed.owner.query("DELETE FROM public.commerce_idempotency_keys WHERE idempotency_key='source-checkout:1'"); }
  await managed.owner.query("UPDATE public.commerce_payment_intents SET amount_cents=901 WHERE id=$1", [intentId]);
  try {
    const source = await capture();
    await expect(mapManagedRetainedBusiness({ capture: source, issuer: "https://issuer.example.invalid/managed",
      freshTarget: freshBaseline, targetOwner: targetOwner! }))
      .rejects.toMatchObject({ code: "target_conflict", table: "public.commerce_payment_intents" });
  } finally { await managed.owner.query("UPDATE public.commerce_payment_intents SET amount_cents=900 WHERE id=$1", [intentId]); }
});

it("refuses a carried payment attempt or transition linked to contradictory payment state", async () => {
  const failedAttempt = (await managed.owner.query<{ id: string }>(
    "SELECT id FROM public.commerce_payment_attempts WHERE payment_intent_id=$1", [intentId])).rows[0]!;
  const paidAttempt = (await managed.owner.query<{ id: string }>(
    "SELECT id FROM public.commerce_payment_attempts WHERE payment_intent_id=$1", [paidIntentId])).rows[0]!;
  const failedTransition = (await managed.owner.query<{ id: string }>(
    "SELECT id FROM public.commerce_payment_state_transitions WHERE payment_intent_id=$1", [intentId])).rows[0]!;
  const refuses = async () => {
    const source = await capture();
    await expect(mapManagedRetainedBusiness({ capture: source, issuer: "https://issuer.example.invalid/managed",
      freshTarget: freshBaseline, targetOwner: targetOwner! }))
      .rejects.toMatchObject({ code: "target_conflict", table: "public.commerce_payment_intents" });
  };
  for (const [column, bad, original] of [
    ["payment_id", paidPaymentId, paymentId], ["amount_cents", 901, 900],
    ["currency", "YYY", "XXX"], ["provider", "other-provider", "synthetic-provider"],
  ] as const) {
    await managed.owner.query(`UPDATE public.commerce_payment_attempts SET ${column}=$1 WHERE id=$2`, [bad, failedAttempt.id]);
    try { await refuses(); }
    finally { await managed.owner.query(`UPDATE public.commerce_payment_attempts SET ${column}=$1 WHERE id=$2`,
      [original, failedAttempt.id]); }
  }
  await managed.owner.query("UPDATE public.commerce_payment_state_transitions SET payment_attempt_id=$1 WHERE id=$2",
    [paidAttempt.id, failedTransition.id]);
  try { await refuses(); }
  finally { await managed.owner.query("UPDATE public.commerce_payment_state_transitions SET payment_attempt_id=NULL WHERE id=$1",
    [failedTransition.id]); }
  await managed.owner.query("UPDATE public.commerce_payment_attempts SET payment_id=$1 WHERE id=$2",
    [paymentId, paidAttempt.id]);
  try { await refuses(); }
  finally { await managed.owner.query("UPDATE public.commerce_payment_attempts SET payment_id=$1 WHERE id=$2",
    [paidPaymentId, paidAttempt.id]); }
});

it("refuses non-reconciled settlement and active delivery state", async () => {
  await managed.owner.query("UPDATE public.payment_provider_settlement_batches SET status='observed' WHERE id=$1",
    [settlementBatchId]);
  try {
    const source = await capture();
    expect(source.dispositions.find(value => value.relation === "public.payment_provider_settlement_batches")?.disposition)
      .toBe("requires-active-mapping");
    await expect(mapManagedRetainedBusiness({ capture: source, issuer: "https://issuer.example.invalid/managed",
      freshTarget: freshBaseline, targetOwner: targetOwner! }))
      .rejects.toMatchObject({ code: "unsupported_table", table: "public.payment_provider_settlement_batches" });
  } finally { await managed.owner.query("UPDATE public.payment_provider_settlement_batches SET status='reconciled' WHERE id=$1",
    [settlementBatchId]); }
  const work = (await managed.owner.query<{ id: string; event_type: string }>(
    "SELECT id,event_type FROM public.outbox_events WHERE aggregate_type='subscription' AND aggregate_id=$1 AND status='pending' LIMIT 1",
    [subscriptionId])).rows[0]!;
  expect(work).toBeDefined();
  const deliveryId = randomUUID();
  await managed.owner.query(`INSERT INTO public.communication_email_deliveries
    (id,client_id,auth_user_id,purpose,template_slug,trigger_source,trigger_event,
      aggregate_type,aggregate_id,outbox_event_id,dedupe_key,status)
    VALUES($1,$2,$3,'transactional','synthetic','synthetic_fixture',$4,
      'subscription',$5,$6,$7,'planned')`,
  [deliveryId, clientId, userId, work.event_type, subscriptionId, work.id, `active-delivery:${deliveryId}`]);
  try {
    const source = await capture();
    await expect(mapManagedRetainedBusiness({ capture: source, issuer: "https://issuer.example.invalid/managed",
      freshTarget: freshBaseline, targetOwner: targetOwner! }))
      .rejects.toMatchObject({ code: "unsupported_table", table: "public.communication_email_deliveries" });
  } finally { await managed.owner.query("DELETE FROM public.communication_email_deliveries WHERE id=$1", [deliveryId]); }
});

it("refuses in-flight, mismatched, extra and unmapped provider reference state", async () => {
  const refuses = async () => {
    const source = await capture();
    expect(source.dispositions.find(value => value.relation === "public.payment_external_refs")?.disposition)
      .toBe("requires-active-mapping");
    await expect(mapManagedRetainedBusiness({ capture: source, issuer: "https://issuer.example.invalid/managed",
      freshTarget: freshBaseline, targetOwner: targetOwner! }))
      .rejects.toMatchObject({ code: "unsupported_table", table: "public.payment_external_refs" });
  };
  await managed.owner.query("UPDATE public.payment_external_refs SET provider_payment_id='wrong-provider-id' WHERE id=$1", [settledRefId]);
  try { await refuses(); }
  finally { await managed.owner.query("UPDATE public.payment_external_refs SET provider_payment_id='provider-paid:1' WHERE id=$1", [settledRefId]); }
  await managed.owner.query("UPDATE public.payment_external_refs SET provider_kind='wrong-provider' WHERE id=$1", [settledRefId]);
  try { await refuses(); }
  finally { await managed.owner.query("UPDATE public.payment_external_refs SET provider_kind='synthetic-provider' WHERE id=$1", [settledRefId]); }
  const extraRefId = randomUUID();
  await managed.owner.query(`INSERT INTO public.payment_external_refs(id,payment_id,provider_kind,provider_payment_id)
    VALUES($1,$2,'synthetic-provider','extra-provider-id')`, [extraRefId, paidPaymentId]);
  try { await refuses(); }
  finally { await managed.owner.query("DELETE FROM public.payment_external_refs WHERE id=$1", [extraRefId]); }
  await managed.owner.query("UPDATE public.commerce_payments SET status='pending' WHERE id=$1", [paymentId]);
  try { await refuses(); }
  finally { await managed.owner.query("UPDATE public.commerce_payments SET status='failed' WHERE id=$1", [paymentId]); }
  const unmappedPaymentId = randomUUID(), unmappedRefId = randomUUID();
  await managed.owner.query(`INSERT INTO public.commerce_payments(id,order_id,provider,status,amount_cents,currency)
    VALUES($1,$2,'synthetic-provider','failed',900,'XXX')`, [unmappedPaymentId, orderId]);
  await managed.owner.query(`INSERT INTO public.payment_external_refs(id,payment_id,provider_kind,provider_payment_id)
    VALUES($1,$2,'synthetic-provider','unmapped-provider-id')`, [unmappedRefId, unmappedPaymentId]);
  try { await refuses(); }
  finally { await managed.owner.query("DELETE FROM public.commerce_payments WHERE id=$1", [unmappedPaymentId]); }
});

it("refuses a cancelled checkout with captured money, an active attempt or linked settlement", async () => {
  const cancelled = abandonedCases.find(value => value.status === "cancelled")!;
  const refuses = async () => {
    const source = await capture();
    await expect(mapManagedRetainedBusiness({ capture: source, issuer: "https://issuer.example.invalid/managed",
      freshTarget: freshBaseline, targetOwner: targetOwner! }))
      .rejects.toMatchObject({ code: "unsupported_table", table: "public.payment_external_refs" });
  };
  await managed.owner.query("UPDATE public.commerce_payments SET status='succeeded' WHERE id=$1", [cancelled.paymentId]);
  try { await refuses(); }
  finally { await managed.owner.query("UPDATE public.commerce_payments SET status='cancelled' WHERE id=$1", [cancelled.paymentId]); }
  await managed.owner.query("UPDATE public.commerce_payment_intents SET active_attempt_id=$2 WHERE id=$1",
    [cancelled.intentId, cancelled.attemptId]);
  try { await refuses(); }
  finally { await managed.owner.query("UPDATE public.commerce_payment_intents SET active_attempt_id=NULL WHERE id=$1",
    [cancelled.intentId]); }
  const itemId = randomUUID();
  await managed.owner.query(`INSERT INTO public.payment_provider_settlement_items
    (id,batch_id,provider_kind,provider_payment_id,payment_intent_id,payment_id,
      gross_cents,fee_cents,net_cents,currency,status)
    VALUES($1,$2,'synthetic-provider','abandoned-provider:cancelled',$3,$4,900,0,900,'XXX','matched')`,
  [itemId, settlementBatchId, cancelled.intentId, cancelled.paymentId]);
  try { await refuses(); }
  finally { await managed.owner.query("DELETE FROM public.payment_provider_settlement_items WHERE id=$1", [itemId]); }
});

it("refuses unknown nonempty relations and uncarried Storage metadata", async () => {
  await managed.owner.query("CREATE TABLE public.managed_unmapped_evidence(id uuid PRIMARY KEY)");
  try {
    await managed.owner.query("INSERT INTO public.managed_unmapped_evidence(id) VALUES($1)", [randomUUID()]);
    await expect(capture()).rejects.toMatchObject({ code: "unsupported_table", table: "public.managed_unmapped_evidence" });
  } finally { await managed.owner.query("DROP TABLE public.managed_unmapped_evidence"); }
  await managed.owner.query("INSERT INTO storage.buckets(id,name,public) VALUES('retained','retained',false)");
  await managed.owner.query("INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES('retained','unowned.txt',NULL,'{}')");
  await expect(capture()).rejects.toMatchObject({ code: "invalid_input", table: "storage.objects" });
  await managed.owner.query("UPDATE storage.objects SET owner_id=$1 WHERE bucket_id='retained'", [userId]);
  const source = await capture(), fresh = freshBaseline;
  await expect(mapManagedRetainedBusiness({ capture: source, issuer: "https://issuer.example.invalid/managed",
    freshTarget: fresh, targetOwner: targetOwner! }))
    .rejects.toMatchObject({ code: "unsupported_table", table: "storage.buckets" });
});
