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
  const linkedUserId = randomUUID(), linkedClientId = randomUUID();
  await managed.owner.query("INSERT INTO auth.users(id,email) VALUES($1,'linked-consent@example.invalid')", [linkedUserId]);
  await managed.owner.query(`INSERT INTO public.clients(id,email,auth_user_id,lifecycle_stage)
    VALUES($1,'linked-consent@example.invalid',$2,'customer')`, [linkedClientId, linkedUserId]);
  await managed.owner.query(`INSERT INTO public.communication_contact_links(contact_id,source_table,source_id)
    VALUES($1,'clients',$2)`, [contactId, linkedClientId]);
  const unboundEmail = "linked-consent@example.invalid";
  await managed.owner.query(`UPDATE public.admin_audit_events SET action='invite',entity_type='admin_user',entity_id=$1,
    actor_email=$1,target_email=$1,old_value=$2::jsonb,new_value=$2::jsonb WHERE actor_admin_id=$3`,
  [unboundEmail, JSON.stringify({ email: unboundEmail, note: "unbound person B" }), managed.operator]);
  try {
  const source = await capture(), fresh = await freshTarget();
  const originalBytes = Buffer.from(JSON.stringify(source));
  expect(readManagedRetainedHistory(originalBytes,
    createHash("sha256").update(originalBytes).digest("hex"))).toEqual(source);
  const authHistory = source.rows.find(row => row.relation === "auth.users"
    && (JSON.parse(row.value) as { id: string }).id === userId)!;
  const retagged = { ...source, rows: source.rows.map(row => row === authHistory
    ? { ...row, subjects: [managed.operator] } : row) };
  const { sha256: _retaggedSha, ...retaggedBody } = retagged;
  retagged.sha256 = createHash("sha256").update(JSON.stringify(retaggedBody)).digest("hex");
  const retaggedBytes = Buffer.from(JSON.stringify(retagged));
  expect(() => readManagedRetainedHistory(retaggedBytes,
    createHash("sha256").update(retaggedBytes).digest("hex"))).toThrowError(/postgres_transfer_invalid_input/);
  for (const held of source.rows) {
    const changed = { ...source, rows: source.rows.map(row => row === held
      ? { ...row, subjects: row.subjects.length ? row.subjects.slice(1) : [userId] } : row) };
    const { sha256: _previous, ...body } = changed;
    changed.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const bytes = Buffer.from(JSON.stringify(changed));
    expect(() => readManagedRetainedHistory(bytes,
      createHash("sha256").update(bytes).digest("hex")), held.relation)
      .toThrowError(/postgres_transfer_invalid_input/);
  }
  for (const [relation, field] of [
    ["public.admin_audit_events", "action"],
    ["public.communication_contact_links", "source_table"],
    ["public.communication_email_deliveries", "aggregate_type"],
    ["public.outbox_events", "aggregate_type"],
  ] as const) {
    const held = source.rows.find(row => row.relation === relation)!;
    const value = JSON.parse(held.value) as Record<string, unknown>;
    expect(Object.hasOwn(value, field), `${relation}.${field}`).toBe(true);
    expect(held.minimisations.some(fact => fact.field === field), `${relation}.${field}`).toBe(false);
    expect(value[field], `${relation}.${field}`).not.toBe("[MINIMISED:UNBOUND_PERSONAL_FIELD]");
    for (const reason of ["third-party-capable", "unbound-row", "unknown-json"] as const) {
      const changed = { ...source, rows: source.rows.map(row => row === held ? { ...row,
        value: JSON.stringify({ ...value, [field]: "[MINIMISED:UNBOUND_PERSONAL_FIELD]" }),
        minimisations: [...row.minimisations, { field, reason }] } : row) };
      const { sha256: _prior, ...body } = changed;
      changed.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      const bytes = Buffer.from(JSON.stringify(changed));
      expect(() => readManagedRetainedHistory(bytes,
        createHash("sha256").update(bytes).digest("hex")), `${relation}.${field}:${reason}`)
        .toThrowError(/postgres_transfer_invalid_input/);
    }
    if (relation !== "public.communication_email_deliveries") {
      const replacement = field === "action" ? "customer_read"
        : field === "source_table" ? "catalog_products" : "subscription";
      const changed = { ...source, rows: source.rows.map(row => row === held
        ? { ...row, value: JSON.stringify({ ...value, [field]: replacement }) } : row) };
      const { sha256: _previous, ...body } = changed;
      changed.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      const bytes = Buffer.from(JSON.stringify(changed));
      expect(() => readManagedRetainedHistory(bytes,
        createHash("sha256").update(bytes).digest("hex")), `${relation}.${field}:changed`)
        .toThrowError(/postgres_transfer_invalid_input/);
    }
  }
  let checkedMinimisedFields = 0;
  for (const relation of new Set(source.rows.map(row => row.relation))) {
    const [schema, table] = relation.split(".");
    if (!schema || !table || !/^[a-z_]+$/.test(schema) || !/^[a-z_]+$/.test(table)) throw new Error("Invalid fixture relation");
    const expression = relation === "auth.users"
      ? "pg_catalog.jsonb_build_object('id',t.id,'email',t.email,'created_at',t.created_at,'updated_at',t.updated_at)"
      : "pg_catalog.to_jsonb(t)";
    const actual = (await managed.owner.query<{ value: string }>(`SELECT (${expression})::pg_catalog.text AS value
      FROM "${schema}"."${table}" t`)).rows.map(row => JSON.parse(row.value) as Record<string, unknown>);
    const captured = source.rows.filter(row => row.relation === relation);
    expect(captured, relation).toHaveLength(actual.length);
    for (const row of captured) {
      const value = JSON.parse(row.value) as Record<string, unknown>;
      const original = relation === "storage.buckets" && actual.length === 1
        ? actual[0] : actual.find(candidate => candidate.id === value.id);
      expect(original, relation).toBeDefined();
      for (const [field, originalValue] of Object.entries(original!)) {
        if (row.minimisations.some(fact => fact.field === field)) {
          expect(value[field], `${relation}.${field}`).toBe("[MINIMISED:UNBOUND_PERSONAL_FIELD]");
        } else expect(value[field], `${relation}.${field}`).toEqual(originalValue);
      }
      for (const fact of row.minimisations) {
        checkedMinimisedFields++;
        const restored = { ...value, [fact.field]: original![fact.field] };
        const tampered = { ...source, rows: source.rows.map(entry => entry === row
          ? { ...entry, value: JSON.stringify(restored),
            minimisations: entry.minimisations.filter(candidate => candidate.field !== fact.field) } : entry) };
        const { sha256: _previous, ...tamperedBody } = tampered;
        tampered.sha256 = createHash("sha256").update(JSON.stringify(tamperedBody)).digest("hex");
        const bytes = Buffer.from(JSON.stringify(tampered));
        expect(() => readManagedRetainedHistory(bytes,
          createHash("sha256").update(bytes).digest("hex")), `${relation}.${fact.field}`)
          .toThrowError(/postgres_transfer_invalid_input/);
      }
    }
  }
  expect(checkedMinimisedFields).toBeGreaterThan(0);
  const idempotencyHistory = source.rows.find(row => row.relation === "public.commerce_idempotency_keys")!;
  expect(idempotencyHistory.subjects).toEqual([]);
  expect(idempotencyHistory.minimisations).toContainEqual({ field: "metadata", reason: "unknown-json" });
  expect(idempotencyHistory.value).not.toContain(clientId);
  const auditHistory = source.rows.find(row => row.relation === "public.admin_audit_events")!;
  expect((JSON.parse(auditHistory.value) as { target_admin_id: string | null }).target_admin_id).toBeNull();
  const bucketHistory = source.rows.find(row => row.relation === "storage.buckets")!;
  expect(bucketHistory.rowIdentity).toBe((await managed.owner.query<{ source_key: string }>(
    "SELECT pg_catalog.jsonb_build_array(id)::pg_catalog.text AS source_key FROM storage.buckets WHERE id='retained'"
  )).rows[0]!.source_key);
  expect(auditHistory.minimisations.map(fact => fact.field)).toEqual(expect.arrayContaining([
    "actor_email", "target_email", "old_value", "new_value", "entity_id"]));
  expect(auditHistory.minimisations.find(fact => fact.field === "entity_id")?.reason).toBe("third-party-capable");
  expect(auditHistory.minimisations.find(fact => fact.field === "target_email")?.reason).toBe("third-party-capable");
  expect(auditHistory.value).not.toContain(unboundEmail);
  const withoutFact = { ...source, rows: source.rows.map(row => row === auditHistory
    ? { ...row, minimisations: row.minimisations.filter(fact => fact.field !== "target_email") } : row) };
  const { sha256: _oldDigest, ...withoutFactBody } = withoutFact;
  withoutFact.sha256 = createHash("sha256").update(JSON.stringify(withoutFactBody)).digest("hex");
  const withoutFactBytes = Buffer.from(JSON.stringify(withoutFact));
  expect(() => readManagedRetainedHistory(withoutFactBytes,
    createHash("sha256").update(withoutFactBytes).digest("hex"))).toThrowError(/postgres_transfer_invalid_input/);
  const keyBefore = (await targetOwner!.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows;
  const mapped = await mapManagedRetainedBusiness({ capture: source, issuer: "https://issuer.example.invalid/managed",
    freshTarget: fresh, targetOwner: targetOwner! });
  const consentHistory = mapped.retained.rows.find(row => row.relation === "public.communication_permissions");
  expect(consentHistory?.subjects).toEqual(expect.arrayContaining([clientId, linkedClientId, linkedUserId]));
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
  const objectReadback = readManagedRetainedHistory(object.bytes, object.sha256);
  expect(objectReadback).toEqual(mapped.retained);
  const sourceInvoice = source.rows.find(row => row.relation === "public.accounting_invoices"
    && (JSON.parse(row.value) as { id: string }).id === invoiceId)!;
  const originalInvoice = (await managed.owner.query<{ value: string }>(
    "SELECT pg_catalog.to_jsonb(t)::pg_catalog.text AS value FROM public.accounting_invoices t WHERE id=$1",
    [invoiceId])).rows[0]!.value;
  const invoiceSnapshot = (value: string) => JSON.stringify((JSON.parse(value) as { buyer_snapshot: unknown }).buyer_snapshot);
  expect(invoiceSnapshot(sourceInvoice.value)).toBe(invoiceSnapshot(originalInvoice));
  expect(invoiceSnapshot(objectReadback.rows.find(row => row.relation === "public.accounting_invoices")!.value))
    .toBe(invoiceSnapshot(originalInvoice));
  expect(objectReadback.rows.find(row => row.relation === "public.accounting_invoices")!.value).toBe(sourceInvoice.value);
  const sourceProduct = source.rows.find(row => row.relation === "public.catalog_products"
    && (JSON.parse(row.value) as { id: string }).id === productId)!;
  const originalProduct = (await managed.owner.query<{ value: string }>(
    "SELECT pg_catalog.to_jsonb(t)::pg_catalog.text AS value FROM public.catalog_products t WHERE id=$1",
    [productId])).rows[0]!.value;
  expect(sourceProduct.value).toBe(originalProduct);
  expect(objectReadback.rows.find(row => row.relation === "public.catalog_products")!.value).toBe(originalProduct);
  expect((JSON.parse(objectReadback.rows.find(row => row.relation === "public.catalog_products")!.value) as { description: string }).description)
    .toBe("[MINIMISED:UNBOUND_PERSONAL_FIELD]");
  const changedProduct = { ...source, rows: source.rows.map(row => row === sourceProduct
    ? { ...row, value: JSON.stringify({ ...(JSON.parse(row.value) as Record<string, unknown>), description: "ordinary catalog description" }) }
    : row) };
  const { sha256: _productSha, ...changedProductBody } = changedProduct;
  changedProduct.sha256 = createHash("sha256").update(JSON.stringify(changedProductBody)).digest("hex");
  const changedProductBytes = Buffer.from(JSON.stringify(changedProduct));
  expect(readManagedRetainedHistory(changedProductBytes,
    createHash("sha256").update(changedProductBytes).digest("hex")).rows.find(row => row.relation === "public.catalog_products")?.value)
    .toContain("ordinary catalog description");
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
  const activeClientBefore = (await targetOwner!.query("SELECT id,email FROM public.clients WHERE id=$1", [clientId])).rows;
  const activeConsentBefore = (await targetOwner!.query(`SELECT recipient_fingerprint,purpose,state
    FROM public.communication_recipient_consents`)).rows;
  expect(activeClientBefore).toEqual([{ id: clientId, email }]);
  expect(activeConsentBefore).toEqual([{ recipient_fingerprint: createHash("sha256").update(email).digest("hex"),
    purpose: "marketing_newsletter", state: "suppressed" }]);
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
  expect(mapped.identitySubjects.find(value => value.principalId === targetPrincipal)?.managedId).toBe(userId);
  expect(mapped.retained.rows.some(row => row.subjects.includes(targetPrincipal))).toBe(false);
  const redacted = redactManagedRetainedHistory(mapped.retained, targetPrincipal, mapped.identitySubjects);
  const redactedTransfer = assembleManagedRetainedTransfer({ packet: mapped.packet, retained: redacted });
  const redactedObject = redactedTransfer.retainedObject;
  await retainedObjects.createIfAbsent(redactedObject.object, redactedObject.bytes);
  const redactedChunks: Uint8Array[] = [];
  for await (const chunk of (await retainedObjects.read(redactedObject.key, redactedObject.object.version)).body) redactedChunks.push(chunk);
  expect(redactedTransfer.manifest.retainedSha256).not.toBe(transfer.manifest.retainedSha256);
  expect(Buffer.from(redactedObject.bytes).toString("utf8")).not.toContain(email);
  expect(readManagedRetainedHistory(Buffer.concat(redactedChunks), redactedObject.sha256).rows.some(row =>
    row.subjects.includes(userId) || row.subjects.includes(targetPrincipal))).toBe(false);
  const targetPrincipalB = deriveOidcPrincipalId("https://issuer.example.invalid/managed", linkedUserId);
  expect(mapped.identitySubjects.find(value => value.principalId === targetPrincipalB)?.managedId).toBe(linkedUserId);
  const unrelatedRedacted = redactManagedRetainedHistory(mapped.retained, targetPrincipalB, mapped.identitySubjects);
  const unrelatedObject = exportManagedRetainedHistory(unrelatedRedacted);
  const unrelatedReadback = readManagedRetainedHistory(unrelatedObject.bytes, unrelatedObject.sha256);
  expect(unrelatedReadback.rows.find(row => row.relation === "public.admin_audit_events")?.rowIdentity)
    .toBe(auditHistory.rowIdentity);
  expect(unrelatedReadback.rows.find(row => row.relation === "public.admin_audit_events")?.value)
    .not.toContain(unboundEmail);
  expect(JSON.stringify(unrelatedReadback)).not.toContain(unboundEmail);
  expect(unrelatedReadback.rows).not.toContainEqual(expect.objectContaining({
    relation: consentHistory!.relation, rowIdentity: consentHistory!.rowIdentity }));
  expect(unrelatedReadback.rows).not.toContainEqual(expect.objectContaining({
    relation: "public.clients", rowIdentity: clientId }));
  expect((await targetOwner!.query("SELECT id,email FROM public.clients WHERE id=$1", [clientId])).rows)
    .toEqual(activeClientBefore);
  expect((await targetOwner!.query(`SELECT recipient_fingerprint,purpose,state
    FROM public.communication_recipient_consents`)).rows).toEqual(activeConsentBefore);
  expect((await targetOwner!.query("SELECT id,status,amount_minor::text FROM public.commerce_settlement_intents ORDER BY id")).rows)
    .toEqual([{ id: intentId, status: "failed", amount_minor: "900" },
      { id: paidIntentId, status: "settled", amount_minor: "900" }].sort((a, b) => a.id.localeCompare(b.id)));
  expect((await targetOwner!.query("SELECT order_id,status FROM public.invoicing_duties")).rows)
    .toEqual([{ order_id: paidOrderId, status: "owed" }]);
  } finally {
    await managed.owner.query(`UPDATE public.admin_audit_events SET action='catalog_draft_upsert',
      entity_type='catalog_product',entity_id='synthetic',actor_email=NULL,target_email=NULL,
      old_value=NULL,new_value=NULL WHERE actor_admin_id=$1`, [managed.operator]);
    await managed.owner.query("DELETE FROM public.communication_contact_links WHERE contact_id=$1 AND source_id=$2",
      [contactId, linkedClientId]);
    await managed.owner.query("DELETE FROM public.clients WHERE id=$1", [linkedClientId]);
    await managed.owner.query("DELETE FROM auth.users WHERE id=$1", [linkedUserId]);
  }
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

it("checks settlement invoice conflicts and nullable owner links", async () => {
  const otherClientId = randomUUID(), otherOrderId = randomUUID(), otherInvoiceId = randomUUID();
  const itemId = (await managed.owner.query<{ id: string }>(
    "SELECT id FROM public.payment_provider_settlement_items WHERE payment_intent_id=$1", [paidIntentId])).rows[0]!.id;
  await managed.owner.query("INSERT INTO public.clients(id,email,lifecycle_stage) VALUES($1,$2,'customer')",
    [otherClientId, "other-retained@example.invalid"]);
  try {
    await managed.owner.query(`INSERT INTO public.commerce_orders
      (id,client_id,status,currency,subtotal_cents,total_cents,mode)
      VALUES($1,$2,'pending_payment','XXX',900,900,'one_time')`, [otherOrderId, otherClientId]);
    await managed.owner.query(`INSERT INTO public.accounting_invoices
      (id,order_id,order_ref,invoice_ref,currency,buyer_snapshot,order_snapshot,tax_snapshot,
        lines_snapshot,total_net_cents,total_gross_cents)
      VALUES($1,$2,$3,$4,'XXX','{}','{}','{}','[]',833,900)`,
    [otherInvoiceId, otherOrderId, `order:${otherOrderId}`, `synthetic-invoice:${otherInvoiceId}`]);
    await managed.owner.query("UPDATE public.payment_provider_settlement_items SET invoice_id=$2 WHERE id=$1",
      [itemId, otherInvoiceId]);
    await expect(capture()).rejects.toMatchObject({ code: "target_conflict", table: "public.payment_provider_settlement_items" } satisfies Partial<PostgresTransferError>);
    await managed.owner.query("UPDATE public.payment_provider_settlement_items SET invoice_id=$2 WHERE id=$1",
      [itemId, invoiceId]);
    const sameOrder = await capture();
    expect(sameOrder.rows.find(row => row.relation === "public.payment_provider_settlement_items")?.subjects)
      .toContain(clientId);
    await managed.owner.query("UPDATE public.payment_provider_settlement_items SET invoice_id=NULL WHERE id=$1", [itemId]);
    for (const links of [
      { payment_intent_id: paidIntentId, payment_id: null },
      { payment_intent_id: null, payment_id: paidPaymentId },
    ]) {
      await managed.owner.query(`UPDATE public.payment_provider_settlement_items
        SET payment_intent_id=$2,payment_id=$3 WHERE id=$1`, [itemId, links.payment_intent_id, links.payment_id]);
      const retained = await capture();
      expect(retained.rows.find(row => row.relation === "public.payment_provider_settlement_items")?.subjects)
        .toContain(clientId);
    }
    await managed.owner.query(`UPDATE public.payment_provider_settlement_items
      SET payment_intent_id=NULL,payment_id=NULL,invoice_id=NULL WHERE id=$1`, [itemId]);
    await expect(capture()).rejects.toMatchObject({ code: "invalid_input", table: "public.payment_provider_settlement_batches" } satisfies Partial<PostgresTransferError>);
  } finally {
    await managed.owner.query(`UPDATE public.payment_provider_settlement_items
      SET payment_intent_id=$2,payment_id=$3,invoice_id=NULL WHERE id=$1`, [itemId, paidIntentId, paidPaymentId]);
    await managed.owner.query("DELETE FROM public.accounting_invoices WHERE id=$1", [otherInvoiceId]);
    await managed.owner.query("DELETE FROM public.commerce_orders WHERE id=$1", [otherOrderId]);
    await managed.owner.query("DELETE FROM public.clients WHERE id=$1", [otherClientId]);
  }
});

it("retains every populated email delivery subject and erases cross-subject history on readback", async () => {
  const otherUserId = randomUUID(), otherClientId = randomUUID(), otherContactId = randomUUID();
  const delivery = (await managed.owner.query<{ id: string; contact_id: string | null; auth_user_id: string | null }>(
    "SELECT id,contact_id,auth_user_id FROM public.communication_email_deliveries WHERE client_id=$1 ORDER BY id LIMIT 1",
    [clientId])).rows[0]!;
  await managed.owner.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [otherUserId, "other-delivery@example.invalid"]);
  try {
    await managed.owner.query("INSERT INTO public.clients(id,email,auth_user_id,lifecycle_stage) VALUES($1,$2,$3,'customer')",
      [otherClientId, "other-delivery@example.invalid", otherUserId]);
    await managed.owner.query("INSERT INTO public.communication_contacts(id,normalized_email,display_email) VALUES($1,$2,$2)",
      [otherContactId, "other-delivery@example.invalid"]);
    await managed.owner.query("INSERT INTO public.communication_contact_links(contact_id,source_table,source_id) VALUES($1,'clients',$2)",
      [otherContactId, otherClientId]);
    const checkReadback = async (erased: string, expectedOther: string[]) => {
      const retained = await capture();
      const row = retained.rows.find(value => value.relation === "public.communication_email_deliveries"
        && (JSON.parse(value.value) as { id: string }).id === delivery.id);
      expect(row?.subjects).toEqual(expect.arrayContaining([clientId, ...expectedOther]));
      for (const subject of [clientId, erased]) {
        const redacted = redactManagedRetainedHistory(retained, subject);
        const bytes = Buffer.from(JSON.stringify(redacted));
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        expect(readManagedRetainedHistory(bytes, sha256).rows).not.toContainEqual(expect.objectContaining({ rowIdentity: row!.rowIdentity,
          relation: "public.communication_email_deliveries" }));
      }
    };
    await managed.owner.query("UPDATE public.communication_email_deliveries SET contact_id=$2,auth_user_id=$3 WHERE id=$1",
      [delivery.id, otherContactId, userId]);
    await checkReadback(otherClientId, [otherClientId, otherUserId]);
    await managed.owner.query("UPDATE public.communication_email_deliveries SET contact_id=$2,auth_user_id=$3 WHERE id=$1",
      [delivery.id, contactId, otherUserId]);
    await checkReadback(otherUserId, [otherUserId]);
    await managed.owner.query("UPDATE public.communication_email_deliveries SET contact_id=$2,auth_user_id=$3 WHERE id=$1",
      [delivery.id, contactId, userId]);
    const sameOwner = await capture();
    expect(sameOwner.rows.find(value => value.relation === "public.communication_email_deliveries"
      && (JSON.parse(value.value) as { id: string }).id === delivery.id)?.subjects).toContain(clientId);
  } finally {
    await managed.owner.query("UPDATE public.communication_email_deliveries SET contact_id=$2,auth_user_id=$3 WHERE id=$1",
      [delivery.id, delivery.contact_id, delivery.auth_user_id]);
    await managed.owner.query("DELETE FROM public.communication_contact_links WHERE contact_id=$1", [otherContactId]);
    await managed.owner.query("DELETE FROM public.communication_contacts WHERE id=$1", [otherContactId]);
    await managed.owner.query("DELETE FROM public.clients WHERE id=$1", [otherClientId]);
    await managed.owner.query("DELETE FROM auth.users WHERE id=$1", [otherUserId]);
  }
});

