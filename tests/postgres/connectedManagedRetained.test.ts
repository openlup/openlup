import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createFilesystemTransferObjects, PostgresTransferError } from "@openlup/platform/portability";
import { deriveOidcPrincipalId } from "@openlup/platform/identity";
import { assembleManagedRetainedTransfer, captureManagedRetainedHistory, exportManagedRetainedHistory,
  managedIdentityEvidence, mapManagedRetainedBusiness, readManagedRetainedHistory,
  redactManagedRetainedHistory, restoreManagedRetainedTransfer } from "../../server/adapters/postgres/connectedManagedRetained.js";
import { captureConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { deriveCliImages } from "../../scripts/ci-image-mirror.mjs";
import { prePullCliImages } from "../../scripts/public-ci-pgtap.mjs";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const run = promisify(execFile);
const retainedObjectRoots: string[] = [];
const managed = (() => {
  const operator = randomUUID();
  let owner: Pool | undefined, directory: string | undefined, cliRegistry: string | undefined;
  let started = false;
  const free = (port: number) => new Promise<boolean>((resolve, reject) => {
    const server = createServer();
    server.once("error", error => error.message.includes("EADDRINUSE") ? resolve(false) : reject(error));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
  return { operator, get owner() { if (!owner) throw new Error("Managed stack not started"); return owner; },
    async start() {
      if ((await run("supabase", ["--version"])).stdout.trim() !== "2.98.2") throw new Error("Pinned Supabase CLI required");
      const scratch = join(process.cwd(), ".context/scratch");
      await mkdir(scratch, { recursive: true });
      directory = await mkdtemp(join(scratch, "m14-managed-retained-"));
      const project = `m14retained${process.pid}${randomBytes(3).toString("hex")}`;
      let base = 0;
      for (let attempt = 0; attempt < 50; attempt++) {
        const candidate = 55000 + Number.parseInt(randomBytes(2).toString("hex"), 16) % 8000;
        if ((await Promise.all([0, 1, 2, 3, 4, 9, 10].map(offset => free(candidate + offset)))).every(Boolean)) {
          base = candidate; break;
        }
      }
      if (!base) throw new Error("No free local managed port block");
      const replacements: Record<string, string> = { PROJECT_ID: project, SHADOW_PORT: String(base), API_PORT: String(base + 1),
        DB_PORT: String(base + 2), STUDIO_PORT: String(base + 3), MAIL_PORT: String(base + 4),
        POOLER_PORT: String(base + 9), APP_PORT: String(base + 10) };
      const config = readFileSync("config/public-reference-subscription-supabase.toml", "utf8")
        .replace(/\{\{([A-Z_]+)\}\}/gu, (_, key: string) => {
          if (!Object.hasOwn(replacements, key)) throw new Error("Unknown local stack port placeholder");
          return replacements[key]!;
        });
      await mkdir(join(directory, "supabase"));
      await writeFile(join(directory, "supabase/config.toml"), config);
      cliRegistry = await prePullCliImages(deriveCliImages(process.cwd(), directory));
      await run("env", [`SUPABASE_INTERNAL_IMAGE_REGISTRY=${cliRegistry}`, "supabase", "start", "--workdir", directory, "--exclude",
        "gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor"],
      { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
      started = true;
      owner = new Pool({ connectionString: `postgresql://supabase_admin:postgres@127.0.0.1:${base + 2}/postgres`, max: 2 });
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
      await owner.query("INSERT INTO public.admin_users(id,email,role,is_machine_actor) VALUES($1,$2,'admin',false)",
        [operator, `${operator}@example.invalid`]);
    },
    async stop() {
      await owner?.end();
      if (directory) try {
        if (started) await run("env", [`SUPABASE_INTERNAL_IMAGE_REGISTRY=${cliRegistry}`, "supabase", "stop", "--workdir", directory, "--no-backup"],
          { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      } finally { await rm(directory, { recursive: true, force: true }); }
    } };
})();
const sourceId = "managed-retained-synthetic";
const clientId = randomUUID(), userId = randomUUID(), orderId = randomUUID(), paymentId = randomUUID(), intentId = randomUUID();
const subscriptionId = randomUUID(), productId = randomUUID(), skuId = randomUUID(), priceListId = randomUUID(), lineId = randomUUID();
const contactId = randomUUID();
const paidOrderId = randomUUID(), paidPaymentId = randomUUID(), paidIntentId = randomUUID(), invoiceId = randomUUID();
const email = "retained@example.invalid";
const selection: QualifiedPostgresInstallation = { generation: "qualified-v2", roleMode: "installer-managed",
  migrationLogin: "transfer_owner", bootstrapLogin: "postgres", runtimeLogin: "transfer_runtime", restoreLogin: "transfer_restore" };
const selected = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")),
  "qualified-v2", { migrationIsBootstrap: false, hasRestore: true });
let targetContainer: PostgresContainer | undefined;
let targetOwner: Pool | undefined, targetBootstrap: Pool | undefined;

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
  await managed.owner.query("INSERT INTO auth.users(id,email) VALUES($1,$2),($3,$4)",
    [userId, email, managed.operator, `${managed.operator}@example.invalid`]);
  await managed.owner.query("INSERT INTO public.clients(id,email,auth_user_id,lifecycle_stage) VALUES($1,$2,$3,'customer')",
    [clientId, email, userId]);
  await managed.owner.query("INSERT INTO public.catalog_products(id,slug,status,name) VALUES($1,'retained-product','active','Retained product')", [productId]);
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
  await managed.owner.query("INSERT INTO storage.buckets(id,name,public) VALUES('retained','retained',false)");
  await managed.owner.query("INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES('retained','synthetic.txt',$1,'{}')",
    [userId]);
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
    VALUES($1,'one_time_order',$2,$3,900,'XXX','succeeded','provider-paid:1')`, [paidIntentId, paidOrderId, paidPaymentId]);
  await managed.owner.query(`INSERT INTO public.commerce_payment_attempts
    (payment_intent_id,payment_id,provider,idempotency_key,status,amount_cents,currency)
    VALUES($1,$2,'synthetic-provider','source-attempt:paid','succeeded',900,'XXX')`, [paidIntentId, paidPaymentId]);
  await managed.owner.query(`INSERT INTO public.commerce_payment_state_transitions
    (payment_intent_id,transition_kind,from_status,to_status,reason,idempotency_key)
    VALUES($1,'intent','processing','succeeded','provider_confirmed','source-transition:paid')`, [paidIntentId]);
  const batchId = randomUUID();
  await managed.owner.query(`INSERT INTO public.payment_provider_settlement_batches
    (id,provider_kind,provider_batch_id,currency,status,gross_cents,fee_cents,net_cents)
    VALUES($1,'synthetic-provider','synthetic-batch:1','XXX','reconciled',900,0,900)`, [batchId]);
  await managed.owner.query(`INSERT INTO public.payment_provider_settlement_items
    (batch_id,provider_kind,provider_payment_id,payment_intent_id,payment_id,gross_cents,fee_cents,net_cents,currency,status)
    VALUES($1,'synthetic-provider','provider-paid:1',$2,$3,900,0,900,'XXX','matched')`, [batchId, paidIntentId, paidPaymentId]);
  const paidAt = (await managed.owner.query<{ updated_at: Date }>(
    "SELECT updated_at FROM public.commerce_payment_intents WHERE id=$1", [paidIntentId])).rows[0]!.updated_at;
  await managed.owner.query(`INSERT INTO public.accounting_invoices
    (id,order_id,order_ref,invoice_ref,status,currency,buyer_snapshot,order_snapshot,tax_snapshot,
      lines_snapshot,total_net_cents,total_gross_cents,provider_kind,policy_version,payment_completed_at,provider_payment_id)
    VALUES($1,$2,$3,'synthetic-invoice:1','issue_requested','XXX',$4::jsonb,'{}',$5::jsonb,$6::jsonb,833,900,
      'synthetic-provider','invoicing.seller.v1',$7,'provider-paid:1')`,
  [invoiceId, paidOrderId, `order:${paidOrderId}`, JSON.stringify({ name: "Synthetic buyer", email }), JSON.stringify({ taxCents: 67 }),
    JSON.stringify([{ name: "Synthetic item", quantity: 1, unitNetMinor: 833, unitGrossMinor: 900, totalGrossMinor: 900,
      totalNetMinor: 833, vatRateBps: 800 }]), paidAt]);
  await managed.owner.query(`INSERT INTO public.accounting_invoice_issue_outbox
    (invoice_id,provider_kind,status,attempt_count)
    VALUES($1,'synthetic-provider','pending',0)`, [invoiceId]);
  await managed.owner.query(`INSERT INTO public.commerce_idempotency_keys
    (scope,idempotency_key,status,metadata) VALUES('checkout','source-checkout:1','completed',$1::jsonb)`,
  [JSON.stringify({ clientId })]);
  await managed.owner.query(`INSERT INTO public.outbox_events
    (aggregate_type,aggregate_id,event_type,idempotency_key,payload,status,processed_at)
    VALUES('commerce_order',$1,'synthetic.completed','source-outbox:1','{}','processed','2026-01-01')`, [orderId]);
  await managed.owner.query(`INSERT INTO public.admin_audit_events
    (actor_admin_id,action,entity_type,entity_id,source,actor_kind)
    VALUES($1,'catalog_draft_upsert','catalog_product','synthetic','admin_ui','human')`, [managed.operator]);
}, postgresSetupTimeoutMs);
afterAll(async () => {
  try { await managed.stop(); }
  finally {
    try { await closePostgres(targetContainer, [targetOwner, targetBootstrap]); }
    finally { for (const root of retainedObjectRoots) await rm(root, { recursive: true, force: true }); }
  }
}, postgresTeardownTimeoutMs);

async function capture() {
  return captureManagedRetainedHistory({ sourceId, maximumRows: 10000, maximumBytes: 64 * 1024 * 1024,
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

it("maps actual managed identity and failed-but-retryable money into a fresh qualified PG16 target", async () => {
  const source = await capture(), fresh = await freshTarget();
  for (const relation of new Set(source.rows.map(row => row.relation))) {
    const [schema, table] = relation.split(".");
    if (!schema || !table || !/^[a-z_]+$/.test(schema) || !/^[a-z_]+$/.test(table)) throw new Error("Invalid fixture relation");
    const expression = relation === "auth.users"
      ? "pg_catalog.jsonb_build_object('id',t.id,'email',t.email,'created_at',t.created_at,'updated_at',t.updated_at)"
      : "pg_catalog.to_jsonb(t)";
    const actual = (await managed.owner.query<{ value: string }>(`SELECT (${expression})::pg_catalog.text AS value
      FROM "${schema}"."${table}" t`)).rows.map(row => row.value).sort();
    expect(actual, relation).toEqual(source.rows.filter(row => row.relation === relation).map(row => row.value).sort());
  }
  const keyBefore = (await targetOwner!.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows;
  const mapped = await mapManagedRetainedBusiness({ capture: source, issuer: "https://issuer.example.invalid/managed",
    freshTarget: fresh, targetOwner: targetOwner! });
  const retainedIdentity = (rows: typeof source.rows) => rows.map(row =>
    JSON.stringify([row.source, row.relation, row.rowIdentity, row.value])).sort();
  expect(retainedIdentity(mapped.retained.rows)).toEqual(retainedIdentity(source.rows));
  expect(mapped.packet.compatible.tables.find(table => table.table === "commerce_orders")?.rows).toHaveLength(2);
  expect(mapped.packet.compatible.tables.find(table => table.table === "commerce_settlement_intents")?.rows).toHaveLength(2);
  expect(mapped.packet.compatible.tables.find(table => table.table === "subscription_renewal_terms")?.rows).toHaveLength(1);
  expect(mapped.packet.owned.find(table => table.table === "subscription_lines")?.rows).toHaveLength(1);
  const object = exportManagedRetainedHistory(mapped.retained);
  expect(object.object).toMatchObject({ access: "private-retained-history", key: object.key,
    sha256: object.sha256, bytes: object.bytes.byteLength });
  expect(readManagedRetainedHistory(object.bytes, object.sha256)).toEqual(mapped.retained);
  const transfer = assembleManagedRetainedTransfer(mapped);
  const objectRoot = await mkdtemp(join(process.cwd(), ".context/scratch/m14-retained-object-"));
  retainedObjectRoots.push(objectRoot);
  const retainedObjects = await createFilesystemTransferObjects({ root: join(objectRoot, "objects"),
    maximumObjectBytes: 64 * 1024 * 1024, access: "private-retained-history" });
  await expect(restoreManagedRetainedTransfer({ owner: targetOwner!, installation: selection, transfer: {
    ...transfer, retainedObject: { ...transfer.retainedObject, bytes: new Uint8Array() },
  }, retainedObjects, freshTarget: fresh })).rejects.toMatchObject({ code: "invalid_input" } satisfies Partial<PostgresTransferError>);
  await expect(restoreManagedRetainedTransfer({ owner: targetOwner!, installation: selection, transfer,
    retainedObjects, freshTarget: fresh })).rejects.toMatchObject({ code: "absent" });
  expect((await targetOwner!.query("SELECT count(*)::int AS rows FROM public.commerce_orders")).rows[0]?.rows).toBe(0);
  await retainedObjects.createIfAbsent(transfer.retainedObject.object, transfer.retainedObject.bytes);
  const altered = Buffer.from(transfer.retainedObject.bytes);
  altered.writeUInt8(altered.readUInt8(0) ^ 1, 0);
  await expect(restoreManagedRetainedTransfer({ owner: targetOwner!, installation: selection, transfer,
    retainedObjects: { read: async (key, version) => ({ ...(await retainedObjects.read(key, version)),
      body: (async function* () { yield altered; })() }) }, freshTarget: fresh }))
    .rejects.toMatchObject({ code: "invalid_input" } satisfies Partial<PostgresTransferError>);
  expect((await targetOwner!.query("SELECT count(*)::int AS rows FROM public.commerce_orders")).rows[0]?.rows).toBe(0);
  expect(await restoreManagedRetainedTransfer({ owner: targetOwner!, installation: selection, transfer, retainedObjects, freshTarget: fresh }))
    .toMatchObject({ replayed: false });
  expect((await targetOwner!.query("SELECT id,status,total_amount_minor::text FROM public.commerce_orders ORDER BY id")).rows)
    .toEqual([{ id: orderId, status: "pending_payment", total_amount_minor: "900" },
      { id: paidOrderId, status: "paid", total_amount_minor: "900" }].sort((a, b) => a.id.localeCompare(b.id)));
  expect((await targetOwner!.query("SELECT id,status,amount_minor::text FROM public.commerce_settlement_intents ORDER BY id")).rows)
    .toEqual([{ id: intentId, status: "failed", amount_minor: "900" },
      { id: paidIntentId, status: "settled", amount_minor: "900" }].sort((a, b) => a.id.localeCompare(b.id)));
  expect((await targetOwner!.query("SELECT open_idempotency_key FROM public.commerce_settlement_intents")).rows
    .every(row => typeof row.open_idempotency_key === "string" && row.open_idempotency_key.startsWith("managed-transfer-open:"))).toBe(true);
  expect((await targetOwner!.query("SELECT id FROM public.commerce_settlement_transitions")).rows).toHaveLength(2);
  expect((await targetOwner!.query("SELECT id,primary_sku_id FROM public.catalog_products")).rows)
    .toEqual([{ id: productId, primary_sku_id: skuId }]);
  expect((await targetOwner!.query("SELECT id,next_cycle_at::text FROM public.subscriptions")).rows)
    .toEqual([{ id: subscriptionId, next_cycle_at: "2027-01-01 00:00:00+00" }]);
  expect((await targetOwner!.query("SELECT subscription_id,delivery_admission FROM public.subscription_renewal_terms")).rows)
    .toEqual([{ subscription_id: subscriptionId, delivery_admission: "blocked" }]);
  expect((await targetOwner!.query("SELECT recipient_fingerprint,purpose,state FROM public.communication_recipient_consents")).rows)
    .toEqual([{ recipient_fingerprint: createHash("sha256").update(email).digest("hex"), purpose: "marketing_newsletter", state: "suppressed" }]);
  expect((await targetOwner!.query("SELECT id FROM public.outbox_events WHERE status='pending'")).rows).toHaveLength(2);
  expect((await targetOwner!.query("SELECT order_id,status FROM public.invoicing_duties")).rows)
    .toEqual([{ order_id: paidOrderId, status: "owed" }]);
  expect((await targetOwner!.query("SELECT duty_id FROM public.invoicing_fact_revisions")).rows).toHaveLength(1);
  expect((await targetOwner!.query("SELECT receipt_key FROM public.invoicing_effect_receipts ORDER BY receipt_key")).rows)
    .toHaveLength(2);
  expect((await targetOwner!.query("SELECT source_id FROM public.invoicing_due_sources WHERE order_id=$1", [paidOrderId])).rows)
    .toHaveLength(0);
  expect((await targetOwner!.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows)
    .toEqual(keyBefore);
  for (const table of [...mapped.packet.compatible.tables, ...mapped.packet.owned]) {
    if (!table.rows.length) continue;
    const actual = (await targetOwner!.query<{ value: string }>(`SELECT pg_catalog.to_jsonb(t)::pg_catalog.text AS value
      FROM public."${table.table}" t`)).rows.map(row => row.value).sort();
    expect(actual, table.table).toEqual([...table.rows].sort());
  }
  for (const entry of source.dispositions) {
    if (entry.disposition === "credential-excluded" || entry.disposition === "service-installation-history") continue;
    expect(source.rows.filter(row => row.relation === entry.relation), entry.relation).toHaveLength(entry.rows);
  }
  expect((await restoreManagedRetainedTransfer({ owner: targetOwner!, installation: selection, transfer, retainedObjects, freshTarget: fresh })).replayed)
    .toBe(true);
  const targetPrincipal = deriveOidcPrincipalId("https://issuer.example.invalid/managed", userId);
  expect(mapped.retained.rows.filter(row => row.subjects.includes(targetPrincipal)).length).toBeGreaterThan(2);
  const redacted = redactManagedRetainedHistory(mapped.retained, targetPrincipal);
  const redactedTransfer = assembleManagedRetainedTransfer({ packet: mapped.packet, retained: redacted });
  const redactedObject = redactedTransfer.retainedObject;
  await retainedObjects.createIfAbsent(redactedObject.object, redactedObject.bytes);
  const redactedChunks: Uint8Array[] = [];
  for await (const chunk of (await retainedObjects.read(redactedObject.key, redactedObject.object.version)).body) redactedChunks.push(chunk);
  expect(redactedTransfer.manifest.retainedSha256).not.toBe(transfer.manifest.retainedSha256);
  expect(Buffer.from(redactedObject.bytes).toString("utf8")).not.toContain(email);
  expect(readManagedRetainedHistory(Buffer.concat(redactedChunks), redactedObject.sha256).rows.some(row =>
    row.subjects.includes(userId) || row.subjects.includes(targetPrincipal))).toBe(false);
}, postgresSetupTimeoutMs);

it("reads actual managed Auth, Storage and business metadata under one snapshot with private redaction", async () => {
  const retained = await capture();
  expect(retained.rows.filter(row => row.relation === "auth.users")).toHaveLength(2);
  expect(retained.rows.filter(row => row.relation === "storage.objects")).toHaveLength(1);
  expect(retained.rows.filter(row => row.relation === "public.clients")).toHaveLength(1);
  for (const [relation, count] of Object.entries({ "public.commerce_orders": 2, "public.commerce_order_items": 2,
    "public.commerce_payment_intents": 2, "public.commerce_payment_attempts": 2,
    "public.commerce_payment_state_transitions": 2, "public.commerce_idempotency_keys": 1,
    "public.outbox_events": 4, "public.admin_audit_events": 1, "public.subscriptions": 1,
    "public.subscription_lines": 1, "public.subscription_price_agreements": 1,
    "public.commerce_payment_method_refs": 1, "public.subscription_cycles": 1,
    "public.subscription_events": 1, "public.communication_contacts": 1,
    "public.communication_contact_links": 1, "public.communication_permissions": 1,
    "public.communication_email_deliveries": 2,
    "public.accounting_invoices": 1, "public.accounting_invoice_issue_outbox": 1,
    "public.payment_provider_settlement_batches": 1, "public.payment_provider_settlement_items": 1 })) {
    expect(retained.rows.filter(row => row.relation === relation), relation).toHaveLength(count);
  }
  const evidence = managedIdentityEvidence(retained, "https://issuer.example.invalid/managed");
  expect(evidence.clients).toHaveLength(1);
  expect(evidence.subjects).toEqual(expect.arrayContaining([{ managedId: userId, subject: userId },
    { managedId: managed.operator, subject: managed.operator }]));
  expect(() => exportManagedRetainedHistory(retained)).toThrowError(/postgres_transfer_invalid_input/);
  const bytes = Buffer.from(JSON.stringify(retained));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  expect(readManagedRetainedHistory(bytes, sha256)).toEqual(retained);
  const redacted = redactManagedRetainedHistory(retained, userId);
  const redactedBytes = Buffer.from(JSON.stringify(redacted));
  const redactedSha256 = createHash("sha256").update(redactedBytes).digest("hex");
  expect(redactedBytes.toString("utf8")).not.toContain(email);
  expect(readManagedRetainedHistory(redactedBytes, redactedSha256).rows.every(row => !row.subjects.includes(userId))).toBe(true);
  expect(redacted.redactions[0]?.rows.length).toBeGreaterThanOrEqual(2);
});

it("refuses unknown nonempty managed tables and missing subject privacy coverage", async () => {
  await managed.owner.query("CREATE TABLE public.managed_unmapped_evidence(id uuid PRIMARY KEY)");
  try {
    await managed.owner.query("INSERT INTO public.managed_unmapped_evidence(id) VALUES($1)", [randomUUID()]);
    await expect(capture()).rejects.toMatchObject({ code: "unsupported_table", table: "public.managed_unmapped_evidence" } satisfies Partial<PostgresTransferError>);
  } finally { await managed.owner.query("DROP TABLE public.managed_unmapped_evidence"); }
  await managed.owner.query("UPDATE storage.objects SET owner_id=NULL WHERE bucket_id='retained'");
  try { await expect(capture()).rejects.toMatchObject({ code: "invalid_input", table: "storage.objects" } satisfies Partial<PostgresTransferError>); }
  finally { await managed.owner.query("UPDATE storage.objects SET owner_id=$1 WHERE bucket_id='retained'", [userId]); }
});

it("refuses a mapped Auth and client email conflict from actual source rows", async () => {
  await managed.owner.query("UPDATE auth.users SET email='conflict@example.invalid' WHERE id=$1", [userId]);
  try {
    const retained = await capture();
    expect(() => managedIdentityEvidence(retained, "https://issuer.example.invalid/managed"))
      .toThrowError(/postgres_transfer_target_conflict:auth.users/);
  } finally { await managed.owner.query("UPDATE auth.users SET email=$2 WHERE id=$1", [userId, email]); }
});
