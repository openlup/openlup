// Disposable pinned managed source for the opt-in three-installation M14 journey.
// Reuses the predecessor fixture shape; contains synthetic values only.
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";
import { captureManagedRetainedHistory } from "../../server/adapters/postgres/connectedManagedRetained.js";
import { deriveCliImages } from "../../scripts/ci-image-mirror.mjs";
import { prePullCliImages } from "../../scripts/public-ci-pgtap.mjs";

const run = promisify(execFile);
export const managed = (() => {
  const operator = randomUUID();
  let owner: Pool | undefined, reader: Pool | undefined, connectionString: string | undefined;
  let directory: string | undefined, cliRegistry: string | undefined;
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
      connectionString = `postgresql://supabase_admin:postgres@127.0.0.1:${base + 2}/postgres`;
      owner = new Pool({ connectionString, max: 2 });
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
    async seal() {
      if (!owner || !connectionString || reader) throw new Error("Managed fixture writer already retired");
      await owner.end(); owner = undefined;
      const url = new URL(connectionString);
      url.searchParams.set("options", "-c default_transaction_read_only=on");
      reader = new Pool({ connectionString: url.toString(), max: 1 });
      const identity = await reader.query("SELECT current_setting('default_transaction_read_only') AS readonly");
      if (identity.rows[0]?.readonly !== "on") throw new Error("Managed final reader must be read-only");
      return reader;
    },
    async stop() {
      await owner?.end();
      await reader?.end();
      if (directory) try {
        if (started) await run("env", [`SUPABASE_INTERNAL_IMAGE_REGISTRY=${cliRegistry}`, "supabase", "stop", "--workdir", directory, "--no-backup"],
          { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      } finally { await rm(directory, { recursive: true, force: true }); }
    } };
})();
const sourceId = "managed-retained-synthetic";
const clientId = randomUUID(), userId = randomUUID(), orderId = randomUUID(), paymentId = randomUUID(), intentId = randomUUID();
const subscriptionId = randomUUID(), productId = randomUUID(), deletedProductId = randomUUID();
const skuId = randomUUID(), priceListId = randomUUID(), lineId = randomUUID();
const contactId = randomUUID();
const paidOrderId = randomUUID(), paidPaymentId = randomUUID(), paidIntentId = randomUUID(), invoiceId = randomUUID();
const email = "retained@example.invalid";
export const managedFixtureIds = { sourceId, clientId, userId, orderId, paymentId, intentId,
  subscriptionId, productId, deletedProductId, skuId, priceListId, lineId, contactId,
  paidOrderId, paidPaymentId, paidIntentId, invoiceId };

export async function seedManagedSource() {
  await managed.owner.query("INSERT INTO auth.users(id,email) VALUES($1,$2),($3,$4)",
    [userId, email, managed.operator, `${managed.operator}@example.invalid`]);
  await managed.owner.query("INSERT INTO public.clients(id,email,auth_user_id,lifecycle_stage) VALUES($1,$2,$3,'customer')",
    [clientId, email, userId]);
  await managed.owner.query("INSERT INTO public.catalog_products(id,slug,status,name) VALUES($1,'retained-product','active','Retained product')", [productId]);
  await managed.owner.query("INSERT INTO public.catalog_products(id,slug,status,name) VALUES($1,'retained-deleted','active','Disposable product')",
    [deletedProductId]);
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
}

export async function captureManagedSource(reader: Pool = managed.owner) {
  return captureManagedRetainedHistory({ sourceId, maximumRows: 10000, maximumBytes: 64 * 1024 * 1024,
    source: { async withSnapshot(work) {
      const client = await reader.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
        await client.query("COMMIT");
        return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    } } });
}
