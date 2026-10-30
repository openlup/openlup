// Opt-in destructive recipe proof. Credentials and raw witness output never leave the worker.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { env } from "node:process";
import { checkServerIdentity } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runLocalJourney, runLocalOidc } from "./m14RecipeJourneys.mjs";
import { rdsControlRoles, runRdsRecipe } from "./m14RdsRecipe.mjs";
import { OIDC_IMAGE } from "./runOidcIdentityConformance.mjs";
import { isIP } from "node:net";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const modes = ["installer-managed", "operator-provisioned", "schema"];
const targets = ["self-host", "neon", "rds", "s3", "hosted-oidc"];
// With other AWS inputs absent, the SDK reaches VM instance metadata only.
export const hostedS3WorkerEnvironment = Object.freeze({ AWS_CONFIG_FILE: "/dev/null", AWS_SHARED_CREDENTIALS_FILE: "/dev/null" });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const refuse = code => { throw new Error(code); };
const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const npmVersion = () => execFileSync(process.execPath,
  [realpathSync(resolve(dirname(process.execPath), "npm")), "--version"], { encoding: "utf8" }).trim();
const pending = owner => ({ status: "PENDING", owner });
function directoryDigest(directory) {
  const files = [];
  const visit = (base, prefix = "") => {
    for (const item of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix + item.name;
      if (item.isDirectory()) visit(resolve(base, item.name), `${path}/`);
      else if (item.isFile()) files.push([path, hash(readFileSync(resolve(base, item.name)))]);
      else refuse("artifact_symlink_refused");
    }
  };
  visit(directory);
  return hash(JSON.stringify(files));
}
function sourceDigest() {
  const paths = git(["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n").filter(Boolean).sort();
  return hash(JSON.stringify(paths.map(path => [path, hash(readFileSync(resolve(root, path)))])));
}

export function loadCredentials(path, target, environment = env) {
  try {
    if (!targets.includes(target) || !isAbsolute(path)) refuse("target_input_required");
    const actual = realpathSync(path);
    if (lstatSync(path).isSymbolicLink()) refuse("credential_symlink_refused");
    // External means outside every Git checkout, including other worktrees.
    let inRepository = false;
    try { execFileSync("git", ["-C", dirname(actual), "rev-parse", "--show-toplevel"], { stdio: "ignore" }); inRepository = true; } catch { /* Expected for external files. */ }
    if (inRepository) refuse("credential_file_must_be_external");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 128 * 1024) refuse("credential_file_requires_owner_mode_600");
      value = JSON.parse(readFileSync(fd, "utf8"));
    } finally { closeSync(fd); }
    if (value.schemaVersion !== 1 || value.target !== target || value.disposable !== true) refuse("explicit_disposable_target_required");
    if (target === "s3" ? !/^[a-z]{2}(-[a-z]+)+-\d+$/u.test(value.region ?? "")
      : !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.region ?? "")) refuse("region_required");
    if (target === "s3") {
      const allowed = ["schemaVersion", "target", "disposable", "region", "bucket", "prefix", "lifecycleStatePath", "sourceCommit", "sourceTree"];
      if (Object.keys(value).some(key => !allowed.includes(key))
        || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(value.bucket ?? "")
        || !/^m14-10o\/[a-zA-Z0-9-]{1,80}\/$/u.test(value.prefix ?? "")
        || !isAbsolute(value.lifecycleStatePath ?? "") || value.lifecycleStatePath.startsWith(root + "/")
        || !/^[a-f0-9]{40}$/u.test(value.sourceCommit ?? "") || !/^[a-f0-9]{40}$/u.test(value.sourceTree ?? "")) refuse("hosted_s3_declaration_refused");
      return value;
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.region ?? "")) refuse("region_required");
    if (target === "hosted-oidc") {
      const issuer = new URL(value.issuerOrigin);
      if (issuer.protocol !== "https:" || issuer.origin !== value.issuerOrigin || issuer.username || issuer.password
        || isIP(issuer.hostname) || !issuer.hostname.includes(".") || issuer.hostname.endsWith(".") || issuer.hostname.endsWith(".localhost")
        || issuer.hostname.endsWith(".local") || issuer.hostname.endsWith(".internal")) refuse("public_https_issuer_required");
      if (value.issuerImage !== OIDC_IMAGE || typeof value.adminPassword !== "string" || value.adminPassword.length < 24)
        refuse("disposable_pinned_issuer_required");
      return value;
    }
    if (!value.installations || Object.keys(value.installations).sort().join() !== [...modes].sort().join()) refuse("three_installations_required");
    if (target === "rds" && (value.layout !== "serial-cluster" || !/^[a-z]{2}(-[a-z]+)+-\d+$/u.test(value.region ?? ""))) refuse("rds_serial_declaration_required");
    if (target === "rds" && Object.keys(value).some(key => !["schemaVersion", "target", "disposable", "region", "layout", "installations", "previousApplicationPath"].includes(key)))
      refuse("rds_declaration_fields_refused");
    for (const mode of modes) {
      const entry = value.installations[mode];
      if (entry?.disposable !== true || (target === "rds" ? !/^[a-f0-9]{64}$/u.test(entry.incarnationSha256 ?? "") : !/^[0-9]{10,30}$/u.test(entry.systemIdentifier ?? ""))) refuse("installation_declaration_required");
      if (target === "rds" && Object.keys(entry).some(key => !["disposable", "connectionString", "passwordEnv", "incarnationSha256", "ca"].includes(key)))
        refuse("rds_declaration_fields_refused");
      if (target !== "rds" && !/^sha256:[a-f0-9]{64}$/u.test(entry.ociDigest ?? "")) refuse("oci_digest_required");
      const url = new URL(entry.connectionString);
      if (target === "self-host" && !["127.0.0.1", "localhost"].includes(url.hostname)) refuse("local_self_host_endpoint_required");
      if (target === "rds" && (!/^(?:PGPASSWORD|M14_[A-Z0-9_]{1,48}_PASSWORD)$/u.test(entry.passwordEnv ?? "")
        || !environment[entry.passwordEnv] || url.password)) refuse("rds_password_environment_required");
      // Bootstrap/database names are explicit target data. Provider admission stays in the installer.
      if (!["postgres:", "postgresql:"].includes(url.protocol) || !/^[a-z_][a-z0-9_]*$/u.test(decodeURIComponent(url.username)) || !/^\/[a-z_][a-z0-9_]*$/u.test(decodeURIComponent(url.pathname))
        || (target !== "rds" && !url.password) || url.search || url.hash || !entry.ca?.includes("-----BEGIN CERTIFICATE-----")) refuse("verified_tls_bootstrap_input_required");
    }
    if (target === "rds") {
      const first = value.installations[modes[0]];
      if (modes.some(mode => ["connectionString", "passwordEnv", "ca", "incarnationSha256"].some(key => value.installations[mode][key] !== first[key])))
        refuse("one_rds_cluster_required");
    } else if (new Set(modes.map(mode => value.installations[mode].systemIdentifier)).size !== 3) refuse("separate_clusters_required");
    if (!isAbsolute(value.previousApplicationPath ?? "")) refuse("previous_application_required");
    if (target === "self-host" && !/^sha256:[a-f0-9]{64}$/u.test(value.localNodeImage ?? "")) refuse("local_node_image_required");
    return value;
  } catch (error) {
    const known = ["hosted_s3_declaration_refused", "target_input_required", "credential_symlink_refused", "credential_file_must_be_external", "credential_file_requires_owner_mode_600",
      "explicit_disposable_target_required", "region_required", "public_https_issuer_required", "disposable_pinned_issuer_required", "three_installations_required", "installation_declaration_required",
      "rds_serial_declaration_required", "rds_declaration_fields_refused", "rds_password_environment_required", "one_rds_cluster_required",
      "oci_digest_required", "verified_tls_bootstrap_input_required", "separate_clusters_required", "previous_application_required", "local_node_image_required", "local_self_host_endpoint_required"];
    refuse(known.includes(error?.message) ? error.message : "credential_input_refused");
  }
}

