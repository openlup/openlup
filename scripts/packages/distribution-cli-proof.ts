/** Called by the existing cold consumer after installing its verified tarballs. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isolatedConsumerEnv } from "./pack-manifest-input.ts";

// Immutable published artifacts, independently read from the public registry.
// Availability failure refuses proof; no current workspace substitutes for them.
const publishedReleases = [
  { version: "0.35.0", integrity: "sha512-hg7dSjSkbsU8SddTWRvMYb/LbybOVy7ZttDHYFmZ53ALGXctdK960lhgWW2RcmBYsFRx8HTR4EOyADhJL1fhSg==", coreIntegrity: "sha512-Z3q6qcva66yqcyj26DG4jJcMk3iX5tJOf1UgHUbMXlWNQt4lTTBQhb/AkOeB7uvdp9AtBKdAaiw1yzMxnqYtJQ==" },
  { version: "0.36.0", integrity: "sha512-8Lu0YOudABDDQRA38OuPiiRt6lUXIT9cAWBE+PSMahQAqVaGOqruSU/KWcBeP8HfIAZIwGWxxahV4TXgYu66uQ==", coreIntegrity: "sha512-k+aXTW4/TjayyJ5Cqp7KLXUKGhhyAiUy6akWTy+ARtY6dV5A+vhayoz11dUiispvN6y9Y11CJFEzHwf/pHoqQA==" },
] as const;

function preparePublishedReleases(root: string): void {
  for (const release of publishedReleases) {
   for (const [name, integrity] of [["platform", release.integrity], ["core", release.coreIntegrity]] as const) {
    const archive = join(root, `${name}-${release.version}.tgz`);
    const url = `https://registry.npmjs.org/@openlup/${name}/-/${name}-${release.version}.tgz`;
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { writeFile } from "node:fs/promises";
      for (let attempt = 0; attempt < 2; attempt++) {
        let response, bytes;
        try {
          response = await fetch(${JSON.stringify(url)}, {redirect:"error",signal:AbortSignal.timeout(60000)});
          if (response.ok) bytes = Buffer.from(await response.arrayBuffer());
        } catch { /* Network/body timeout is unavailable, without leaking response details. */ }
        if (bytes) {
          if (bytes.length > 20000000) throw Error("published_upgrade_artifact_too_large");
          await writeFile(${JSON.stringify(archive)},bytes,{flag:"wx"});
          break;
        }
        const retryAfter = response?.headers.get("retry-after");
        const quota = [402, 403, 429].includes(response?.status) || (response?.status === 503 && retryAfter != null);
        const failure = quota ? "published_upgrade_artifact_quota_http_" + response.status : "published_upgrade_artifact_unavailable";
        if (response && !response.ok) await response.body?.cancel().catch(() => {});
        if (attempt === 1) throw Error(failure);
        const seconds = retryAfter != null && /^[0-9]+(?:[.][0-9]+)?$/.test(retryAfter) ? Number(retryAfter) : NaN;
        const date = retryAfter == null ? NaN : Date.parse(retryAfter);
        const wait = !Number.isNaN(seconds) ? seconds * 1000 : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1000;
        // Do not retry earlier than requested or let a registry hold CI indefinitely.
        if (wait > 60000) throw Error(failure + "_retry_after_exceeds_budget");
        await new Promise(done => setTimeout(done, wait));
      }
    `], { cwd: root, env: isolatedConsumerEnv(), timeout: 195_000, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(`sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`, integrity);
    const packageRoot = join(root, "releases", release.version, `node_modules/@openlup/${name}`);
    mkdirSync(packageRoot, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", packageRoot], { timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    assert.equal(manifest.name, `@openlup/${name}`);
    assert.equal(manifest.version, release.version);
   }
  }
}

/** Greatest stable core tag below the target visible in every package's npm history. */
export function previousPublishedSet(target: string, tags: string, versions: string[][]): string {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  assert(stable.test(target) && versions.length > 0, "upgrade_pair_invalid");
  const compare = (a: string, b: string) => {
    const left = a.split(".").map(Number), right = b.split(".").map(Number);
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  };
  const candidates = [...tags.matchAll(/refs\/tags\/openlup-core-v([^\s^]+)/g)].map(match => match[1]);
  const previous = candidates.filter(version => stable.test(version) && compare(version, target) < 0 && versions.every(list => list.includes(version))).sort(compare).at(-1);
  assert(previous, "upgrade_pair_previous_unavailable");
  return previous;
}

/** Source-mapped extraction has already materialized these managed paths. */
export function starterUpgradeSnapshot(directory: string, version: string) {
  const ownership = JSON.parse(readFileSync(join(directory, "ownership.json"), "utf8"));
  const files = Object.fromEntries(ownership.managed.filter((path: string) => !ownership.generated.includes(path)).sort()
    .map((path: string) => { assert(!ownership.owned.includes(path), "upgrade_snapshot_ownership_overlap"); return [path, readFileSync(join(directory, path), "utf8")]; }));
  // A harness-only ordinal: neither snapshot admission nor this proof observes SQL.
  return { version, schema: { min: 0, max: 0 }, files: files as Record<string, string> };
}

export function assertUpgradeConflict(report: { state: string; applied: string[]; conflicts: { path: string; reason: string }[] }, path: string): void {
  assert.equal(report.state, "refused"); assert.deepEqual(report.applied, []);
  assert.deepEqual(report.conflicts, [{ path, reason: "current bytes match neither predecessor nor candidate" }]);
}

/** Refuse serving a mixed file snapshot or a declared/installed package mismatch. */
export function assertCompleteStarter(directory: string, snapshot: ReturnType<typeof starterUpgradeSnapshot>): void {
  const matches = Object.entries(snapshot.files).every(([path, content]) => existsSync(join(directory, path)) && readFileSync(join(directory, path), "utf8") === content);
  const dependencies = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).dependencies;
  const installed = Object.entries(dependencies).filter(([name]) => name.startsWith("@openlup/")).every(([name, version]) =>
    existsSync(join(directory, "node_modules", name, "package.json")) && JSON.parse(readFileSync(join(directory, "node_modules", name, "package.json"), "utf8")).version === version);
  assert(matches && installed, "incomplete_application_upgrade");
}

type UpgradePair = { from: string; to: string; fromVersion: string; toVersion: string;
  evidence: { planSha256?: string; customizations?: Record<string, string>; phases: { name: string; result: string }[] } };

function proveStarterPair(consumer: string, pair: UpgradePair): () => void {
  const app = pair.from, from = starterUpgradeSnapshot(app, pair.fromVersion), to = starterUpgradeSnapshot(pair.to, pair.toVersion);
  const phase = (name: string, action: () => void) => { const entry = { name, result: "FAIL" }; pair.evidence.phases.push(entry); action(); entry.result = "PASS"; };
  const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  const owned: Record<string, Buffer> = {};
  phase("customize-owned", () => {
    const ownership = JSON.parse(readFileSync(join(app, "ownership.json"), "utf8"));
    for (const [path, before, after] of [
      ["owned/store.config.ts", "#3d6657", "#663d57"],
      ["owned/fragments.ts", "offer-intro", "adopter-offer-intro"],
    ]) {
      assert(ownership.owned.includes(path) && !Object.hasOwn(from.files, path) && !Object.hasOwn(to.files, path));
      const original = readFileSync(join(app, path), "utf8"); assert(original.includes(before));
      writeFileSync(join(app, path), original.replaceAll(before, after)); owned[path] = readFileSync(join(app, path));
    }
    pair.evidence.customizations = Object.fromEntries(Object.entries(owned).map(([path, bytes]) => [path, hash(bytes)]));
    assertCompleteStarter(app, from);
  });
  const workspace = join(consumer, "distribution-cli-proof"); mkdirSync(workspace);
  const executable = join(consumer, "node_modules/.bin/openlup");
  for (const [name, snapshot] of [["from", from], ["to", to]] as const) writeFileSync(join(workspace, `${name}.json`), JSON.stringify(snapshot));
  const options = ["--root", app, "--from", join(workspace, "from.json"), "--to", join(workspace, "to.json"), "--schema-version", "0", "--json"];
  const run = (command: string, expected = 0) => {
    const result = spawnSync(executable, ["upgrade", command, ...options], { cwd: app, env: isolatedConsumerEnv(), encoding: "utf8" });
    assert.ifError(result.error); assert.equal(result.status, expected, result.stderr || result.stdout); assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout); assert.equal(report.exitCode, expected); return report;
  };
  let plan: ReturnType<typeof run>;
  phase("plan", () => { plan = run("plan"); pair.evidence.planSha256 = hash(JSON.stringify(plan)); assert.deepEqual(starterUpgradeSnapshot(app, pair.fromVersion), from, "planning wrote files"); });
  const changed = plan.files.filter((file: { action: string }) => ["replace", "create"].includes(file.action));
  assert(changed.length > 0, "upgrade_pair_has_no_replacements");
  const conflict = changed.at(-1).path;
  phase("managed-conflict", () => {
    const original = existsSync(join(app, conflict)) ? readFileSync(join(app, conflict)) : null;
    mkdirSync(dirname(join(app, conflict)), { recursive: true });
    writeFileSync(join(app, conflict), "adopter-managed-divergence");
    const before = starterUpgradeSnapshot(app, pair.fromVersion);
    assertUpgradeConflict(run("apply", 1), conflict);
    assert.deepEqual(starterUpgradeSnapshot(app, pair.fromVersion), before, "conflict wrote managed files");
    if (original) writeFileSync(join(app, conflict), original); else rmSync(join(app, conflict));
  });
  phase("interrupt-and-refuse", () => {
    const preload = join(workspace, "interrupt.mjs");
    writeFileSync(preload, 'import { promises as fs } from "node:fs"; const rename = fs.rename.bind(fs); fs.rename = async (...args) => { await rename(...args); process.kill(process.pid, "SIGKILL"); await new Promise(() => {}); };');
    const killed = spawnSync(process.execPath, ["--import", preload, executable, "upgrade", "apply", ...options], { cwd: app, env: isolatedConsumerEnv() });
    assert.ifError(killed.error); assert.equal(killed.signal, "SIGKILL");
    assert.equal(readFileSync(join(app, changed[0].path), "utf8"), to.files[changed[0].path]);
    assert.throws(() => assertCompleteStarter(app, to), /incomplete_application_upgrade/);
  });
  phase("resume", () => { const resumed = run("apply"); assert(resumed.files.some((file: { action: string }) => file.action === "already-applied")); });
  phase("replay", () => { assert.deepEqual(run("apply").applied, []); });
  const checkOwned = () => { for (const [path, bytes] of Object.entries(owned)) assert.deepEqual(readFileSync(join(app, path)), bytes, `owned customization changed: ${path}`); };
  checkOwned(); rmSync(workspace, { recursive: true, force: true });
  return () => phase("installed-application-and-owned-bytes", () => { assertCompleteStarter(app, to); checkOwned(); });
}

export function proveDistributionCliConsumer(consumer: string, pair?: UpgradePair): void | (() => void) {
  if (pair) return proveStarterPair(consumer, pair);
  const executable = join(consumer, "node_modules/.bin/openlup");
  const root = join(consumer, "distribution-cli-proof");
  mkdirSync(root);
  function run(args: string[], expected: number) {
    const result = spawnSync(executable, args, {
      cwd: root, env: isolatedConsumerEnv(), encoding: "utf8", timeout: 60_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    return result.stdout;
  }
  function json(args: string[], expected: number) {
    const report = JSON.parse(run([...args, "--json"], expected));
    assert.equal(report.formatVersion, 1);
    assert.equal(report.exitCode, expected);
    return report;
  }
  try {
    assert.match(run(["--help"], 0), /No SQL, package installation or hooks/);
    assert.equal(json(["verify"], 2).state, "unknown");
    assert.equal(json(["verify", "--unexpected"], 64).state, "refused");
    assert.equal(json(["verify", "--app", ""], 64).state, "refused");
    assert.equal(json(["verify", "--app", "missing.mjs"], 74).state, "failed");

    writeFileSync(join(root, "state.json"), JSON.stringify({ binder: false, schema: "previous", schedule: false }));
    writeFileSync(join(root, "app.mjs"), `