it("unions populated owner links across the finite retained business classes", async () => {
  const b = { user: randomUUID(), client: randomUUID(), contact: randomUUID(), subscription: randomUUID(),
    cycle: randomUUID(), line: randomUUID(), event: randomUUID(), order: randomUUID(), payment: randomUUID(),
    intent: randomUUID(), attempt: randomUUID(), lead: randomUUID(), revoked: randomUUID() };
  const emailB = "provenance-b@example.invalid";
  await managed.owner.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [b.user, emailB]);
  try {
    await managed.owner.query("INSERT INTO public.clients(id,email,auth_user_id,lifecycle_stage) VALUES($1,$2,$3,'customer')",
      [b.client, emailB, b.user]);
    await managed.owner.query("INSERT INTO public.admin_users(id,email,role,is_machine_actor) VALUES($1,$2,'admin',false)",
      [b.user, emailB]);
    await managed.owner.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [b.revoked, "revoked-provenance@example.invalid"]);
    await managed.owner.query(`INSERT INTO public.admin_users
      (id,email,role,is_machine_actor,membership_state,membership_revoked_at,membership_revoked_by)
      VALUES($1,$2,'admin',false,'revoked',now(),$3)`, [b.revoked, "revoked-provenance@example.invalid", b.user]);
    await managed.owner.query("INSERT INTO public.communication_contacts(id,normalized_email,display_email) VALUES($1,$2,$2)",
      [b.contact, emailB]);
    await managed.owner.query("INSERT INTO public.communication_contact_links(contact_id,source_table,source_id) VALUES($1,'clients',$2)",
      [b.contact, b.client]);
    await managed.owner.query("INSERT INTO public.clients(id,email,identity_kind,marketing_contact_id) VALUES($1,$2,'marketing_lead',$3)",
      [b.lead, "provenance-lead@example.invalid", b.contact]);
    await managed.owner.query(`INSERT INTO public.subscriptions
      (id,client_id,cadence_days,currency,region_code,status,next_cycle_at,payment_method_ref,payment_method_kind)
      VALUES($1,$2,28,'XXX','ZZ','active','2027-01-01','b-method','card')`, [b.subscription, b.client]);
    await managed.owner.query(`INSERT INTO public.subscription_cycles
      (id,subscription_id,cycle_number,scheduled_at,status,engine_idempotency_key)
      VALUES($1,$2,0,'2026-11-01','cancelled',$3)`, [b.cycle, b.subscription, `b-cycle:${b.cycle}`]);
    await managed.owner.query("INSERT INTO public.subscription_lines(id,subscription_id,variant_id,qty,sort_order) VALUES($1,$2,$3,1,0)",
      [b.line, b.subscription, skuId]);
    await managed.owner.query(`INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,payload)
      VALUES($1,$2,'created',$3,'{}')`, [b.event, b.subscription, `b-event:${b.event}`]);
    await managed.owner.query(`INSERT INTO public.commerce_orders
      (id,client_id,status,currency,subtotal_cents,total_cents,mode)
      VALUES($1,$2,'pending_payment','XXX',900,900,'one_time')`, [b.order, b.client]);
    await managed.owner.query(`INSERT INTO public.commerce_payments(id,order_id,provider,status,amount_cents,currency)
      VALUES($1,$2,'synthetic-provider','failed',900,'XXX')`, [b.payment, b.order]);
    await managed.owner.query(`INSERT INTO public.commerce_payment_intents
      (id,target_kind,order_id,payment_id,amount_cents,currency,status)
      VALUES($1,'one_time_order',$2,$3,900,'XXX','failed')`, [b.intent, b.order, b.payment]);
    await managed.owner.query(`INSERT INTO public.commerce_payment_attempts
      (id,payment_intent_id,payment_id,provider,idempotency_key,status,amount_cents,currency)
      VALUES($1,$2,$3,'synthetic-provider',$4,'failed',900,'XXX')`, [b.attempt, b.intent, b.payment, `b-attempt:${b.attempt}`]);
    const id = async (table: string, condition: string, value: string) => (await managed.owner.query<{ id: string }>(
      `SELECT id FROM public.${table} WHERE ${condition}=$1 ORDER BY id LIMIT 1`, [value])).rows[0]!.id;
    const existing = { attempt: await id("commerce_payment_attempts", "payment_intent_id", paidIntentId),
      transition: await id("commerce_payment_state_transitions", "payment_intent_id", paidIntentId),
      method: await id("commerce_payment_method_refs", "client_id", clientId),
      cycle: await id("subscription_cycles", "subscription_id", subscriptionId),
      event: await id("subscription_events", "subscription_id", subscriptionId),
      agreement: await id("subscription_price_agreements", "subscription_id", subscriptionId),
      outbox: await id("outbox_events", "aggregate_id", orderId),
      audit: await id("admin_audit_events", "actor_admin_id", managed.operator) };
    const witness = async (relation: string, rowId: string, ownerA: string, ownerB: string,
      change: () => Promise<unknown>, reset: () => Promise<unknown>) => {
      await change();
      try {
        const retained = await capture();
        const row = retained.rows.find(value => value.relation === relation
          && (JSON.parse(value.value) as { id: string }).id === rowId);
        expect(row?.subjects, relation).toEqual(expect.arrayContaining([ownerA, ownerB]));
        for (const subject of [ownerA, ownerB]) {
          const redacted = redactManagedRetainedHistory(retained, subject);
          const bytes = Buffer.from(JSON.stringify(redacted));
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          expect(readManagedRetainedHistory(bytes, sha256).rows, relation).not.toContainEqual(
            expect.objectContaining({ relation, rowIdentity: row!.rowIdentity }));
        }
      } finally { await reset(); }
    };
    await witness("public.clients", b.lead, b.lead, b.client,
      async () => {}, async () => {});
    await witness("public.commerce_payment_intents", paidIntentId, clientId, b.client,
      () => managed.owner.query("UPDATE public.commerce_payment_intents SET active_attempt_id=$2 WHERE id=$1", [paidIntentId, b.attempt]),
      () => managed.owner.query("UPDATE public.commerce_payment_intents SET active_attempt_id=NULL WHERE id=$1", [paidIntentId]));
    await witness("public.commerce_payment_attempts", existing.attempt, clientId, b.client,
      () => managed.owner.query("UPDATE public.commerce_payment_attempts SET payment_id=$2 WHERE id=$1", [existing.attempt, b.payment]),
      () => managed.owner.query("UPDATE public.commerce_payment_attempts SET payment_id=$2 WHERE id=$1", [existing.attempt, paidPaymentId]));
    await witness("public.commerce_payment_state_transitions", existing.transition, clientId, b.client,
      () => managed.owner.query("UPDATE public.commerce_payment_state_transitions SET payment_attempt_id=$2 WHERE id=$1", [existing.transition, b.attempt]),
      () => managed.owner.query("UPDATE public.commerce_payment_state_transitions SET payment_attempt_id=NULL WHERE id=$1", [existing.transition]));
    await witness("public.commerce_payment_method_refs", existing.method, clientId, b.client,
      () => managed.owner.query("UPDATE public.commerce_payment_method_refs SET subscription_id=$2 WHERE id=$1", [existing.method, b.subscription]),
      () => managed.owner.query("UPDATE public.commerce_payment_method_refs SET subscription_id=$2 WHERE id=$1", [existing.method, subscriptionId]));
    await witness("public.subscription_cycles", existing.cycle, clientId, b.client,
      () => managed.owner.query("UPDATE public.subscription_cycles SET order_id=$2 WHERE id=$1", [existing.cycle, b.order]),
      () => managed.owner.query("UPDATE public.subscription_cycles SET order_id=NULL WHERE id=$1", [existing.cycle]));
    await witness("public.subscription_events", existing.event, clientId, b.client,
      () => managed.owner.query("UPDATE public.subscription_events SET cycle_id=$2 WHERE id=$1", [existing.event, b.cycle]),
      () => managed.owner.query("UPDATE public.subscription_events SET cycle_id=NULL WHERE id=$1", [existing.event]));
    await witness("public.subscription_price_agreements", existing.agreement, clientId, b.client,
      () => managed.owner.query("UPDATE public.subscription_price_agreements SET event_id=$2 WHERE id=$1", [existing.agreement, b.event]),
      () => managed.owner.query("UPDATE public.subscription_price_agreements SET event_id=NULL WHERE id=$1", [existing.agreement]));
    await managed.owner.query("UPDATE public.outbox_events SET payload=$2::jsonb WHERE id=$1",
      [existing.outbox, JSON.stringify({ clientId: b.client })]);
    try {
      const retained = await capture();
      const row = retained.rows.find(value => value.relation === "public.outbox_events"
        && (JSON.parse(value.value) as { id: string }).id === existing.outbox)!;
      expect(row.subjects).toContain(clientId);
      expect(row.subjects).not.toContain(b.client);
      expect(row.value).not.toContain(b.client);
      expect(row.minimisations).toContainEqual({ field: "payload", reason: "third-party-capable" });
      const redacted = redactManagedRetainedHistory(retained, b.client);
      const bytes = Buffer.from(JSON.stringify(redacted));
      expect(readManagedRetainedHistory(bytes, createHash("sha256").update(bytes).digest("hex")).rows)
        .toContainEqual(expect.objectContaining({ relation: row.relation, rowIdentity: row.rowIdentity }));
    } finally {
      await managed.owner.query("UPDATE public.outbox_events SET payload='{}'::jsonb WHERE id=$1", [existing.outbox]);
    }
    await witness("public.admin_audit_events", existing.audit, managed.operator, b.user,
      () => managed.owner.query("UPDATE public.admin_audit_events SET target_admin_id=$2 WHERE id=$1", [existing.audit, b.user]),
      () => managed.owner.query("UPDATE public.admin_audit_events SET target_admin_id=NULL WHERE id=$1", [existing.audit]));
    await witness("public.admin_users", b.revoked, b.revoked, b.user,
      async () => {}, async () => {});
    const linkId = (await managed.owner.query<{ id: string }>(`INSERT INTO public.communication_contact_links
      (contact_id,source_table,source_id) VALUES($1,'clients',$2) RETURNING id`, [b.contact, b.lead])).rows[0]!.id;
    try { await witness("public.communication_contact_links", linkId, b.lead, b.client,
      async () => {}, async () => {}); }
    finally { await managed.owner.query("DELETE FROM public.communication_contact_links WHERE id=$1", [linkId]); }
    const unresolvedId = (await managed.owner.query<{ id: string }>(`INSERT INTO public.communication_contact_links
      (contact_id,source_table,source_id) VALUES($1,'clients',$2) RETURNING id`, [contactId, randomUUID()])).rows[0]!.id;
    try {
      await expect(capture()).rejects.toMatchObject({ code: "target_conflict", table: "public.communication_contact_links" } satisfies Partial<PostgresTransferError>);
    } finally { await managed.owner.query("DELETE FROM public.communication_contact_links WHERE id=$1", [unresolvedId]); }
  } finally {
    await managed.owner.query("DELETE FROM public.communication_email_deliveries WHERE client_id=$1", [b.client]);
    await managed.owner.query("DELETE FROM public.outbox_events WHERE aggregate_id IN ($1,$2)", [b.order, b.subscription]);
    await managed.owner.query("DELETE FROM public.commerce_payment_attempts WHERE id=$1", [b.attempt]);
    await managed.owner.query("DELETE FROM public.commerce_payment_intents WHERE id=$1", [b.intent]);
    await managed.owner.query("DELETE FROM public.commerce_payments WHERE id=$1", [b.payment]);
    await managed.owner.query("DELETE FROM public.commerce_orders WHERE id=$1", [b.order]);
    await managed.owner.query("DELETE FROM public.subscription_events WHERE id=$1", [b.event]);
    await managed.owner.query("DELETE FROM public.subscription_lines WHERE id=$1", [b.line]);
    await managed.owner.query("DELETE FROM public.subscription_cycles WHERE id=$1", [b.cycle]);
    await managed.owner.query("DELETE FROM public.subscriptions WHERE id=$1", [b.subscription]);
    await managed.owner.query("DELETE FROM public.clients WHERE id=$1", [b.lead]);
    await managed.owner.query("DELETE FROM public.communication_contact_links WHERE contact_id=$1", [b.contact]);
    await managed.owner.query("DELETE FROM public.communication_contacts WHERE id=$1", [b.contact]);
    await managed.owner.query("DELETE FROM public.clients WHERE id=$1", [b.client]);
    // The managed membership boundary forbids direct admin deletion; the
    // disposable stack removes this synthetic admin and Auth row at teardown.
  }
});

