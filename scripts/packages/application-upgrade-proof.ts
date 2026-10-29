/** One installed application upgrade on the cold consumer's existing native database. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedConsumerEnv } from "./pack-manifest-input.ts";

export function proveApplicationUpgradePostgres(
  consumer: string,
  connectionString: string,
  observedSchemaVersion: number,
): void {
  assert(Number.isSafeInteger(observedSchemaVersion) && observedSchemaVersion > 0);
  const app = join(realpathSync(consumer), "versioned-application");
  mkdirSync(app);
  const driver = join(app, "upgrade-proof.mjs");
  // Every import resolves from the real installed consumer, outside the checkout.
  writeFileSync(driver, `
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { applyAppUpgrade, AppUpgradeConflictError } from "@openlup/platform/lifecycle";

const root = await fs.realpath(process.cwd());
const owner = new pg.Client({ connectionString: process.argv[2] });
const schemaVersion = Number(process.argv[3]);
const operator = "b4000000-0000-4000-8000-000000000003";
const runtimeUrl = new URL(process.argv[2]);
runtimeUrl.username = "m14_upgrade_runtime";
runtimeUrl.password = "";
const dependencies = Object.fromEntries(await Promise.all(["@openlup/core","@openlup/platform","pg"].map(async name => [name,JSON.parse(await fs.readFile(join(root,"../node_modules",name,"package.json"),"utf8")).version])));
const entry = version => [
  'import pg from "pg";',
  'import { readFileSync } from "node:fs";',
  'import { createPlatformControlPlanePort } from "@openlup/platform/operations/server";',
  'import { createPostgresGatewayTypeOverrides } from "@openlup/platform/data";',
  'const version = ' + JSON.stringify(version) + ';',
  'const release = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));',
  'if (release.version !== version) throw Error("incomplete_application_upgrade");',
  'const client = new pg.Client({connectionString:process.argv[2],types:createPostgresGatewayTypeOverrides(pg.TypeOverrides)}); await client.connect();',
  'try {',
  '  const login = (await client.query("SELECT current_user AS login, session_user AS session, rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user")).rows[0];',
  '  if (login.login !== "m14_upgrade_runtime" || login.session !== login.login || login.rolsuper || login.rolbypassrls) throw Error("wrong_application_login");',
  '  const port = createPlatformControlPlanePort(client, process.argv[3]);',
  '  if (process.argv[4] === "write") await port.mutateControlPlane({action:"set-control",idempotencyKey:"upgrade-"+version,controlKey:"m14.upgrade.enabled",enabled:version === "1.0.0"});',
  '  const state = await port.readControlPlane({});',
  '  console.log(JSON.stringify({version,login:login.login,controls:state.controls}));',
  '} finally { await client.end(); }',
].join("\\n") + "\\n";
const snapshot = version => ({
  version,
  schema: { min: schemaVersion, max: schemaVersion },
  files: {
    "application/entry.mjs": entry(version),
    "application/package.json": JSON.stringify({ name: "synthetic-control-application", version, private: true, type: "module", scripts:{start:"node entry.mjs"}, dependencies }) + "\\n",
    "theme.css": "original theme\\n",
  },
});
const from = snapshot("1.0.0"), to = snapshot("1.1.0");
const input = { root, from, to, schemaVersion };
const run = mode => JSON.parse(execFileSync(process.execPath, [join(root,"application/entry.mjs"),runtimeUrl.href,operator,mode], {cwd:root,encoding:"utf8",timeout:5000}));
const readControl = result => result.controls.find(control => control.controlKey === "m14.upgrade.enabled");
const fileBytes = async () => Object.fromEntries(await Promise.all(Object.keys(from.files).map(async path => [path, await fs.readFile(join(root,path),"utf8")])));

await owner.connect();
try {
  // Explicit application fixture grants, not a qualified-install role claim.
  await owner.query("CREATE ROLE m14_upgrade_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT");
  await owner.query("GRANT USAGE ON SCHEMA public TO m14_upgrade_runtime; GRANT SELECT ON public.platform_control_operators,public.platform_alerts TO m14_upgrade_runtime; GRANT SELECT,INSERT,UPDATE ON public.platform_operational_controls,public.platform_control_operations,public.platform_job_controls TO m14_upgrade_runtime; GRANT EXECUTE ON FUNCTION public.platform_control_operator_is_active(uuid),public.platform_control_require_operator(uuid),public.platform_control_set_control(uuid,text,text,text,boolean),public.platform_control_list_controls(uuid),public.platform_control_list_jobs(uuid),public.platform_control_list_alerts(uuid) TO m14_upgrade_runtime");
  await owner.query("INSERT INTO public.platform_control_operators(principal_id,active) VALUES($1,true)",[operator]);
  await fs.mkdir(join(root,"application"));
  for (const [path,bytes] of Object.entries(from.files)) await fs.writeFile(join(root,path),bytes);
  await fs.writeFile(join(root,"theme.css"),"adopter theme\\n");
  await fs.writeFile(join(root,"brand.txt"),"adopter brand\\n");

  const first = run("write");
  assert.equal(first.version,from.version);
  assert.equal(readControl(first).enabled,true);
  assert.equal(readControl(first).revision,1);
  // The observed real schema admits both app releases; no schema migration is needed.
  const beforeRangeRefusal = await fileBytes();
  await assert.rejects(applyAppUpgrade({...input,to:{...to,schema:{min:schemaVersion+1,max:schemaVersion+1}}}),AppUpgradeConflictError);
  assert.deepEqual(await fileBytes(),beforeRangeRefusal);
  await fs.writeFile(join(root,"application/entry.mjs"),"adopter managed-file edit\\n");
  const beforeConflict = await fileBytes();
  await assert.rejects(applyAppUpgrade(input),AppUpgradeConflictError);
  assert.deepEqual(await fileBytes(),beforeConflict,"all conflicts precede writes");
  await fs.writeFile(join(root,"application/entry.mjs"),from.files["application/entry.mjs"]);

  const interrupted = 'import { promises as fs } from "node:fs"; import { applyAppUpgrade } from "@openlup/platform/lifecycle"; const rename = fs.rename.bind(fs); fs.rename = async (...args) => { await rename(...args); process.kill(process.pid,"SIGKILL"); await new Promise(()=>{}); }; await applyAppUpgrade(JSON.parse(process.argv[1]));';
  assert.throws(() => execFileSync(process.execPath,["--input-type=module","-e",interrupted,JSON.stringify(input)],{cwd:root,timeout:5000,stdio:["ignore","pipe","pipe"]}),error=>error.signal==="SIGKILL");
  assert.equal(await fs.readFile(join(root,"application/entry.mjs"),"utf8"),to.files["application/entry.mjs"]);
  assert.throws(()=>run("read"),/incomplete_application_upgrade/,"a partial application cannot execute the new release");
  assert.deepEqual((await applyAppUpgrade(input)).applied,["application/package.json"]);
  assert.deepEqual((await applyAppUpgrade(input)).applied,[]);
  const upgraded = run("write");
  assert.equal(upgraded.version,to.version);
  assert.equal(readControl(upgraded).enabled,false);
  assert.equal(readControl(upgraded).revision,2);
  assert.equal(await fs.readFile(join(root,"theme.css"),"utf8"),"adopter theme\\n");
  assert.equal(await fs.readFile(join(root,"brand.txt"),"utf8"),"adopter brand\\n");

  const durable = (await owner.query("SELECT pg_catalog.to_jsonb(t)::pg_catalog.text AS row FROM public.platform_operational_controls t WHERE control_key='m14.upgrade.enabled'")).rows;
  await applyAppUpgrade({root,from:to,to:from,schemaVersion});
  const rolledBack = run("read");
  assert.equal(rolledBack.version,from.version);
  assert.deepEqual(readControl(rolledBack),readControl(upgraded));
  assert.deepEqual((await owner.query("SELECT pg_catalog.to_jsonb(t)::pg_catalog.text AS row FROM public.platform_operational_controls t WHERE control_key='m14.upgrade.enabled'")).rows,durable,"code rollback must not rewind data");
  console.log(JSON.stringify({result:"PASS",from:from.version,to:to.version,observedSchemaVersion:schemaVersion,login:first.login,revision:readControl(upgraded).revision,interruption:"SIGKILL after actual rename",rollback:"compatible code only; durable data unchanged"}));
} finally {
  try {
    // Remove only this proof's fixture, after proving code rollback retains data.
    await owner.query("DELETE FROM public.platform_control_operations WHERE operator_id=$1 AND idempotency_key IN ('upgrade-1.0.0','upgrade-1.1.0')",[operator]);
    await owner.query("DELETE FROM public.platform_operational_controls WHERE control_key='m14.upgrade.enabled' AND updated_by=$1",[operator]);
    await owner.query("DELETE FROM public.platform_control_operators WHERE principal_id=$1",[operator]);
    await owner.query("DROP OWNED BY m14_upgrade_runtime; DROP ROLE m14_upgrade_runtime");
  } finally { await owner.end(); }
}
`);
  try {
    const output = execFileSync(process.execPath, [driver, connectionString, String(observedSchemaVersion)], {
      cwd: app, env: isolatedConsumerEnv(), encoding: "utf8", timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    process.stdout.write(output);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}
