/** Owned catalog configuration and installed-artifact fixture for quote reads. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { canonicalCatalogDraftJson, type NeutralSkuEnvelopeV1 } from "@openlup/platform/catalog";
import { buildDemoSeed } from "../../examples/neutral-store/owned/demo-seed.ts";
import { configurations } from "../../examples/neutral-store/owned/store.config.ts";
import { applyDemoSeed, demonstrationMarker } from "../../examples/neutral-store/installation/install.ts";
import { disposableLabelArgs } from "../../scripts/disposable-docker.mjs";
import { assertConsumerIsolation, platformConsumerInstallArgs } from "../../scripts/packages/platform-cold-consumer.js";
import { closePostgres, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

export const config = structuredClone(configurations.coffee!);
config.id = "quote-catalog-proof";
config.offer.products = Array.from({ length: 501 }, (_, index) => ({
  ...config.offer.products[0]!, sku: `QUOTE-${String(index).padStart(4, "0")}`,
  slug: `row-${index}`, title: `Fixture ${index}`, name: { en: `Fixture ${index}`, pl: `Fixture ${index}` },
  permittedPurchaseModes: index % 3 === 0 ? ["one_time"] : index % 3 === 1 ? ["subscription"] : ["one_time", "subscription"],
}));
config.purchase.stock.quantities = Object.fromEntries(config.offer.products.map(product => [product.sku, 1]));
export const seed = buildDemoSeed(config);
export const digest = (value: unknown) => createHash("sha256").update(canonicalCatalogDraftJson(value)).digest("hex");
export function documentFor(index: number, revisionNo = 1) {
  return { schemaVersion: "fixture.document.v1", id: `fixture:row-${index}:${revisionNo}`,
    productSlug: seed.products[index]!.slug, revisionNo };
}
function gtin(index: number) {
  const digits = String(index + 1).padStart(12, "0");
  const sum = [...digits].reverse().reduce((total, char, position) => total + Number(char) * (position % 2 === 0 ? 3 : 1), 0);
  return digits + String((10 - sum % 10) % 10);
}
export async function createQuoteCatalogFixture() {
  if (!await dockerAvailable()) throw new Error("Quote catalog proof requires real PostgreSQL");
  let container: PostgresContainer | undefined;
  const pools: Pool[] = [];
  const scratch = mkdtempSync(join(tmpdir(), "quote-catalog-packed-"));
  const volume = `m19-st-qb-${process.pid}-data`;
  let volumeCreated = false;
  const npm = (args: string[], cwd: string) => execFileSync("npm", args, { cwd, encoding: "utf8", stdio: "pipe", timeout: 180_000 });
  const close = async () => {
    try { await closePostgres(container, pools); }
    finally {
      try { if (volumeCreated) execFileSync("docker", ["volume", "rm", volume], { stdio: "pipe", timeout: 30_000 }); }
      finally { rmSync(scratch, { recursive: true, force: true }); }
    }
  };
  try {
    // Pack the exact locked peer dependency closure: a cold offline install must
    // never depend on cached registry metadata or a workspace symlink.
    const directories = new Set([resolve("packages/core"), resolve("packages/platform"), resolve("node_modules/zod")]);
    const visit = (directory: string) => {
      if (directories.has(directory)) return;
      directories.add(directory);
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      const local = createRequire(join(directory, "package.json"));
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        const manifestPath = local.resolve.paths(dependency)?.map(base => join(base, dependency, "package.json")).find(existsSync);
        if (!manifestPath) throw new Error(`Missing locked dependency: ${dependency}`);
        visit(dirname(manifestPath));
      }
    };
    visit(resolve("node_modules/pg"));
    visit(resolve("node_modules/@types/pg"));
    const tarballs = [...directories].map(directory => {
      const result = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], directory));
      return join(scratch, result[0].filename);
    });
    const consumer = join(scratch, "consumer"); mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), '{"type":"module","private":true}');
    cpSync(".npmrc", join(consumer, ".npmrc"));
    npm(platformConsumerInstallArgs(tarballs), consumer);
    assertConsumerIsolation(consumer, process.cwd(), false);
    const installedResolve = createRequire(join(consumer, "package.json")).resolve;
    const catalog: typeof import("@openlup/platform/catalog") = await import(pathToFileURL(installedResolve("@openlup/platform/catalog")).href);
    const pricing: typeof import("@openlup/platform/pricing") = await import(pathToFileURL(installedResolve("@openlup/platform/pricing")).href);
    const migrations: typeof import("@openlup/platform/migrations") = await import(pathToFileURL(installedResolve("@openlup/platform/migrations")).href);
    // Both declaration resolution modes exercise the new exported callback.
    writeFileSync(join(consumer, "consumer.ts"), `import {createPostgresCommerceQuoteCatalogReadPort, type PostgresCommerceQuoteCatalogReadOptions} from '@openlup/platform/catalog';
      import type {CommerceQuoteCatalogReadPort} from '@openlup/platform/pricing';
      const options: PostgresCommerceQuoteCatalogReadOptions = {maxItems: 501, verifyDocument: async (document, envelope) => { void document; void envelope.documentRevision.digest; }};
      const port: CommerceQuoteCatalogReadPort = createPostgresCommerceQuoteCatalogReadPort({query: async () => ({rows: []})}, options);
      void port;`);
    for (const mode of ["NodeNext", "Bundler"]) {
      try { execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "--strict", "--noEmit", "--skipLibCheck", "false",
        "--target", "ES2022", "--types", "node", "--module", mode === "Bundler" ? "ESNext" : "NodeNext",
        "--moduleResolution", mode, "consumer.ts", "--typeRoots", join(consumer, "node_modules/@types")], { cwd: consumer, stdio: "pipe", timeout: 60_000 }); }
      catch (error) {
        const output = (error as { stdout?: Buffer }).stdout?.toString() ?? "";
        throw new Error(`Installed ${mode} declarations refused: ${output}`, { cause: error });
      }
    }
    execFileSync("docker", ["volume", "create", ...disposableLabelArgs(), volume], { stdio: "pipe", timeout: 30_000 });
    volumeCreated = true;
    container = await runPostgresContainer({ name: `m19-st-qb-${process.pid}`, database: "quote_catalog", password: "synthetic-conformance",
      runOptions: ["-e", "PGDATA=/var/lib/quote-catalog/pgdata", "--mount", `type=volume,source=${volume},target=/var/lib/quote-catalog`] });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Quote catalog host TCP unavailable");
    const owner = new Pool({ connectionString: container.connectionString }); pools.push(owner);
    for (const role of ["quote_catalog_runtime", "quote_catalog_restore"]) {
      await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'synthetic-quote' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    }
    const selection = { generation: "qualified-v2", roleMode: "installer-managed", migrationLogin: "postgres", bootstrapLogin: "postgres",
      runtimeLogin: "quote_catalog_runtime", restoreLogin: "quote_catalog_restore" } as const;
    const driver: typeof import("pg") = await import(pathToFileURL(installedResolve("pg")).href);
    const PoolCtor = driver.default?.Pool ?? driver.Pool;
    const installUrl = new URL(container.connectionString);
    installUrl.searchParams.set("options", migrations.qualifiedPostgresStartupOptions(selection));
    const installPool = new PoolCtor({ connectionString: installUrl.toString() }); pools.push(installPool);
    const runner = migrations.createPlatformPostgresMigrationRunner({ connectionString: container.connectionString }, {
      installation: selection, poolFactory: () => installPool,
    });
    await runner.apply();
    const status = await runner.status();
    if (status.pending.length) throw new Error("Quote catalog installation incomplete");
    await owner.query(`COMMENT ON DATABASE quote_catalog IS '${demonstrationMarker}'`);
    const installation = await owner.connect();
    try { await applyDemoSeed(config, { connection: installation, installRole: "postgres", runtimeRole: "quote_catalog_runtime", close: async () => {} }); }
    finally { installation.release(); }
    // Only physical/document/identifier provenance is added to the owned seed.
    for (const [index, product] of seed.products.entries()) {
      const document = documentFor(index);
      const revision = (await owner.query(`INSERT INTO public.catalog_product_document_revisions
        (product_id,revision_no,schema_id,document_ref,document_payload,provenance,source_ref,digest)
        VALUES($1,1,$2,$3,$4,'{}',$5,$6) RETURNING id`,
      [product.id, document.schemaVersion, document.id, document, `fixture:source-${index}`, digest(document)])).rows[0]!.id;
      await owner.query("UPDATE public.catalog_products SET primary_sku_id=$2,current_document_revision_id=$3 WHERE id=$1", [product.id, seed.skus[index]!.id, revision]);
      await owner.query("UPDATE public.catalog_skus SET net_weight_g=$2 WHERE id=$1", [seed.skus[index]!.id, index + 1]);
      await owner.query(`INSERT INTO public.catalog_sku_identifiers(catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity,is_primary)
        VALUES($1,'fixture','gtin',$2,'unit',1,true)`, [seed.skus[index]!.id, gtin(index)]);
    }
    const runtimeUrl = new URL(container.connectionString);
    runtimeUrl.username = "quote_catalog_runtime"; runtimeUrl.password = "synthetic-quote";
    const runtime = new Pool({ connectionString: runtimeUrl.toString() }); pools.push(runtime);
    const executor = { async query(sql: string, values?: unknown[]) {
      const connection = await runtime.connect();
      try { await connection.query("BEGIN READ ONLY"); await connection.query("SET LOCAL ROLE service_role");
        const result = await connection.query(sql, values); await connection.query("COMMIT"); return result;
      } catch (error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); }
    } };
    const verifyDocument = async (input: unknown, envelope: NeutralSkuEnvelopeV1) => {
      const document = input as ReturnType<typeof documentFor> | null;
      if (!document || document.schemaVersion !== "fixture.document.v1" || document.schemaVersion !== envelope.documentRevision.schemaId
        || document.id !== envelope.documentRevision.documentRef || document.productSlug !== envelope.product.slug
        || document.revisionNo !== envelope.documentRevision.revisionNo) {
        throw new pricing.CommerceQuoteCatalogReadError("catalog_document_schema_invalid");
      }
      if (digest(document) !== envelope.documentRevision.digest) throw new pricing.CommerceQuoteCatalogReadError("catalog_document_digest_mismatch");
    };
    return { owner, runtime, executor, catalog, pricing, verifyDocument, close, consumer, installedResolve };
  } catch (error) { await close(); throw error; }
}
