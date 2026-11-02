import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { env as processEnvironment } from "node:process";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

it("uses installed bundle writes on qualified-v2 through the restricted runtime login, including refusal and replay", async () => {
  const root = process.cwd();
  mkdirSync(".context/scratch/g14x", { recursive: true });
  const scratch = mkdtempSync(resolve(".context/scratch/g14x/installed-"));
  const consumer = join(scratch, "consumer"); mkdirSync(consumer);
  const environment = { ...processEnvironment }; delete environment.NODE_PATH; delete environment.NODE_OPTIONS;
  const command = (name: string, args: string[], cwd = root) => execFileSync(name, args, { cwd, env: environment, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const packs = ["core", "outbox", "platform"].map(name => {
    const [packed] = JSON.parse(command("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], join(root, "packages", name)));
    return join(scratch, packed.filename);
  });
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  command("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", ...packs, "pg@8.22.0", "@types/pg@8.20.0", "@types/node@24.13.3"], consumer);
  for (const name of ["core", "outbox", "platform"]) expect(realpathSync(join(consumer, "node_modules/@openlup", name))).toBe(join(consumer, "node_modules/@openlup", name));
  writeFileSync(join(consumer, "consumer.ts"), `
import { createPostgresBundleAdminWriteStore, createBundleAdminWriteStore, BundleRpcError, DomainRpcError, BUNDLE_WRITE_ROUTINES, BUNDLE_RELATION, type BundleWriteRoutineClient, type PostgresBundleAdminWriteStore } from '@openlup/platform/catalog';
import type { AgentReason } from '@openlup/platform/catalog/contracts';
const store: PostgresBundleAdminWriteStore = createPostgresBundleAdminWriteStore({connectionString:'synthetic'});
declare const client: BundleWriteRoutineClient;
const bound = createBundleAdminWriteStore(client);
const error: DomainRpcError = new BundleRpcError('42501','actor_required');
const reason: AgentReason = 'actor_required';
void [store.close, bound.cloneDraft, error.sqlstate, reason, BUNDLE_RELATION, BUNDLE_WRITE_ROUTINES];
`);
  for (const mode of ["NodeNext", "Bundler"]) {
    const configuration = join(consumer, `${mode}.json`);
    writeFileSync(configuration, JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: mode === "NodeNext" ? "NodeNext" : "ESNext", moduleResolution: mode, types: ["node"], typeRoots: [join(consumer, "node_modules/@types")] }, files: ["consumer.ts"] }));
    command(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", configuration], consumer);
  }
  let container: PostgresContainer | undefined;
  const pools: Pool[] = [];
  try {
    if (!await dockerAvailable()) throw new Error("Installed bundle write proof requires real PostgreSQL");
    container = await runPostgresContainer({ name: `m19-bundle-export-${process.pid}`, password: "synthetic-bundle-proof" });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Bundle proof PostgreSQL unavailable");
    const selection: QualifiedPostgresInstallation = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: "postgres", runtimeLogin: "bundle_runtime", restoreLogin: "bundle_restore" };
    const setup = new Pool({ connectionString: container.connectionString }); pools.push(setup);
    await setup.query("CREATE ROLE bundle_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-bundle-proof'; CREATE ROLE bundle_restore LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-bundle-proof'");
    const url = new URL(container.connectionString); url.searchParams.set("options", qualifiedPostgresStartupOptions(selection));
    const owner = new Pool({ connectionString: url.toString() }); pools.push(owner);
    const runner = createPostgresMigrationRunner({ connectionString: container.connectionString }, { installation: selection, poolFactory: () => owner });
    const selected = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "qualified-v2", { migrationIsBootstrap: true, hasRestore: true });
    expect((await runner.apply()).applied).toEqual([selected.baseline, ...selected.forward].map(unit => unit.file));
    expect((await runner.status()).pending).toEqual([]);
    const product = (await owner.query("INSERT INTO public.catalog_products(slug,name) VALUES ('bundle-proof','Synthetic units') RETURNING id")).rows[0].id;
    await owner.query("INSERT INTO public.catalog_skus(product_id,sku,title,sellable_standalone) VALUES ($1,'UNIT-A','Synthetic unit',true)", [product]);
    const list = (await owner.query("INSERT INTO public.price_lists(name,region_code,currency) VALUES ('Synthetic list','ZZ','XXX') RETURNING id")).rows[0].id;
    await owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor) SELECT $1,id,1000 FROM public.catalog_skus WHERE sku='UNIT-A'", [list]);
    const runtimeUrl = new URL(container.connectionString); runtimeUrl.username = selection.runtimeLogin;
    writeFileSync(join(consumer, "connection.json"), JSON.stringify(runtimeUrl.toString()));
    const script = join(consumer, "proof.mjs");
    writeFileSync(script, `
import assert from 'node:assert/strict';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createPostgresBundleAdminWriteStore, BundleRpcError, DomainRpcError } from '@openlup/platform/catalog';
const url=JSON.parse(readFileSync(new URL('./connection.json',import.meta.url),'utf8')), actor='c5000000-0000-4000-8000-000000000001';
const db=new pg.Pool({connectionString:url});
const store=createPostgresBundleAdminWriteStore({connectionString:url});
const envelope={mode:'commit'};
try {
 const identity=(await db.query('SELECT current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
 assert.deepEqual(identity,{current_user:'bundle_runtime',session_user:'bundle_runtime',rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false});
 await assert.rejects(db.query('UPDATE public.platform_schema_migrations SET sha256=sha256 WHERE false'),e=>e.code==='42501');
 const originalConstraint={kind:'synthetic.constraint',version:1,data:{slots:['UNIT-A'],note:'quote: "; unicode: ☕'}};
 const originalMetadata={nested:{enabled:true,values:[1,null,'UNIT-A']},literal:'{"keep":"as text"}'};
 const draft={...envelope,idempotencyKey:'export-create',bundle:{code:'EXPORT-SET',title:'Synthetic set',fulfillmentMode:'virtual',compositionConstraint:originalConstraint,metadata:originalMetadata}};
 assert.equal((await store.upsertDraft(actor,draft)).idempotent,false);
 assert.equal((await store.upsertDraft(actor,draft)).idempotent,true);
 const jsonFields=async code=>(await db.query('SELECT composition_constraint,metadata FROM public.catalog_bundles WHERE code=$1',[code])).rows[0];
 assert.deepEqual(await jsonFields('EXPORT-SET'),{composition_constraint:originalConstraint,metadata:originalMetadata});
 const constraint={kind:'synthetic.constraint',version:2,data:{slots:['UNIT-A'],nested:{enabled:false}}};
 const metadata={nested:{enabled:false,values:[null,2,'quoted " text']},literal:'[true,null]'};
 assert.equal((await store.updateDraft(actor,{...envelope,code:'EXPORT-SET',updates:{title:'Updated set',compositionConstraint:constraint,metadata}})).idempotent,false);
 assert.deepEqual(await store.loadCompositionConstraint('EXPORT-SET'),constraint);
 assert.deepEqual(await jsonFields('EXPORT-SET'),{composition_constraint:constraint,metadata});
 // Omitted JSON arguments remain SQL NULL: update retains prior JSON and create uses SQL defaults.
 await store.updateDraft(actor,{...envelope,code:'EXPORT-SET',updates:{title:'Updated set'}});
 assert.deepEqual(await jsonFields('EXPORT-SET'),{composition_constraint:constraint,metadata});
 await store.upsertDraft(actor,{...envelope,bundle:{code:'EXPORT-DEFAULTS',title:'Default JSON',fulfillmentMode:'virtual'}});
 assert.deepEqual(await jsonFields('EXPORT-DEFAULTS'),{composition_constraint:{},metadata:{}});
 assert.equal(await store.loadCompositionConstraint('EXPORT-DEFAULTS'),null);
 await assert.rejects(store.loadCompositionConstraint('ABSENT'),e=>e instanceof BundleRpcError && e instanceof DomainRpcError && e.sqlstate==='P0002');
 const components=[{sku:'UNIT-A',quantity:2,isAddon:false,sortOrder:0}];
 assert.equal((await store.setComposition(actor,{...envelope,code:'EXPORT-SET',components,idempotencyKey:'export-compose'})).componentCount,1);
 assert.equal((await store.setComposition(actor,{...envelope,code:'EXPORT-SET',components,idempotencyKey:'export-compose'})).idempotent,true);
 await assert.rejects(store.setComposition(actor,{...envelope,code:'EXPORT-SET',components:[]}),e=>e instanceof BundleRpcError && e.sqlstate==='P0001' && e.pgMessage==='min_components');
 const price={mode:'one_time',targetPriceMinor:1800,currency:'XXX',amountKind:'gross'};
 assert.equal((await store.setTargetPrice(actor,{...envelope,code:'EXPORT-SET',price})).idempotent,false);
 assert.equal((await store.cloneDraft(actor,{...envelope,sourceCode:'EXPORT-SET',code:'EXPORT-CLONE',title:'Cloned set'})).idempotent,false);
 assert.deepEqual(await jsonFields('EXPORT-CLONE'),{composition_constraint:constraint,metadata});
 await assert.rejects(store.activate(actor,{...envelope,code:'EXPORT-CLONE'}),e=>e instanceof BundleRpcError && e.sqlstate==='P0001');
 await store.setTargetPrice(actor,{...envelope,code:'EXPORT-CLONE',price});
 for(const method of ['activate','deactivate','archive','restore']){
  const input={...envelope,code:'EXPORT-CLONE',idempotencyKey:'export-'+method};
  assert.equal((await store[method](actor,input)).idempotent,false);
  assert.equal((await store[method](actor,input)).idempotent,true);
 }
 assert.equal((await store.updateDraft(actor,{mode:'dry_run',code:'EXPORT-SET',updates:{title:'Should not persist'}})).dryRun,true);
 await assert.rejects(store.archive(null,{...envelope,code:'EXPORT-SET'}),e=>e instanceof BundleRpcError && e.sqlstate==='42501');
 console.log('installed bundle writes PASS: qualified-v2 restricted runtime; nine mutations, refusal, rollback and replay');
} finally {await store.close();await db.end();}
`);
    const result = command(process.execPath, [script], consumer);
    expect(result).toContain("installed bundle writes PASS");
    expect((await owner.query("SELECT title FROM public.catalog_bundles WHERE code='EXPORT-SET'")).rows).toEqual([{ title: "Updated set" }]);
    expect((await owner.query("SELECT count(*)::int AS count FROM public.catalog_bundle_components c JOIN public.catalog_bundles b ON b.id=c.bundle_id WHERE b.code='EXPORT-SET'")).rows).toEqual([{ count: 1 }]);
    expect((await owner.query("SELECT idempotency_key,count(*)::int AS count FROM public.catalog_bundle_write_events WHERE idempotency_key IS NOT NULL GROUP BY idempotency_key ORDER BY idempotency_key")).rows).toEqual(["export-activate", "export-archive", "export-compose", "export-create", "export-deactivate", "export-restore"].map(idempotency_key => ({ idempotency_key, count: 1 })));
    console.info(result.trim());
  } finally { await closePostgres(container, pools); }
}, postgresSetupTimeoutMs);