import { readFileSync } from "node:fs";
const state = JSON.parse(readFileSync(new URL("./state.json", import.meta.url), "utf8"));
const run = () => { throw Error("An effect must never be invoked by diagnosis"); };
export function createVerificationInput() {
 const schema = {version:"current",migration:"app-migrations/current.sql",objects:[{kind:"table",name:"public.orders"}]};
 return {
  candidate:{artifact:"app-1",configuration:"configuration-1",environment:"local",database:"local-db",schema:"current"},
  inventoryComplete:true,
  loadedPackages:[{name:"@openlup/core",version:"0.36.0",kind:"kernel"},{name:"@openlup/platform",version:"0.36.0",kind:"rail",modules:["commerce"]}],
  contributions:[{manifest:{name:"@openlup/platform",version:"0.36.0",kind:"rail",module:{id:"commerce",kind:"capability",provides:["./commerce"],dependsOn:[]},emits:[],handles:[],env:[],routes:["orders"],requiredPorts:["orders"],schedules:[{id:"order-expiry",cadenceSeconds:60}],requiredSchema:schema},handlers:[],routes:[{id:"orders",handle:run}],schedules:[{id:"order-expiry",cadenceSeconds:60,run}]}],
  vocabulary:[],exemptions:[],bindings:{ports:state.binder?{"@openlup/platform/commerce:orders":{read:run}}:{},triggers:state.schedule?{"@openlup/platform/commerce:order-expiry":run}:{},routes:{"@openlup/platform/commerce:orders":run},env:{}},
  schemaProbe:{observe:async requirement=>({database:"local-db",version:state.schema,objects:requirement.objects.map(object=>({object,present:true}))})},
 };
}
`);
    const filesBefore = readdirSync(root).sort();
    const report = json(["verify", "--app", "./app.mjs"], 1);
    assert.deepEqual(readdirSync(root).sort(), filesBefore, "diagnosis created a file");
    assert.deepEqual(report.findings.map(item => item.code).sort(), ["OPENLUP_E_PORT_MISSING", "OPENLUP_E_SCHEDULE_UNBOUND", "OPENLUP_E_SCHEMA_BEHIND"]);
    for (const finding of report.findings) {
      for (const field of ["observed", "cause", "fix", "recheck"]) assert.equal(typeof finding[field], "string");
      assert.deepEqual(Object.keys(finding.evidence), ["declared", "bound", "checked", "unknown"]);
      assert.equal(finding.recheck, "openlup verify --app './app.mjs' --json");
    }
    const text = run(["verify", "--app", "./app.mjs"], 1);
    for (const finding of report.findings) assert(text.includes(finding.fix));
    // Repairs use the exact binding keys and migration identity named by the report.
    assert(report.findings.find(item => item.code === "OPENLUP_E_PORT_MISSING").fix.includes('bindings.ports["@openlup/platform/commerce:orders"]'));
    assert(report.findings.find(item => item.code === "OPENLUP_E_SCHEDULE_UNBOUND").fix.includes('bindings.triggers["@openlup/platform/commerce:order-expiry"]'));
    assert(report.findings.find(item => item.code === "OPENLUP_E_SCHEMA_BEHIND").fix.includes("app-migrations/current.sql"));
    writeFileSync(join(root, "state.json"), JSON.stringify({ binder: true, schema: "current", schedule: true }));
    assert.equal(json(["verify", "--app", "./app.mjs"], 0).state, "ready");
    writeFileSync(join(root, "state.json"), JSON.stringify({ binder: true, schema: null, schedule: true }));
    const unknown = json(["verify", "--app", "./app.mjs"], 2);
    assert.equal(unknown.state, "unknown");
    assert(unknown.findings.find(item => item.code === "OPENLUP_E_SCHEMA_BEHIND").evidence.checked.includes("Unknown"));
    writeFileSync(join(root, "bad-app.mjs"), 'throw Error("synthetic-private-detail");');
    assert(!run(["verify", "--app", "./bad-app.mjs", "--json"], 74).includes("synthetic-private-detail"));
    for (const source of [
      "export const = 1;",
      'throw new TypeError("synthetic-private-detail");',
      'export function createVerificationInput() { throw new SyntaxError("synthetic-private-detail"); }',
      'export function createVerificationInput() { throw new TypeError("synthetic-private-detail"); }',
    ]) {
      writeFileSync(join(root, "bad-app.mjs"), source);
      const failure = run(["verify", "--app", "./bad-app.mjs", "--json"], 74);
      assert.equal(JSON.parse(failure).state, "failed");
      assert(!failure.includes("synthetic-private-detail"));
    }

    // The harness prepares real published packages before invoking the CLI.
    // Upgrade never extracts/installs packages; it changes only explicit app files.
    preparePublishedReleases(root);
    const app = join(root, "application");
    mkdirSync(app);
    const snapshot = (version: string) => ({ version, schema: { min: 1, max: 1 }, files: {
      "a.mjs": `
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const version = ${JSON.stringify(version)};
const release = new URL("../releases/"+version+"/", import.meta.url);
const installed = JSON.parse(readFileSync(new URL("node_modules/@openlup/platform/package.json",release),"utf8"));
const core = JSON.parse(readFileSync(new URL("node_modules/@openlup/core/package.json",release),"utf8"));
const application = JSON.parse(readFileSync(new URL("./b.json",import.meta.url),"utf8"));
if (installed.version !== version || core.version !== version || application.dependencies["@openlup/platform"] !== version || application.dependencies["@openlup/core"] !== version) throw Error("incomplete_application_upgrade");
const require = createRequire(new URL("package.json",release));
const {planAppUpgrade} = await import(pathToFileURL(require.resolve("@openlup/platform/lifecycle")).href);
const snapshot = {version:installed.version,schema:{min:1,max:1},files:{}};
const plan = await planAppUpgrade({root:fileURLToPath(new URL("./",import.meta.url)).replace(/\\/$/,""),from:snapshot,to:snapshot,schemaVersion:1});
console.log(JSON.stringify({installedVersion:installed.version,coreVersion:core.version,executedVersion:plan.fromVersion}));
`,
      "b.json": JSON.stringify({ private: true, type: "module", dependencies: { "@openlup/core": version, "@openlup/platform": version } }),
      "theme.css": "original",
    } });
    const from = snapshot(publishedReleases[0].version), to = snapshot(publishedReleases[1].version);
    const executeApp = () => JSON.parse(execFileSync(process.execPath, [join(app, "a.mjs")], { cwd: root, env: isolatedConsumerEnv(), encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }));
    for (const [file, content] of Object.entries(from.files)) writeFileSync(join(app, file), content);
    writeFileSync(join(app, "theme.css"), "local-theme");
    writeFileSync(join(app, "owned.txt"), "local-policy");
    assert.deepEqual(executeApp(), { installedVersion: "0.35.0", coreVersion: "0.35.0", executedVersion: "0.35.0" });
    writeFileSync(join(root, "from.json"), JSON.stringify(from));
    writeFileSync(join(root, "to.json"), JSON.stringify(to));
    const options = ["--root", app, "--from", "from.json", "--to", "to.json", "--schema-version", "1"];
    writeFileSync(join(root, "malformed.json"), "{");
    assert.equal(json(["upgrade", "plan", ...options.map(value => value === "from.json" ? "malformed.json" : value)], 64).state, "refused");
    const before = () => Object.fromEntries(readdirSync(app).sort().map(name => [name, readFileSync(join(app, name), "utf8")]));
    const original = before();
    const plan = json(["upgrade", "plan", ...options], 0);
    assert.deepEqual(before(), original);
    assert.equal(plan.files.find(item => item.path === "theme.css").ownership, "locally-customizable");
    assert.equal(plan.ownership.unlisted, "application-owned");
    writeFileSync(join(app, "b.json"), "divergent");
    const divergent = before();
    assert.equal(json(["upgrade", "apply", ...options], 1).applied.length, 0);
    assert.deepEqual(before(), divergent, "a later sorted conflict must prevent the earlier write");
    writeFileSync(join(app, "b.json"), from.files["b.json"]);
    const preload = join(root, "interrupt.mjs");
    writeFileSync(preload, 'import { promises as fs } from "node:fs"; const rename = fs.rename.bind(fs); fs.rename = async (...args) => { await rename(...args); process.kill(process.pid, "SIGKILL"); await new Promise(() => {}); };');
    const killed = spawnSync(process.execPath, ["--import", preload, executable, "upgrade", "apply", ...options, "--json"], { cwd: root, env: isolatedConsumerEnv(), timeout: 60_000 });
    assert.ifError(killed.error);
    assert.equal(killed.signal, "SIGKILL");
    assert.equal(readFileSync(join(app, "a.mjs"), "utf8"), to.files["a.mjs"]);
    assert.throws(executeApp, /incomplete_application_upgrade/);
    const resumed = json(["upgrade", "apply", ...options], 0);
    assert.deepEqual(resumed.applied, ["b.json"]);
    assert.deepEqual(json(["upgrade", "apply", ...options], 0).applied, []);
    assert.equal(readFileSync(join(app, "theme.css"), "utf8"), "local-theme");
    assert.equal(readFileSync(join(app, "owned.txt"), "utf8"), "local-policy");
    assert.deepEqual(executeApp(), { installedVersion: "0.36.0", coreVersion: "0.36.0", executedVersion: "0.36.0" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Uses the cold consumer's existing owned database; SQL repair is harness work. */
export function proveDistributionCliPostgres(consumer: string, connectionString: string): void {
  const root = join(consumer, "distribution-diagnosis-postgres");
  mkdirSync(root);
  const executeSql = (sql: string) => execFileSync(process.execPath, ["--input-type=module", "-e", `
    import pg from "pg";
    const client = new pg.Client({connectionString:${JSON.stringify(connectionString)}});
    await client.connect();
    try { await client.query(${JSON.stringify(sql)}); } finally { await client.end(); }
  `], { cwd: consumer, env: isolatedConsumerEnv(), timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  let created = false;
  try {
    executeSql("CREATE SCHEMA distribution_diagnosis; CREATE TABLE distribution_diagnosis.schema_version(version text NOT NULL); INSERT INTO distribution_diagnosis.schema_version VALUES ('previous');");
    created = true;
    writeFileSync(join(root, "state.json"), JSON.stringify({ repaired: false }));
    mkdirSync(join(root, "migrations"));
    writeFileSync(join(root, "migrations/current.sql"), "CREATE TABLE distribution_diagnosis.orders(id text PRIMARY KEY); UPDATE distribution_diagnosis.schema_version SET version='current';");
    writeFileSync(join(root, "app.mjs"), `
