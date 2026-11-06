import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import type { PromotionRow } from "@openlup/core/promo";
import type { AcquisitionFinancialPolicy } from "@openlup/platform/pricing";
import type { NativeCheckoutDraftRequest } from "@openlup/platform/commerce/server/native-checkout";
import { platformConsumerInstallArgs, assertConsumerIsolation } from "../../scripts/packages/platform-cold-consumer.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

type TestRequest = NativeCheckoutDraftRequest & { quoteSnapshot: { quote: {
  context: NonNullable<NativeCheckoutDraftRequest["quoteSnapshot"]["quote"]["context"]> & Record<string, unknown>;
} } };

export const policy: AcquisitionFinancialPolicy<PromotionRow> = {
  facts: row => ({ id: row.id, active: row.status === "active", regionCodes: row.region_availability,
    validFrom: row.valid_from, validTo: row.valid_to, mirrorOf: null,
    metadataPresent: Object.hasOwn(row.applies_to_payload, "acquisitionTerms"), metadata: row.applies_to_payload.acquisitionTerms }),
  classify: row => ({ baselineLegacy: false, target: row.eligibility.first_subscription_purchase === true,
    canonicalRow: row.eligibility.first_subscription_purchase === true, unconfiguredLegacyEligible: false }),
  validateMetadata: () => {}, pairMatches: () => false, initialDiscountBps: row => row.discount_value * 100,
  unconfiguredTerms: () => { throw new Error("No unconfigured offer selected in this fixture"); },
};
export const configured = (id: string): PromotionRow => ({ id, name: "Configured acquisition", code: null,
  status: "active", trigger_type: "automatic", discount_type: "percentage", discount_value: 24,
  applies_to_kind: "order_total", applies_to_payload: { cart_mode: "subscription", acquisitionTerms: {
    schemaVersion: "subscription-acquisition.v1", revision: "demo-acquisition-v1", delivery2DiscountBps: 1200 } },
  eligibility: { first_subscription_purchase: true }, stacking_rule: "exclusive", valid_from: "2020-01-01T00:00:00.000Z",
  valid_to: null, region_availability: ["ZZ"], redemption_limit_global: null, redemption_limit_per_customer: 1 });

