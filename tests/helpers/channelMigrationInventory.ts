import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import { qualifiedPostgresCatalogPayload,qualifiedPostgresStartupOptions,qualifiedAdminPostgresCatalogPayload,qualifiedAdminPostgresStartupOptions,type QualifiedPostgresInstallation,type QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { selectPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { closePostgres,runPostgresContainer,waitForPostgresTcpReady } from "./postgresContainer.js";
export const channelInventoryModes=["legacy","qualified-bootstrap","qualified-separate","admin-managed","admin-operator"] as const;
export type ChannelInventoryMode=typeof channelInventoryModes[number];
export async function channelMigrationInventory(mode:ChannelInventoryMode,measureOnly=false) {
  const container=await runPostgresContainer({name:`m17-inventory-${mode}-${process.pid}`,password:"synthetic-channel-proof"});
  const pools:Pool[]=[];
  const pool=(url:string)=>{const p=new Pool({connectionString:url,max:1});pools.push(p);return p;};
  try {
    if(!await waitForPostgresTcpReady(container.connectionString))throw new Error("channel inventory PostgreSQL unavailable");
    const bootstrap=pool(container.connectionString);
    const url=(name:string)=>{const u=new URL(container.connectionString);u.username=name;return u.toString();};
    const ident=(name:string)=>{if(!/^[a-z_]+$/u.test(name))throw new Error("invalid fixture role");return `"${name}"`;};
    let selection:QualifiedPostgresInstallation|QualifiedAdminPostgresInstallation|undefined;
    if(mode!=="legacy") {
      const admin=mode.startsWith("admin"),operator=mode==="admin-operator",separate=mode==="qualified-separate";
      for(const role of ["channel_runtime","channel_restore"])await bootstrap.query(`CREATE ROLE ${ident(role)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-channel-proof'`);
      const migration=admin||separate?"channel_migration":"postgres";
      if(migration!=="postgres") {
        await bootstrap.query(`CREATE ROLE channel_migration LOGIN ${separate?"INHERIT SUPERUSER NOCREATEROLE":"NOINHERIT NOSUPERUSER "+(operator?"NOCREATEROLE":"CREATEROLE")} NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-channel-proof'`);
        await bootstrap.query("ALTER DATABASE postgres OWNER TO channel_migration");
      }
      const principals={migrationLogin:migration,bootstrapLogin:"postgres",runtimeLogin:"channel_runtime",restoreLogin:"channel_restore"};
      selection=admin?(operator
        ?{generation:"qualified-admin",roleMode:"operator-provisioned",operatorLogin:"channel_operator",...principals}
        :{generation:"qualified-admin",roleMode:"installer-managed",...principals})
        :{generation:"qualified-v2",roleMode:"installer-managed",...principals};
      if(operator) {
        await bootstrap.query("CREATE ROLE channel_operator LOGIN NOINHERIT CREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-channel-proof'");
        const op=pool(url("channel_operator"));
        for(const group of ["anon","authenticated","service_role","platform_acquisition_owner","platform_acquisition_runtime","openlup_retained_import_owner"]) {
          await bootstrap.query(`CREATE ROLE ${ident(group)} NOLOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS; GRANT ${ident(group)} TO channel_operator WITH ADMIN TRUE,INHERIT FALSE,SET FALSE`);
          await op.query(`GRANT ${ident(group)} TO channel_migration WITH ADMIN TRUE,INHERIT FALSE,SET FALSE GRANTED BY channel_operator`);
          if(["anon","authenticated","service_role","platform_acquisition_runtime"].includes(group))await op.query(`GRANT ${ident(group)} TO channel_runtime WITH ADMIN FALSE,INHERIT ${group==="service_role"?"TRUE":"FALSE"},SET TRUE GRANTED BY channel_operator`);
        }
      }
    }
    const connectionString=url(selection?.migrationLogin??"postgres");
    const configured=new URL(connectionString);
    if(selection)configured.searchParams.set("options",selection.generation==="qualified-v2"?qualifiedPostgresStartupOptions(selection):qualifiedAdminPostgresStartupOptions(selection));
    const migration=pool(configured.toString());
    const runner=createPostgresMigrationRunner({connectionString},{installation:selection??{generation:"legacy"},poolFactory:()=>migration});
    let mismatch=false;
    try{await runner.apply();}catch(error){if(measureOnly&&String(error).includes("object inventory SHA-256 mismatch"))mismatch=true;else throw error;}
    const client=await migration.connect(),lock="openlup:public-platform-migrations:v1";
    let payload:string;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))",[lock]);
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY; LOCK TABLE ONLY public.platform_schema_migrations IN ACCESS SHARE MODE");
      payload=selection?await(selection.generation==="qualified-v2"?qualifiedPostgresCatalogPayload(client,selection,lock):qualifiedAdminPostgresCatalogPayload(client,selection,lock))
        :selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client));
    }finally{await client.query("ROLLBACK");await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[lock]);client.release();}
    const sha256=createHash("sha256").update(payload).digest("hex");
    const raw=JSON.parse(readFileSync("config/platform-migration-manifest.json","utf8"))as PlatformMigrationManifest;
    const selected=selection?selectPlatformMigrationManifest(raw,selection.generation,selection.generation==="qualified-v2"?{migrationIsBootstrap:selection.migrationLogin===selection.bootstrapLogin,hasRestore:true}:{roleMode:selection.roleMode}):selectPlatformMigrationManifest(raw,"legacy");
    const count=(await migration.query("SELECT count(*)::int n FROM public.platform_schema_migrations")).rows[0].n;
    if(!measureOnly) {
      if(sha256!==selected.objectInventorySha256)throw new Error("channel migration inventory mismatch");
      if(count!==1+selected.forward.length)throw new Error("channel migration ledger incomplete");
      if((await runner.apply()).applied.length)throw new Error("channel migration replay applied more units");
      if(selection) {
        const runtime=pool(url(selection.runtimeLogin));
        if((await runtime.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0].rolsuper)throw new Error("runtime is superuser");
        for(const sql of ["SELECT public.channel_purchase_scope(NULL,NULL,NULL,false,NULL)","SELECT public.channel_purchase_packet(NULL,NULL,NULL)","CREATE TABLE public.forbidden_channel_ddl(id integer)"]) {
          try{await runtime.query(sql);throw new Error("runtime forbidden action passed");}catch(error){if((error as{code?:string}).code!=="42501")throw error;}
        }
        const {channelPurchaseFixture}=await import("./channelPurchaseFixture.js");
        const {createPostgresChannelPurchasedSourceStore,canonicalChannelSource}=await import("@openlup/platform/channels/server");
        const owner=await migration.connect();
        let fixture:Awaited<ReturnType<typeof channelPurchaseFixture>>;
        try{await owner.query("BEGIN");fixture=await channelPurchaseFixture(owner,"portable");await owner.query("COMMIT");}catch(error){await owner.query("ROLLBACK");throw error;}finally{owner.release();}
        const source=createPostgresChannelPurchasedSourceStore({actorId:fixture.actor,executor:{query:(sql,args)=>runtime.query(sql,[...args])}});
        await source.recordPage(fixture.page);await source.recordCapture(fixture.capture);
        const read=await source.readCapture({channelId:fixture.capture.scope.channelId,providerEventId:fixture.capture.providerEventId,actorId:fixture.actor});
        if(!read||canonicalChannelSource(read.capture)!==canonicalChannelSource(fixture.capture))throw new Error("qualified runtime capture read differs");
        if((await source.commitPage(fixture.page)).outcome!=="applied"||(await source.commitPage(fixture.page)).outcome!=="replayed")throw new Error("qualified runtime CAS failed");
        try{await source.originalConversion({ledgerId:read.ledgerId,externalLineRef:"line:19",jobRunId:fixture.job,canonicalText:null});throw new Error("portable physical conversion passed");}
        catch(error){if(!(error instanceof Error)||error.message!=="channel_purchase_physical_unavailable")throw error;}

      }
    }
    return{mode,sha256,count,expected:selected.objectInventorySha256,measuredAfterExpectedMismatch:mismatch};
  }finally{await closePostgres(container,pools);}
}