it("retains a completed-erasure subject after Auth deletion without reviving it", async () => {
  const erasedUser = randomUUID(), erasedClient = randomUUID(), deliveryId = randomUUID(), auditId = randomUUID();
  // The pinned managed baseline predates the direct receipt relation. Add only
  // its receipt-shaped forward fixture to exercise the finite capture profile.
  await managed.owner.query(`CREATE TABLE public.identity_privacy_erasures (
    erasure_id uuid PRIMARY KEY, idempotency_key uuid NOT NULL UNIQUE,
    client_id uuid UNIQUE REFERENCES public.clients(id), principal_id uuid UNIQUE,
    actor_principal_id uuid NOT NULL, contract_version text NOT NULL,
    contributor_versions jsonb NOT NULL, dispositions jsonb NOT NULL,
    retained_obligations jsonb NOT NULL, completed_at timestamptz NOT NULL)`);
  try {
    await managed.owner.query("INSERT INTO auth.users(id,email) VALUES($1,'erased-source@example.invalid')", [erasedUser]);
    await managed.owner.query(`INSERT INTO public.clients(id,email,auth_user_id,lifecycle_stage)
      VALUES($1,'erased-source@example.invalid',$2,'customer')`, [erasedClient, erasedUser]);
    await managed.owner.query(`INSERT INTO public.communication_email_deliveries
      (id,client_id,auth_user_id,purpose,template_slug,trigger_source,trigger_event,dedupe_key)
      VALUES($1,$2,$3,'transactional','synthetic-erasure','synthetic_fixture','synthetic.erasure',$4)`,
    [deliveryId, erasedClient, erasedUser, `erased-delivery:${deliveryId}`]);
    await managed.owner.query(`INSERT INTO public.admin_audit_events
      (id,actor_admin_id,action,entity_type,entity_id,source,actor_kind)
      VALUES($1,$2,'customer_read','client',$3,'admin_ui','human')`, [auditId, managed.operator, erasedClient]);
    await managed.owner.query("DELETE FROM auth.users WHERE id=$1", [erasedUser]);
    await managed.owner.query("UPDATE public.clients SET email=$2 WHERE id=$1",
      [erasedClient, `erased+${erasedClient}@identity.invalid`]);
    expect((await managed.owner.query("SELECT auth_user_id FROM public.clients WHERE id=$1", [erasedClient])).rows)
      .toEqual([{ auth_user_id: null }]);
    expect((await managed.owner.query("SELECT auth_user_id FROM public.communication_email_deliveries WHERE id=$1", [deliveryId])).rows)
      .toEqual([{ auth_user_id: erasedUser }]);
    await expect(capture()).rejects.toMatchObject({ code: "target_conflict", table: "public.communication_email_deliveries" } satisfies Partial<PostgresTransferError>);
    await managed.owner.query(`INSERT INTO public.identity_privacy_erasures
      (erasure_id,idempotency_key,client_id,principal_id,actor_principal_id,contract_version,
        contributor_versions,dispositions,retained_obligations,completed_at)
      VALUES($1,$2,$3,$4,$5,'identity.erasure.v1','{}','[]','[]',now())`,
    [randomUUID(), randomUUID(), erasedClient, erasedUser, managed.operator]);
    const retained = await capture();
    expect(retained.rows.filter(row => row.relation === "auth.users"
      && (JSON.parse(row.value) as { id: string }).id === erasedUser)).toHaveLength(0);
    for (const [relation, id] of [["public.clients", erasedClient], ["public.communication_email_deliveries", deliveryId],
      ["public.admin_audit_events", auditId]]) {
      const row = retained.rows.find(value => value.relation === relation
        && (JSON.parse(value.value) as { id: string }).id === id);
      expect(row?.subjects, relation).toContain(erasedUser);
    }
    const redacted = redactManagedRetainedHistory(retained, erasedUser);
    const bytes = Buffer.from(JSON.stringify(redacted)), sha256 = createHash("sha256").update(bytes).digest("hex");
    const readback = readManagedRetainedHistory(bytes, sha256);
    expect(readback.rows.some(row => row.subjects.includes(erasedUser))).toBe(false);
    expect(readback.rows.some(row => row.value.includes("erased-source@example.invalid"))).toBe(false);
  } finally {
    await managed.owner.query("DELETE FROM public.communication_email_deliveries WHERE id=$1", [deliveryId]);
    await managed.owner.query("DELETE FROM public.admin_audit_events WHERE id=$1", [auditId]);
    await managed.owner.query("DELETE FROM public.identity_privacy_erasures WHERE client_id=$1", [erasedClient]);
    await managed.owner.query("DELETE FROM public.clients WHERE id=$1", [erasedClient]);
    await managed.owner.query("DELETE FROM auth.users WHERE id=$1", [erasedUser]);
    await managed.owner.query("DROP TABLE public.identity_privacy_erasures");
  }
}, postgresSetupTimeoutMs);