export function initialReceipt(target) {
  return { schemaVersion: 1, target, status: "INCOMPLETE", startedAt: new Date().toISOString(),
    identity: pending("10A"), install: pending("10A"), connections: pending("10A"), schema: pending("10A"),
    transfer: pending(target === "rds" ? "10P" : "8D/10P"), recovery: pending(target === "rds" ? "10P" : "9A/10P"), oidc: pending("10I"), s3: pending("10O"),
    nodeHosts: pending("10H"), effortCleanup: pending("10H/10S"),
    hostedRecipes: Object.fromEntries(["10N", "10R", "10O", "10I", "10H", "10P"].map(owner => [owner, pending(owner)])) };
}

const poolLimits = { max: 4, connectionTimeoutMillis: 5000, statement_timeout: 15000, query_timeout: 20000, idleTimeoutMillis: 1000 };
// The proof creates cluster-global roles, so admission must inspect more than
// the selected database's public tables before the first write to any target.
export async function assertFreshClusterCatalogue(pool, selectedDatabase, bootstrapLogin, profile) {
  const rds = profile?.target === "rds";
  const allowedRoles = rds ? [bootstrapLogin, ...rdsControlRoles] : ["postgres", bootstrapLogin];
  const expectedDatabases = rds ? [...profile.baselineDatabases, "rdsadmin", ...(profile.activeDatabase ? [profile.activeDatabase] : [])].sort() : [selectedDatabase];
  const row = (await pool.query(`SELECT
    (SELECT array_agg(datname::text ORDER BY datname) FROM pg_catalog.pg_database
      WHERE datname NOT IN ('template0','template1')) AS ordinary_databases,
    EXISTS (SELECT 1 FROM pg_catalog.pg_namespace
      WHERE nspname NOT IN ('pg_catalog','pg_toast','information_schema','public')) AS extra_schemas,
    EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public') AS public_relations,
    EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public') AS public_functions,
    EXISTS (SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname='public') AS public_types,
    EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname<>'plpgsql') AS extra_extensions,
    EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname !~ '^pg_' AND rolname::text <> ALL($1::text[])) AS extra_roles,
    EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity
      WHERE backend_type='client backend' AND pid<>pg_backend_pid()
        AND NOT ($2::boolean AND usename='rdsadmin' AND datname='rdsadmin')) AS other_client_sessions,
    EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE $2::boolean AND datname='rdsadmin'
      AND pg_catalog.pg_get_userbyid(datdba)<>'rdsadmin') AS provider_database_owner_differs`, [allowedRoles, rds])).rows[0];
  if (JSON.stringify(row.ordinary_databases) !== JSON.stringify(expectedDatabases) || row.provider_database_owner_differs
    || row.extra_schemas || row.public_relations || row.public_functions || row.public_types
    || row.extra_extensions || row.extra_roles || row.other_client_sessions) refuse("fresh_cluster_required");
}
async function executeRecipe(config, receipt) {
  const { tsImport } = await import("tsx/esm/api");
  const { Pool } = await import("pg");
  const { runQualifiedAdminCompositionProof } = await tsImport("./m14QualifiedAdminComposition.proof.ts", import.meta.url);
  const { runReleasedSchemaUpgradeProof } = await tsImport("./m14ReleasedSchemaUpgrade.proof.ts", import.meta.url);
  const sourceSha256 = sourceDigest();
  const connectionString = mode => { const entry = config.installations[mode]; const url = new URL(entry.connectionString);
    if (config.target === "rds") url.password = env[entry.passwordEnv];
    return url.toString(); };
  const databases = Object.fromEntries(modes.map(mode => [mode, { connectionString: connectionString(mode),
    ssl: { ca: config.installations[mode].ca, rejectUnauthorized: true, checkServerIdentity: (_host, cert) => checkServerIdentity(new URL(config.installations[mode].connectionString).hostname, cert) }, ...poolLimits }]));
  const packageIdentities = ["core", "outbox", "platform"].map(name => {
    const bytes = readFileSync(resolve(root, `packages/${name}/package.json`));
    return { name: `@openlup/${name}`, version: JSON.parse(bytes).version, manifestSha256: hash(bytes), compiledSha256: directoryDigest(resolve(root, `packages/${name}/dist`)), artifact: "workspace-build" };
  });
  const previous = resolve(dirname(config.previousApplicationPath), "../../package.json");
  const previousBytes = readFileSync(previous);
  const previousManifest = JSON.parse(previousBytes);
  if (previousManifest.name !== "@openlup/platform" || previousManifest.version !== "0.23.0") refuse("previous_application_identity_refused");
  const identity = { sourceCommit: git(["rev-parse", "HEAD"]), sourceTree: git(["rev-parse", "HEAD^{tree}"]),
    workingDiffSha256: hash(git(["diff", "HEAD", "--binary"])), sourceSha256, node: process.versions.node, npm: npmVersion(),
    packages: packageIdentities, previousApplication: { name: previousManifest.name, version: previousManifest.version,
      manifestSha256: hash(previousBytes), compiledSha256: directoryDigest(resolve(config.previousApplicationPath, "../..")) } };
  const assertUnchanged = () => {
    if (sourceDigest() !== sourceSha256
      || packageIdentities.some(item => directoryDigest(resolve(root, `packages/${item.name.split("/")[1]}/dist`)) !== item.compiledSha256)
      || directoryDigest(resolve(config.previousApplicationPath, "../..")) !== identity.previousApplication.compiledSha256)
      refuse("source_changed_during_proof");
  };
  if (config.target === "rds") return runRdsRecipe({ config, receipt, databases, identity, assertUnchanged,
    assertFresh: assertFreshClusterCatalogue, runInstall: runQualifiedAdminCompositionProof, Pool });
  const observed = [];
  // Admit every declared cluster before any proof mutates one of them.
  for (const mode of modes) {
    receipt.activePhase = `admission:${mode}`;
    const pool = new Pool(databases[mode]);
    try {
      const facts = (await pool.query(`SELECT s.system_identifier::text AS identity,
        current_setting('server_version') AS version, current_setting('server_version_num') AS version_num,
        current_user AS login, current_database() AS database,
        (SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls
        FROM pg_catalog.pg_control_system() s`)).rows[0];
      if (facts.identity !== config.installations[mode].systemIdentifier || !/^16/u.test(facts.version_num) || !facts.tls) refuse("target_identity_or_tls_refused");
      await assertFreshClusterCatalogue(pool, facts.database, facts.login);
      observed.push({ mode, ...facts });
      // A trusted certificate plus the wrong hostname must refuse before SQL.
      const bad = new Pool({ ...databases[mode], ssl: { ...databases[mode].ssl, checkServerIdentity: (_host, cert) => checkServerIdentity("wrong-host.example.invalid", cert) } });
      try {
        let refused = false;
        try { await bad.query("SELECT 1"); } catch (error) { refused = error.code === "ERR_TLS_CERT_ALTNAME_INVALID"; }
        if (!refused) refuse("tls_hostname_refusal_missing");
      } finally { await bad.end(); }
    } finally { await pool.end(); }
  }
  receipt.identity = { status: "PASS", region: config.region, sourceCommit: git(["rev-parse", "HEAD"]),
    sourceTree: git(["rev-parse", "HEAD^{tree}"]), workingDiffSha256: hash(git(["diff", "HEAD", "--binary"])), sourceSha256,
    node: process.versions.node, npm: npmVersion(),
    packages: packageIdentities, previousApplication: { name: previousManifest.name, version: previousManifest.version, manifestSha256: hash(previousBytes), compiledSha256: directoryDigest(resolve(config.previousApplicationPath, "../..")) },
    installations: observed, oci: modes.map(mode => ({ mode, operatorDeclaredDigest: config.installations[mode].ociDigest,
      verification: "external endpoint; image identity declared by operator" })),
    limits: ["PostgreSQL 16 only", "three disposable fresh clusters; bootstrap login and database supplied in each URL",
      "workspace source proof; no installed-current-package claim", "backend switching; no PgBouncer qualification", "no hosted qualification inferred", "operator owns target teardown"] };
  receipt.install = { status: "RUNNING", modes: [] };
  for (const mode of modes.slice(0, 2)) {
    const inventory = mode === "installer-managed" ? "c94d71fd28d5571cda30307bce4c4b48ebe0a3685c76819d8fa3b3efa8fa9ae7" : "807ea0c9b303c04c4ad3e9892ab16ee7e89acaea8b7641d1cedd4c79949fab7d";
    receipt.activePhase = `install:${mode}`;
    const result = await runQualifiedAdminCompositionProof({ roleMode: mode, inventory, database: databases[mode] });
    receipt.install.modes.push(result);
  }
  receipt.install.status = "PASS";
  receipt.connections = { status: "PASS", tls: "verified CA and hostname; wrong-host refused on each cluster",
    paths: ["runtime pool", "direct migration/admin", "read-only runtime transaction", "dedicated runtime session lock"],
    poolLimits, rlsRoleDenials: true, contention: true, badAffinityRefusal: true,
    limits: ["one direct endpoint per cluster; no external pooler or independent read replica exercised"] };
  receipt.activePhase = "schema";
  receipt.schema = { status: "RUNNING" };
  receipt.schema = { status: "PASS", ...await runReleasedSchemaUpgradeProof({ database: databases.schema,
    previousApplicationPath: config.previousApplicationPath, requirePreviousApplication: true }) };
  if (sourceDigest() !== sourceSha256
    || packageIdentities.some(item => directoryDigest(resolve(root, `packages/${item.name.split("/")[1]}/dist`)) !== item.compiledSha256)
    || directoryDigest(resolve(config.previousApplicationPath, "../..")) !== receipt.identity.previousApplication.compiledSha256)
    refuse("source_changed_during_proof");
  receipt.status = "PASS_INITIAL_PHASES";
  delete receipt.activePhase;
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 6 || args[0] !== "--target" || args[2] !== "--credentials" || args[4] !== "--receipt" || !targets.includes(args[1])) refuse("usage: --target self-host|neon|rds|s3|hosted-oidc --credentials /external/file.json --receipt /new/receipt.json");
  const [, target, , credentials, , destination] = args;
  if (process.versions.node !== "24.21.0" || npmVersion() !== "11.19.0") refuse("pinned_tools_required");
  const config = loadCredentials(credentials, target); // Refuse bad declarations before spawning or connecting.
  const workerTmp = resolve(root, ".context/scratch/m14-10r-tmp");
  if (target === "rds") mkdirSync(workerTmp, { recursive: true, mode: 0o700 });
  const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const receipt = initialReceipt(target);
  const started = performance.now();
  try {
    if (target === "s3" && process.platform !== "linux") refuse("hosted_s3_vm_required");
    if (target === "hosted-oidc") {
      const frozenSource = sourceDigest();
      const packages = ["core", "outbox", "platform"].map(name => {
        const bytes = readFileSync(resolve(root, `packages/${name}/package.json`));
        return { name: `@openlup/${name}`, version: JSON.parse(bytes).version, manifestSha256: hash(bytes),
          compiledSha256: directoryDigest(resolve(root, `packages/${name}/dist`)), artifact: "workspace-build" };
      });
      receipt.identity = { status: "PASS", sourceHead: git(["rev-parse", "HEAD"]), sourceSha256: frozenSource,
        sourceTree: git(["rev-parse", "HEAD^{tree}"]), workingDiffSha256: hash(git(["diff", "HEAD", "--binary"])), packages,
        region: config.region, target: "hosted test issuer", node: process.versions.node, npm: npmVersion(),
        issuerImage: config.issuerImage, imageVerification: "operator declaration; running digest readback recorded separately",
        limits: ["single synthetic issuer on a test VM", "local supporting database and browser", "no production qualification or SLO"] };
      receipt.activePhase = "oidc";
      receipt.oidc = await runLocalOidc(root, config);
      if (sourceDigest() !== frozenSource || packages.some(item => directoryDigest(resolve(root,
        `packages/${item.name.split("/")[1]}/dist`)) !== item.compiledSha256)) refuse("source_changed_during_proof");
      receipt.hostedRecipes["10I"] = { ...receipt.oidc, claim: "hosted OIDC recipe receipt (single synthetic issuer on a test VM)" };
      receipt.effortCleanup = { status: "PASS", wallSeconds: (performance.now() - started) / 1000,
        witnessLaunches: 1, automaticRetries: 0, interventions: [], cleanup: receipt.oidc.cleanup,
        actions: ["verify public TLS chain and hostname", "launch local disposable PostgreSQL",
          "execute existing browser/token/membership/rotation lifecycle", "delete owned realms and verify absence", "remove local fixture stack"],
        sourceFilesChanged: git(["diff", "--name-only", git(["merge-base", "HEAD", "origin/main"])]).split("\n").filter(Boolean),
        exclusions: ["operator VM provisioning, TLS issuance, image caching and teardown; recorded separately",
          "supporting PostgreSQL and browser are local disposable fixtures; no hosted database qualification"],
        claim: "declared-scope fixture measurement, not an SLO" };
      receipt.status = "PASS_HOSTED_OIDC";
      receipt.claim = receipt.hostedRecipes["10I"].claim;
      delete receipt.activePhase;
      return receipt;
    }
    const result = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
        cwd: root, env: target === "rds" ? { TMPDIR: workerTmp, ...Object.fromEntries(modes.map(mode => {
          const name = config.installations[mode].passwordEnv; return [name, env[name]];
        })) } : target === "s3" ? hostedS3WorkerEnvironment : {}, stdio: ["pipe", "ignore", "ignore", "ipc"], timeout: 600000, killSignal: "SIGKILL" });
      let message;
      child.on("message", value => { message = value; });
      child.once("error", () => reject(new Error("recipe_worker_unavailable")));
      child.once("exit", code => code === 0 && message ? done(message) : reject(new Error("recipe_worker_failed")));
      child.stdin.end(JSON.stringify({ credentials, target }));
    });
    Object.assign(receipt, result);
    if (target === "rds" && receipt.hostedRecipes["10R"].status === "PASS") {
      receipt.effortCleanup.phaseWallSeconds = receipt.effortCleanup.wallSeconds;
      receipt.effortCleanup.wallSeconds = (performance.now() - started) / 1000;
    }
    if (target === "self-host" && receipt.status === "PASS_INITIAL_PHASES") {
      receipt.status = "INCOMPLETE";
      receipt.activePhase = "transfer";
      receipt.transfer = { status: "PASS_LOCAL_PORTABLE_LEG", portableLeg: await runLocalJourney(root, config.localNodeImage),
        managedLeg: { status: "PENDING-ON-8D-2", owner: "8D-2" },
        additionalHostedPair: pending("10P"), claim: "local self-host recipe receipt" };
      receipt.activePhase = "recovery";
      receipt.recovery = await runLocalJourney(root, config.localNodeImage, true);
      receipt.activePhase = "oidc";
      receipt.oidc = await runLocalOidc(root);
      receipt.activePhase = "s3";
      const { runSelfhostStorage } = await import("./m14SelfhostStorage.mjs");
      receipt.s3 = await runSelfhostStorage(root);
      receipt.activePhase = "nodeHosts";
      const { tsImport } = await import("tsx/esm/api");
      const { runSelfhostHost } = await tsImport("./m14SelfhostHost.ts", import.meta.url);
      receipt.nodeHosts = await runSelfhostHost({ image: config.localNodeImage, database: config.installations["installer-managed"] });
      if (sourceDigest() !== receipt.identity.sourceSha256
        || receipt.identity.packages.some(item => directoryDigest(resolve(root, `packages/${item.name.split("/")[1]}/dist`)) !== item.compiledSha256)
        || directoryDigest(resolve(config.previousApplicationPath, "../..")) !== receipt.identity.previousApplication.compiledSha256)
        refuse("source_changed_during_proof");
      receipt.effortCleanup = { status: "PASS", wallSeconds: (performance.now() - started) / 1000,
        witnessLaunches: 6, interventions: [], automaticRetries: 0,
        localActions: { storage: receipt.s3.actions, node: receipt.nodeHosts.actions },
        sourceFilesChanged: git(["diff", "--name-only", git(["merge-base", "HEAD", "origin/main"])]).split("\n").filter(Boolean),
        fixtureCleanup: [receipt.transfer.portableLeg.cleanup, receipt.recovery.cleanup, receipt.oidc.cleanup, receipt.s3.cleanup, receipt.nodeHosts.cleanup],
        exclusions: ["operator provisioning, dependency installation and image caching", "operator-owned declared PostgreSQL clusters and previous application artifact; operator owns teardown"],
        claim: "declared-scope fixture measurement, not an SLO or hosted claim" };
      if ([receipt.recovery, receipt.oidc, receipt.s3, receipt.nodeHosts, receipt.effortCleanup].some(section => section.status !== "PASS"))
        refuse("self_host_section_incomplete");
      receipt.status = "COMPLETE";
      receipt.claim = "local self-host recipe receipt";
      delete receipt.activePhase;
    }
  } catch { receipt.status = "FAIL"; receipt.failure = "recipe_worker_failed; credential-bearing details suppressed"; }
  finally {
    receipt.finishedAt = new Date().toISOString();
    writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`); closeSync(fd);
  }
  if (!["PASS_INITIAL_PHASES", "COMPLETE", "PENDING-OBSERVATION", "PASS_HOSTED_OIDC"].includes(receipt.status)) refuse("recipe_conformance_failed; inspect redacted receipt");
  return receipt;
}

if (process.argv[2] === "--worker" && typeof process.send === "function") {
  const receipt = initialReceipt("self-host");
  try {
    let payload = "";
    for await (const chunk of process.stdin) payload += String(chunk);
    const { credentials, target } = JSON.parse(payload);
    receipt.target = target;
    const config = loadCredentials(credentials, target);
    if (target === "s3") {
      receipt.activePhase = "s3";
      const sourceSha256 = sourceDigest();
      if (git(["write-tree"]) !== config.sourceTree || git(["diff", "--name-only"]) !== "") refuse("hosted_source_identity_refused");
      const packages = ["core", "outbox", "platform"].map(name => ({ name: `@openlup/${name}`,
        version: JSON.parse(readFileSync(resolve(root, `packages/${name}/package.json`))).version,
        compiledSha256: directoryDigest(resolve(root, `packages/${name}/dist`)) }));
      const { runHostedStorage } = await import("./m14HostedStorage.mjs");
      receipt.s3 = await runHostedStorage(config, resolve(root, ".context/scratch/hosted-s3"));
      if (sourceDigest() !== sourceSha256 || packages.some(item => directoryDigest(resolve(root,
        `packages/${item.name.split("/")[1]}/dist`)) !== item.compiledSha256)) refuse("source_changed_during_proof");
      receipt.hostedRecipes["10O"] = receipt.s3;
      receipt.identity = { status: "PASS", target: "hosted S3", region: config.region,
        sourceCommit: config.sourceCommit, sourceTree: config.sourceTree, sourceSha256,
        node: process.versions.node, npm: npmVersion(),
        packages,
        credentialSource: "VM instance metadata; inherited environment and shared profiles excluded" };
      receipt.status = receipt.s3.status === "PASS" ? "COMPLETE" : "PENDING-OBSERVATION";
      receipt.claim = receipt.s3.claim;
      delete receipt.activePhase;
    } else await executeRecipe(config, receipt);
  } catch (error) {
    receipt.status = "FAIL"; receipt.failure = "recipe_phase_failed; credential-bearing details suppressed";
    receipt.diagnostic = { source: error?.stack?.match(/(?:runM14RecipeConformance\.mjs|m14RdsRecipe\.mjs|m14HostedStorage\.mjs|transferObjectSource\.ts|m14QualifiedAdminComposition\.proof\.ts|m14ReleasedSchemaUpgrade\.proof\.ts):[0-9]+:[0-9]+/u)?.[0] ?? null,
      sqlstate: /^[0-9A-Z]{5}$/u.test(error?.code ?? "") ? error.code : null };
  }
  process.send(receipt, () => process.disconnect());
} else if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(receipt => { console.log(receipt.target === "s3"
    ? `Hosted S3 recipe receipt: ${receipt.status}` : receipt.status === "COMPLETE"
    ? "Local self-host recipe receipt: COMPLETE; managed first leg and hosted recipes remain pending"
    : receipt.hostedRecipes["10R"].status === "PASS"
      ? "Hosted RDS PG16 recipe receipt (single synthetic instance): PASS; transfer/recovery pending owner 10P"
    : receipt.status === "PASS_HOSTED_OIDC" ? "Hosted OIDC recipe receipt: PASS; other recipe sections remain pending"
      : "Recipe conformance initial phases: passed; later sections pending"); })
    .catch(() => { console.error("Recipe conformance refused or failed; credential-bearing details suppressed. Check the redacted receipt, target declaration, private external file, fresh PG16 clusters, TLS, built dependencies and cached image/browser prerequisites."); process.exitCode = 1; });
}
