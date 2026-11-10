import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { createPostgresMigrationRunner } from '../../server/adapters/postgres/migrationRunner.js';
import { qualifiedPostgresStartupOptions, qualifiedAdminPostgresStartupOptions, type QualifiedPostgresInstallation, type QualifiedAdminPostgresInstallation } from '../../server/adapters/postgres/qualifiedInstall.js';
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady } from '../helpers/postgresContainer.js';
const ownForward='db/platform/migrations/20261110170000_checkout_recovery_inspection.sql';
it.each(['legacy','bootstrap','separate','admin-managed','admin-operator'] as const)('upgrades existing unlinked history and replays inspection on %s',async profile=>{
  const container = await runPostgresContainer({ name: `recovery-inspection-upgrade-${profile}-${process.pid}`, password: "synthetic-conformance" });
  const pools: Pool[] = [];
  const pool = (url: string, options?: string) => { const value = new Pool({ connectionString: url, options }); pools.push(value); return value; };
  try {
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Recovery inspection upgrade PostgreSQL unavailable");
    const owner = pool(container.connectionString), password = randomUUID();
    const m = "exact_m", r = "exact_r", s = "exact_s", o = "exact_o";
    const admin = profile.startsWith("admin-"), separate = profile === "separate" || admin;
    const operatorMode = profile === "admin-operator";
    const login = (name: string) => { const url = new URL(container.connectionString); url.username = name; if (name !== "postgres") url.password = password; return url.toString(); };
    if (separate) {
      await owner.query(`CREATE ROLE ${m} LOGIN ${admin ? "NOINHERIT NOSUPERUSER" : "INHERIT SUPERUSER"} ${admin && !operatorMode ? "CREATEROLE" : "NOCREATEROLE"} NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      await owner.query(`ALTER DATABASE postgres OWNER TO ${m}`);
    }
    if (profile !== "legacy") {
      for (const name of [r, s]) await owner.query(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    }
    if (operatorMode) {
      await owner.query(`CREATE ROLE ${o} LOGIN NOINHERIT NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      const operator = pool(login(o));
      for (const group of ["anon", "authenticated", "service_role", "platform_acquisition_owner", "platform_acquisition_runtime", "openlup_retained_import_owner"]) {
        await owner.query(`CREATE ROLE ${group} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS`);
        await owner.query(`GRANT ${group} TO ${o} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
        await operator.query(`GRANT ${group} TO ${m} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY ${o}`);
        if (["anon", "authenticated", "service_role", "platform_acquisition_runtime"].includes(group)) await operator.query(`GRANT ${group} TO ${r} WITH ADMIN FALSE, INHERIT ${group === "service_role" ? "TRUE" : "FALSE"}, SET TRUE GRANTED BY ${o}`);
      }
    }
    const installation: { generation: "legacy" } | QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation = profile === "legacy" ? { generation: "legacy" }
      : admin ? operatorMode
        ? { generation: "qualified-admin", roleMode: "operator-provisioned", bootstrapLogin: "postgres", migrationLogin: m, runtimeLogin: r, restoreLogin: s, operatorLogin: o }
        : { generation: "qualified-admin", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: m, runtimeLogin: r, restoreLogin: s }
      : { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: separate ? m : "postgres", runtimeLogin: r, restoreLogin: s };
    const migrationUrl = login(installation.generation === "legacy" ? "postgres" : installation.migrationLogin);
    const migrator = pool(migrationUrl, installation.generation === "qualified-v2" ? qualifiedPostgresStartupOptions(installation) : installation.generation === "qualified-admin" ? qualifiedAdminPostgresStartupOptions(installation) : undefined);
    const prefix=JSON.parse(readFileSync('config/platform-migration-manifest.json','utf8'));
    const introductionTail='db/platform/migrations/20261110115000_customer_checkout_links.sql';
    for(const plan of[prefix,prefix.qualified,prefix.qualifiedAdmin]){
      const end=plan.forward.findIndex((unit:{file:string})=>unit.file===introductionTail);
      const own=plan.forward.find((unit:{file:string})=>unit.file===ownForward);
      if(end<0||!own)throw new Error('frozen inspection introduction prefix missing');
      plan.forward=[...plan.forward.slice(0,end+1),own];
    }
    const root=resolve('.context/scratch/c32a/history-'+profile);
    const oldInventories={"legacy": "ec9aef09204a3ecbd524694ed6d849b910f164c23549b80bb55e9ed83f9e3570", "qualified": {"bootstrapMigrator": {"withRestore": "2d21bacb9a13484bb3765a098e16b38cf8f68d5214744e8a1460d74baefec30a"}, "separateMigrator": {"withRestore": "ef6d3bf861b092092c1c5d60d492ef324100d6f3a8d73b92f194c29e0ba6a66f"}}, "admin": {"installerManaged": "bd3529be129c914159f4d8ea734753fe713bdb9c820e0f5e0dc595a60777762a", "operatorProvisioned": "dd688244f730d5bf9d4d8827aaa4d67155c6dc160178f96ac76263eef613c432"}};
    prefix.objectInventorySha256=oldInventories.legacy;
    prefix.qualified.objectInventorySha256=oldInventories.qualified;
    prefix.qualifiedAdmin.objectInventorySha256=oldInventories.admin;
    // These are frozen before/after inventories of this forward, independent of later suffixes.
    const complete=structuredClone(prefix),newInventories={"legacy": "76c4e9e1767f7725cc9860a78eae487be80f8b42006306399b10243af0e37b93", "qualified": {"bootstrapMigrator": {"withRestore": "7488a95c177c95a364d742b6a587bb635e85446178292cae24efd74e0a04bd71"}, "separateMigrator": {"withRestore": "c0c04060925f0cef782a3d35ff0c86c2bc8743fe131bd09ef1aa844016193e45"}}, "admin": {"installerManaged": "65a768ef87d9ec91401a0186c9461acbbc4986bab977adfa11539d26424bd911", "operatorProvisioned": "9e82cc184558e078315a43c6f3537c0d005db3042d26e464e5a7dd3e3a68566f"}};
    complete.objectInventorySha256=newInventories.legacy;complete.qualified.objectInventorySha256=newInventories.qualified;complete.qualifiedAdmin.objectInventorySha256=newInventories.admin;
    for(const plan of[complete,complete.qualified,complete.qualifiedAdmin]){const end=plan.forward.findIndex((unit:{file:string})=>unit.file===ownForward);if(end<0)throw new Error('inspection forward missing');plan.forward=plan.forward.slice(0,end+1);}
    for(const plan of[prefix,prefix.qualified,prefix.qualifiedAdmin]){
      const end=plan.forward.findIndex((unit:{file:string})=>unit.file===ownForward);plan.forward=plan.forward.slice(0,end);
      for(const unit of[plan.baseline,...plan.forward]){const target=resolve(root,unit.file);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(unit.file));}
    }
    mkdirSync(resolve(root,'config'),{recursive:true});writeFileSync(resolve(root,'config/platform-migration-manifest.json'),JSON.stringify(prefix));
    const completeRoot=root+'-complete';
    for(const plan of[complete,complete.qualified,complete.qualifiedAdmin])for(const unit of[plan.baseline,...plan.forward]){const target=resolve(completeRoot,unit.file);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(unit.file));}
    mkdirSync(resolve(completeRoot,'config'),{recursive:true});writeFileSync(resolve(completeRoot,'config/platform-migration-manifest.json'),JSON.stringify(complete));
    const runner=(sourceRoot=completeRoot)=>createPostgresMigrationRunner({connectionString:migrationUrl},{root:sourceRoot,installation,poolFactory:()=>migrator});
    await runner(root).apply();
    const client=randomUUID(),order=randomUUID();
    await owner.query('INSERT INTO public.clients(id,email)VALUES($1,$2)',[client,`${client}@example.invalid`]);
    await owner.query("INSERT INTO public.commerce_orders(id,client_id,total_amount_minor,currency_code,created_at)VALUES($1,$2,0,'XXX','2040-01-01T12:00:00Z')",[order,client]);
    const before=(await owner.query('SELECT to_jsonb(o) AS value FROM public.commerce_orders o WHERE id=$1',[order])).rows[0].value;
    const result=await runner().apply();expect(result.applied).toEqual([ownForward]);
    const after=(await owner.query('SELECT to_jsonb(o) AS value FROM public.commerce_orders o WHERE id=$1',[order])).rows[0].value;
    expect(after).toEqual({...before,recovery_root_order_id:null,recreated_from_order_id:null});
    expect((await runner().apply()).applied).toEqual([]);
  }finally{await closePostgres(container,pools);}
},30_000);
