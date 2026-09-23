#!/usr/bin/env node
// Disposable local managed-Supabase setup for the subscription reference profile.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const inputs = process.argv.slice(2);
function option(name) {
  const at = inputs.indexOf(name);
  if (at < 0 || !inputs[at + 1] || inputs[at + 1].startsWith("--")) throw new Error(`Required: ${name} VALUE`);
  return inputs[at + 1];
}
function fail(message) { throw new Error(message); }
const directoryArg = option("--dir");
const projectId = option("--project-id");
const portBase = Number(option("--port-base"));
if (inputs.length !== 6 || !isAbsolute(directoryArg)) fail("Use an absolute --dir and the three required options");
if (!/^openlup-reference-[a-z0-9][a-z0-9-]{3,40}$/.test(projectId)) fail("Use a unique openlup-reference-* project id");
if (!Number.isSafeInteger(portBase) || portBase < 1024 || portBase > 65520) fail("Invalid local port base");
const directory = resolve(directoryArg);
if (directory === root || directory.startsWith(`${root}${sep}`) || root.startsWith(`${directory}${sep}`)) fail("Setup must be outside the source checkout");
const ports = { shadow: portBase, api: portBase + 1, db: portBase + 2, studio: portBase + 3, mail: portBase + 4, pooler: portBase + 9, app: portBase + 10 };
const markerPath = join(directory, "subscription-owner.json");
const configPath = join(directory, "supabase/config.toml");
const baseline = join(root, "supabase/migrations/00000000000000_platform_schema_baseline.sql");
const prereqs = join(root, "scripts/public-reference/subscription-prereqs.sql");
const seed = join(root, "scripts/public-reference/subscription-seed.sql");
const instanceKey = "public_reference_subscription_instance";
const template = readFileSync(join(root, "config/public-reference-subscription-supabase.toml"), "utf8");
const replacements = {
  PROJECT_ID: projectId, SHADOW_PORT: ports.shadow, API_PORT: ports.api, DB_PORT: ports.db,
  STUDIO_PORT: ports.studio, MAIL_PORT: ports.mail, POOLER_PORT: ports.pooler, APP_PORT: ports.app,
};
const config = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
  if (!(key in replacements)) fail(`Unknown config placeholder: ${key}`);
  return String(replacements[key]);
});
if (config.includes("{{")) fail("Unrendered config placeholder");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const identity = { version: 2, projectId, portBase, baselineSha256: digest(readFileSync(baseline)), configSha256: digest(config) };
const logPath = join(directory, "subscription-setup.log");
function log(value) { writeFileSync(logPath, value, { flag: "a", mode: 0o600 }); }
function run(binary, args, options = {}) {
  const { record = true, ...childOptions } = options;
  const result = spawnSync(binary, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...childOptions });
  if (record) log(`\n$ ${binary} ${args.filter((arg) => !arg.startsWith("PGPASSWORD=")).join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (result.error || result.status !== 0) fail(`${binary} failed; inspect ${logPath}`);
  return result.stdout ?? "";
}
function dockerNames(all = false) {
  return run("docker", ["ps", ...(all ? ["-a"] : []), "--format", "{{.Names}}"], { record: false }).trim().split("\n");
}
async function freePort(port) {
  await new Promise((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => server.close(done));
  }).catch(() => fail(`Port ${port} is occupied; choose another --port-base`));
}
function sql(password, source, args = []) {
  return run("docker", ["exec", "-e", `PGPASSWORD=${password}`, "-i", `supabase_db_${projectId}`,
    "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", "postgres", ...args],
  { input: source });
}
function containerId() {
  return run("docker", ["inspect", `supabase_db_${projectId}`, "--format", "{{.Id}}"], { record: false }).trim();
}
function writeMarker(marker) {
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
}
function liveInstance(password) {
  return sql(password, "", ["-Atqc", `SELECT value_text FROM public.commerce_settings WHERE key = '${instanceKey}'`]).trim();
}
function shellQuote(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }

try {
  const existing = existsSync(markerPath);
  let marker;
  if (existing) {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (Object.entries(identity).some(([key, value]) => marker[key] !== value)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[48][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(marker.instanceId)
      || !["new", "bound", "sealed"].includes(marker.phase)
      || readFileSync(configPath, "utf8") !== config) fail("Owned setup identity/config changed; refusing reuse");
    if (marker.phase === "new" && dockerNames(true).some((name) => name.endsWith(`_${projectId}`))) {
      fail("Unsealed setup has an unbound container; refusing reuse");
    }
    if (marker.phase === "bound" && (!/^[0-9a-f]{64}$/.test(marker.boundContainerId)
      || !dockerNames(true).includes(`supabase_db_${projectId}`)
      || containerId() !== marker.boundContainerId)) fail("Unsealed setup container changed; refusing reuse");
  } else {
    if (existsSync(directory) && readdirSync(directory).length) fail("Setup directory is nonempty and unowned");
    if (dockerNames(true).some((name) => name.endsWith(`_${projectId}`))) fail("Project containers already exist without this setup's ownership marker");
    for (const port of Object.values(ports)) await freePort(port);
    mkdirSync(join(directory, "supabase"), { recursive: true, mode: 0o700 });
    writeFileSync(configPath, config, { mode: 0o600, flag: "wx" });
    marker = { ...identity, instanceId: randomUUID(), phase: "new", boundContainerId: null };
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }
  const container = `supabase_db_${projectId}`;
  if (!dockerNames().includes(container)) run("supabase", ["start", "--workdir", directory,
    "-x", "realtime,storage-api,imgproxy,studio,postgres-meta,edge-runtime,logflare,vector,supavisor"]);
  if (marker.phase === "new") {
    marker = { ...marker, phase: "bound", boundContainerId: containerId() };
    if (!/^[0-9a-f]{64}$/.test(marker.boundContainerId)) fail("Owned container identity unavailable");
    writeMarker(marker); // Bind before the first database write.
  } else if (marker.phase === "bound" && containerId() !== marker.boundContainerId) {
    fail("Unsealed setup container changed; refusing database writes");
  }
  const generated = run("supabase", ["status", "--workdir", directory, "-o", "env"], { record: false });
  const values = parseEnv(generated);
  if (!values.API_URL || !values.ANON_KEY || !values.SERVICE_ROLE_KEY || values.API_URL !== `http://127.0.0.1:${ports.api}`) fail("Owned CLI keys or API URL unavailable");
  const dockerEnv = run("docker", ["inspect", container, "--format", "{{range .Config.Env}}{{println .}}{{end}}"], { record: false });
  const password = dockerEnv.match(/^POSTGRES_PASSWORD=(.+)$/m)?.[1];
  if (!password) fail("Owned local database credential unavailable");
  if (marker.phase === "sealed" && liveInstance(password) !== marker.instanceId) {
    fail("Live database instance differs from the sealed setup; refusing database writes");
  }
  if (existing && marker.phase === "bound") {
    const hasSettings = sql(password, "", ["-Atqc", "SELECT to_regclass('public.commerce_settings') IS NOT NULL"]).trim();
    if (hasSettings === "t" && liveInstance(password) && liveInstance(password) !== marker.instanceId) {
      fail("Unsealed setup instance differs; refusing database writes");
    }
  }
  sql(password, readFileSync(prereqs), ["-1"]);
  const schemaExists = sql(password, "", ["-Atqc", "SELECT to_regclass('public.clients') IS NOT NULL"]).trim();
  if (schemaExists === "f") sql(password, readFileSync(baseline), ["-1"]);
  else if (schemaExists !== "t") fail("Owned schema readback failed");
  const seeded = sql(password, "", ["-Atqc", "SELECT EXISTS (SELECT 1 FROM public.catalog_products WHERE slug = 'p5-neutral-refill')"]).trim();
  if (seeded === "f") sql(password, readFileSync(seed), ["-1"]);
  else if (seeded !== "t") fail("Owned seed readback failed");
  if (marker.phase !== "sealed") {
    sql(password, "", ["-v", "ON_ERROR_STOP=1", "-c", `INSERT INTO public.commerce_settings (key,value_text,value_minor) VALUES ('${instanceKey}','${marker.instanceId}',NULL) ON CONFLICT (key) DO NOTHING`]);
    if (liveInstance(password) !== marker.instanceId) fail("Owned database instance could not be sealed");
    marker = { ...marker, phase: "sealed" };
    writeMarker(marker);
  }
  const settingsResponse = await fetch(`${values.API_URL}/auth/v1/settings`, { redirect: "error", signal: AbortSignal.timeout(3000) });
  const settings = await settingsResponse.json();
  if (!settingsResponse.ok || settings.mailer_autoconfirm !== false || settings.external?.email !== true
    || Object.entries(settings.external ?? {}).some(([name, enabled]) => name !== "email" && enabled === true)) fail("Local Auth confirmation/capture guard failed");
  const environment = {
    OPENLUP_REFERENCE_PROFILE: "subscription", LOCAL_BFF: "1", OSS_REFERENCE_STORE_PROFILE: "local-supabase-demo-v1",
    OPENLUP_REFERENCE_DISPOSABLE: "1", OPENLUP_REFERENCE_PROJECT_ID: projectId,
    OPENLUP_REFERENCE_SUPABASE_DIR: directory, APP_BASE_URL: `http://127.0.0.1:${ports.app}`,
    PORT: String(ports.app), OSS_REFERENCE_PAYMENT_OUTCOME: "captured",
    SUPABASE_URL: values.API_URL, SUPABASE_ANON_KEY: values.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: values.SERVICE_ROLE_KEY,
  };
  writeFileSync(join(directory, "subscription.env"), Object.entries(environment).map(([key, value]) => `${key}=${shellQuote(value)}`).join("\n") + "\n", { mode: 0o600 });
  console.log(`Owned subscription setup ready: ${directory}`);
  console.log(`Run local Node with --env-file=${join(directory, "subscription.env")}; preserve this database across server restarts.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Setup failed");
  process.exitCode = 1;
}