export async function acquisitionFixture() {
  mkdirSync(".context/scratch", { recursive: true });
  const scratch = mkdtempSync(resolve(".context/scratch/acquisition-packed-"));
  // The installed-consumer guard requires a disposable directory outside the
  // checkout; pack preparation and durable evidence stay in this worktree.
  const consumer = mkdtempSync(join(tmpdir(), "acquisition-consumer-"));
  const pools: Pool[] = [];
  let container: PostgresContainer | undefined;
  const pool = (connectionString: string, options?: string) => { const db = new Pool({ connectionString, options }); pools.push(db); return db; };
  const close = async () => { try { await closePostgres(container, pools); } finally {
    rmSync(consumer, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true });
  } };
  try {
    const npm = (args: string[], cwd: string) => execFileSync("npm", args, { cwd, encoding: "utf8", stdio: "pipe", timeout: 120_000 });
    const peers = ["zod", "pg", "pg-connection-string", "pg-int8", "pg-pool", "pg-protocol", "pg-types", "pgpass",
      "postgres-array", "postgres-bytea", "postgres-date", "postgres-interval", "split2", "xtend", "@types/pg", "@types/node", "undici-types"];
    const tarballs = ["packages/core", "packages/platform", ...peers.map(name => `node_modules/${name}`)].map(directory => {
      const [result] = JSON.parse(npm(["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", scratch], resolve(directory)));
      return join(scratch, result.filename);
    });
    writeFileSync(join(consumer, "package.json"), '{"type":"module","private":true}');
    npm(platformConsumerInstallArgs(tarballs), consumer);
    assertConsumerIsolation(consumer, process.cwd(), false);
    const installed = createRequire(join(consumer, "package.json")).resolve;
    const checkout: typeof import("@openlup/platform/commerce/server/native-checkout") = await import(pathToFileURL(installed("@openlup/platform/commerce/server/native-checkout")).href);
    const promotions: typeof import("@openlup/platform/promotions") = await import(pathToFileURL(installed("@openlup/platform/promotions")).href);
    const pricing: typeof import("@openlup/platform/pricing") = await import(pathToFileURL(installed("@openlup/platform/pricing")).href);
    const migrations: typeof import("@openlup/platform/migrations") = await import(pathToFileURL(installed("@openlup/platform/migrations")).href);
    container = await runPostgresContainer({ name: `acquisition-admission-${process.pid}`, password: "synthetic-conformance" });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Acquisition proof requires host TCP PostgreSQL");
    const owner = pool(container.connectionString);
    await owner.query(`CREATE ROLE acquisition_runtime LOGIN PASSWORD 'synthetic-only' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      CREATE ROLE acquisition_restore LOGIN PASSWORD 'synthetic-only' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    const installation = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: "postgres",
      runtimeLogin: "acquisition_runtime", restoreLogin: "acquisition_restore" } as const;
    const migration = pool(container.connectionString, migrations.qualifiedPostgresStartupOptions(installation));
    const runner = migrations.createPlatformPostgresMigrationRunner({ connectionString: container.connectionString }, { installation, poolFactory: () => migration });
    await runner.apply();
    if ((await runner.status()).pending.length) throw new Error("Packaged acquisition migrations remain pending");
    const runtimeUrl = new URL(container.connectionString); runtimeUrl.username = "acquisition_runtime"; runtimeUrl.password = "synthetic-only";
    const runtime = pool(runtimeUrl.toString());
    const list = randomUUID(), product = randomUUID(), sku = `ACQUISITION-${product}`;
    await owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Fictional item')", [product, sku.toLowerCase()]);
    await owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription) VALUES($1,$1,$2,'Fictional item',true)", [product, sku]);
    await owner.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Fictional list','ZZ','XXX')", [list]);
    await owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor) VALUES($1,$2,1000)", [list, product]);
    async function client(email = `${randomUUID()}@example.invalid`, createdAt = "2026-01-01T00:00:00Z", id?: string) {
      // Runtime account creation has a column-level grant. Installer-only fixture
      // timestamps/UUIDs arrange precedence and canonical-value witnesses.
      if (id) return String((await owner.query("INSERT INTO public.clients(id,email,created_at) VALUES($1::uuid,$2,$3) RETURNING id", [id, email, createdAt])).rows[0].id);
      const created = String((await runtime.query("INSERT INTO public.clients(email) VALUES($1) RETURNING id", [email])).rows[0].id);
      await owner.query("UPDATE public.clients SET created_at=$2 WHERE id=$1::uuid", [created, createdAt]);
      return created;
    }
    async function promotion() {
      const id = `acquisition-${randomUUID()}`;
      await owner.query("UPDATE public.commerce_promotion_definitions SET active=false");
      await owner.query("INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active) VALUES($1,$2,true)", [id, configured(id)]);
      return id;
    }
    const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
    async function request(id: string, discount = true): Promise<TestRequest> {
      const terms = pricing.selectAcquisitionTerms([configured(id)], new Date().toISOString(), "ZZ", policy)!.terms;
      return { idempotencyKey: `acquisition:${randomUUID()}`, quoteSnapshot: { contractVersion: "commerce.v0", quote: {
        currency: "XXX", taxIncluded: true, lines: [{ sku, productSlug: sku.toLowerCase(), quantity: 1,
          unitPriceGross: money(1000), lineSubtotalGross: money(1000), tax: { included: true, country: "ZZ", category: "standard",
            vatRateBps: 0, legalBasis: "Fictional tax", netAmount: money(1000), vatAmount: money(0), grossAmount: money(1000) } }],
        discounts: discount ? [{ promotionId: id, appliesTo: "order_total", amountOffMinor: 240, reasonCode: "configured" }] : [],
        context: { mode: "subscription", cadenceDays: 28, promoCodes: [], acquisitionCapability: "subscription-acquisition.v1",
          pricingPolicy: { offerPolicyVersion: "commerce.offer-policy.v2", promotionEngineVersion: "promotion-engine.v2" },
          ...(discount ? { acquisitionTerms: terms } : {}) },
        subtotalGross: money(1000), discountTotalGross: money(discount ? 240 : 0), shippingGross: money(0), shippingDiscountGross: money(0),
        totalGross: money(discount ? 760 : 1000), netTotal: money(discount ? 760 : 1000), taxTotal: money(0),
      } } };
    }
    const port = () => checkout.createPostgresAcquisitionCheckoutPersistence(runtime, { regionCode: "ZZ", financialPolicy: policy,
      isAcquisitionDiscount: discount => discount.reasonCode === "configured_acquisition" });
    const eligibility = () => promotions.createPostgresQuoteCustomerEligibility(runtime);
    async function legacyPair() {
      const id = await promotion(), legacyId = `legacy-${randomUUID()}`, legacy = configured(legacyId);
      await owner.query("INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active) VALUES($1,$2,true)", [legacyId, legacy]);
      const financialPolicy: AcquisitionFinancialPolicy<PromotionRow> = {
        ...policy,
        facts: row => ({ ...policy.facts(row), mirrorOf: row.id === id ? legacyId : null }),
        classify: row => ({ ...policy.classify(row), baselineLegacy: row.id === legacyId, target: row.id === id }),
        pairMatches: (baseline, mirror) => baseline.id === legacyId && mirror.id === id
          && baseline.valid_from === mirror.valid_from && baseline.valid_to === mirror.valid_to,
      };
      const selected = pricing.selectAcquisitionTerms([legacy, configured(id)], new Date().toISOString(), "ZZ", financialPolicy);
      if (selected?.kind !== "legacy_pair") throw new Error("Expected configured legacy pair");
      const input = await request(id);
      delete input.quoteSnapshot.quote.context.acquisitionTerms;
      delete input.quoteSnapshot.quote.context.acquisitionCapability;
      delete input.quoteSnapshot.quote.context.pricingPolicy;
      const port = () => checkout.createPostgresAcquisitionCheckoutPersistence(runtime, { regionCode: "ZZ", financialPolicy,
        isAcquisitionDiscount: discount => discount.reasonCode === "configured_acquisition" });
      return { id, legacyId, input, terms: selected.terms, port };
    }
    async function publicTableDigests() {
      const result: Record<string, { rows: number; sha256: string }> = {};
      const tables = (await owner.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
      for (const { tablename } of tables) {
        const name = String(tablename).replaceAll('"', '""');
        const rows = (await owner.query(`SELECT to_jsonb(t) AS value,t.xmin::text AS version FROM public."${name}" t ORDER BY to_jsonb(t)::text,t.xmin::text`)).rows;
        result[String(tablename)] = { rows: rows.length, sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
      }
      return result;
    }
    async function effects() {
      const result: Record<string, unknown> = {};
      for (const table of ["clients", "commerce_orders", "commerce_order_items", "commerce_order_adjustments", "commerce_promotion_claims",
        "commerce_promotion_claim_events", "commerce_order_draft_receipts", "outbox_events", "commerce_settlement_intents", "payment_truth_events"])
        result[table] = (await owner.query(`SELECT to_jsonb(t) AS value,xmin::text AS version FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
      return result;
    }
    return { owner, runtime, runtimeUrl: runtimeUrl.toString(), consumer, sku, product, checkout, promotions, pricing, client, promotion, request, port, eligibility, legacyPair, publicTableDigests, effects, close };
  } catch (error) { await close(); throw error; }
}