import pg from "pg";
import { readFileSync } from "node:fs";
import { createSchemaProbe } from "@openlup/core/readiness";
const repaired = JSON.parse(readFileSync(new URL("./state.json",import.meta.url),"utf8")).repaired;
const run = () => { throw Error("diagnosis_executed_effect"); };
export function createVerificationInput() {
 return {
  candidate:{artifact:"local",configuration:"local",environment:"local",database:${JSON.stringify(new URL(connectionString).pathname.slice(1))},schema:"current"},inventoryComplete:true,
  loadedPackages:[{name:"@openlup/core",version:"0.36.0",kind:"kernel"},{name:"@openlup/platform",version:"0.36.0",kind:"rail",modules:["commerce"]}],
  contributions:[{manifest:{name:"@openlup/platform",version:"0.36.0",kind:"rail",module:{id:"commerce",kind:"capability",provides:["./commerce"],dependsOn:[]},emits:[],handles:[],env:[],routes:[],requiredPorts:["orders"],schedules:[{id:"order-expiry",cadenceSeconds:60}],requiredSchema:{version:"current",migration:"distribution-diagnosis-postgres/migrations/current.sql",objects:[{kind:"table",name:"distribution_diagnosis.orders"}]}},handlers:[],routes:[],schedules:[{id:"order-expiry",cadenceSeconds:60,run}]}],
  vocabulary:[],exemptions:[],bindings:{ports:repaired?{"@openlup/platform/commerce:orders":{read:run}}:{},triggers:repaired?{"@openlup/platform/commerce:order-expiry":run}:{},routes:{},env:{}},
  schemaProbe:{async observe(requirement) {
   const client = new pg.Client({connectionString:${JSON.stringify(connectionString)}}); await client.connect();
   try {
    await client.query("BEGIN READ ONLY");
    return await createSchemaProbe(client,async()=>{const result=await client.query("SELECT current_database() AS database, max(version) AS version FROM distribution_diagnosis.schema_version");return result.rows[0];}).observe(requirement);
   } finally { try { await client.query("ROLLBACK"); } finally { await client.end(); } }
  }},
 };
}
`);
    const executable = join(consumer, "node_modules/.bin/openlup");
    const args = ["verify", "--app", join(root, "app.mjs")];
    const run = (expected: number, json = true) => {
      const result = spawnSync(executable, [...args, ...(json ? ["--json"] : [])], { cwd: consumer, env: isolatedConsumerEnv(), encoding: "utf8", timeout: 60_000 });
      assert.ifError(result.error);
      assert.equal(result.status, expected, result.stderr || result.stdout);
      assert.equal(result.stderr, "");
      return result.stdout;
    };
    const report = JSON.parse(run(1));
    assert(report.findings.some(item => item.code === "OPENLUP_E_PORT_MISSING"));
    assert(report.findings.some(item => item.code === "OPENLUP_E_SCHEDULE_UNBOUND"));
    assert(report.findings.some(item => item.code === "OPENLUP_E_SCHEMA_BEHIND" && item.observed.includes('"previous"')));
    assert(report.findings.some(item => item.code === "OPENLUP_E_SCHEMA_BEHIND" && item.observed === "object_absent"));
    const text = run(1, false);
    for (const finding of report.findings) assert(text.includes(finding.fix));
    const schemaFix = report.findings.find(item => item.code === "OPENLUP_E_SCHEMA_BEHIND" && item.fix.startsWith("Apply ")).fix;
    const migration = /^Apply ([a-zA-Z0-9_./-]+) /u.exec(schemaFix)?.[1];
    assert.equal(migration, "distribution-diagnosis-postgres/migrations/current.sql");
    executeSql(readFileSync(join(consumer, migration!), "utf8"));
    writeFileSync(join(root, "state.json"), JSON.stringify({ repaired: true }));
    assert.equal(JSON.parse(run(0)).state, "ready");
  } finally {
    if (created) executeSql("DROP SCHEMA distribution_diagnosis CASCADE;");
    rmSync(root, { recursive: true, force: true });
  }
}
