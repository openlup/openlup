// Opt-in destructive recipe proof. Credentials and raw witness output never leave the worker.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { checkServerIdentity } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runLocalJourney, runLocalOidc } from "./m14RecipeJourneys.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const modes = ["installer-managed", "operator-provisioned", "schema"];
const targets = ["self-host", "neon", "rds", "hosted-node"];
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

export function loadCredentials(path, target) {
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
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.region ?? "")) refuse("region_required");
    if (target === "hosted-node") {
      if (Object.keys(value).sort().join() !== ["schemaVersion", "target", "disposable", "region", "origin", "localNodeImage", "database", "certificatePath", "keyPath", "sourceCommit", "sourceTree"].sort().join()) refuse("hosted_node_fields_refused");
      if (!/^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/u.test(value.region)) refuse("region_required");
      if (typeof value.origin !== "string" || !/^https:\/\/[^/?#\\]+\/?$/iu.test(value.origin)) refuse("public_https_origin_required");
      let origin;
      try { origin = new URL(value.origin); } catch { refuse("public_https_origin_required"); }
      const hostname = origin.hostname;
      const dnsHostname = hostname.length <= 253 && hostname.split(".").length > 1
        && hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
        || (origin.port && origin.port !== "443") || isIP(hostname.replace(/^\[|\]$/gu, "")) || !dnsHostname
        || /(?:^|\.)(?:invalid|test|example|localhost|local)$/u.test(hostname)) refuse("public_https_origin_required");
      if (!/^sha256:[a-f0-9]{64}$/u.test(value.localNodeImage ?? "")) refuse("local_node_image_required");
      if (!/^[a-f0-9]{40}$/u.test(value.sourceCommit ?? "") || !/^[a-f0-9]{40}$/u.test(value.sourceTree ?? "")) refuse("source_identity_required");
      const database = new URL(value.database?.connectionString);
      if (!["postgres:", "postgresql:"].includes(database.protocol) || database.hostname !== "127.0.0.1"
        || !database.username || !database.password || !/^\/[a-z_][a-z0-9_]*$/u.test(database.pathname) || database.search || database.hash
        || !value.database.ca?.includes("-----BEGIN CERTIFICATE-----") || Object.keys(value.database).sort().join() !== "ca,connectionString") refuse("local_tls_database_required");
      for (const path of [value.certificatePath, value.keyPath]) {
        if (!isAbsolute(path ?? "") || lstatSync(path).isSymbolicLink() || realpathSync(path).startsWith(`${root}/`)) refuse("external_tls_files_required");
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) refuse("external_tls_files_required");
      }
      return value;
    }
    if (!value.installations || Object.keys(value.installations).sort().join() !== [...modes].sort().join()) refuse("three_installations_required");
    for (const mode of modes) {
      const entry = value.installations[mode];
      if (entry?.disposable !== true || !/^[0-9]{10,30}$/u.test(entry.systemIdentifier ?? "")) refuse("installation_declaration_required");
      if (!/^sha256:[a-f0-9]{64}$/u.test(entry.ociDigest ?? "")) refuse("oci_digest_required");
      const url = new URL(entry.connectionString);
      if (target === "self-host" && !["127.0.0.1", "localhost"].includes(url.hostname)) refuse("local_self_host_endpoint_required");
      // Bootstrap/database names are explicit target data. Provider admission stays in the installer.
      if (!["postgres:", "postgresql:"].includes(url.protocol) || !/^[a-z_][a-z0-9_]*$/u.test(decodeURIComponent(url.username)) || !/^\/[a-z_][a-z0-9_]*$/u.test(decodeURIComponent(url.pathname))
        || !url.password || url.search || url.hash || !entry.ca?.includes("-----BEGIN CERTIFICATE-----")) refuse("verified_tls_bootstrap_input_required");
    }
    if (new Set(modes.map(mode => value.installations[mode].systemIdentifier)).size !== 3) refuse("separate_clusters_required");
    if (!isAbsolute(value.previousApplicationPath ?? "")) refuse("previous_application_required");
    if (target === "self-host" && !/^sha256:[a-f0-9]{64}$/u.test(value.localNodeImage ?? "")) refuse("local_node_image_required");
    return value;
  } catch (error) {
    const known = ["target_input_required", "credential_symlink_refused", "credential_file_must_be_external", "credential_file_requires_owner_mode_600",
      "explicit_disposable_target_required", "region_required", "three_installations_required", "installation_declaration_required",
      "oci_digest_required", "verified_tls_bootstrap_input_required", "separate_clusters_required", "previous_application_required", "local_node_image_required", "local_self_host_endpoint_required", "hosted_node_fields_refused", "public_https_origin_required", "source_identity_required", "local_tls_database_required", "external_tls_files_required"];
    refuse(known.includes(error?.message) ? error.message : "credential_input_refused");
  }
}

export function initialReceipt(target) {
  return { schemaVersion: 1, target, status: "INCOMPLETE", startedAt: new Date().toISOString(),
    identity: pending("10A"), install: pending("10A"), connections: pending("10A"), schema: pending("10A"),
    transfer: pending("8D/10P"), recovery: pending("9A/10P"), oidc: pending("10I"), s3: pending("10O"),
    nodeHosts: pending("10H"), effortCleanup: pending("10H/10S"),
    paas: { ...pending("10H-paas"), reason: "access not provided" },
    hostedRecipes: Object.fromEntries(["10N", "10R", "10O", "10I", "10H", "10P"].map(owner => [owner, pending(owner)])) };
}

const poolLimits = { max: 4, connectionTimeoutMillis: 5000, statement_timeout: 15000, query_timeout: 20000, idleTimeoutMillis: 1000 };
// The proof creates cluster-global roles, so admission must inspect more than
// the selected database's public tables before the first write to any target.
export async function assertFreshClusterCatalogue(pool, selectedDatabase, bootstrapLogin) {
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
      WHERE rolname !~ '^pg_' AND rolname NOT IN ('postgres',$1)) AS extra_roles,
    EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity
      WHERE backend_type='client backend' AND pid<>pg_backend_pid()) AS other_client_sessions`, [bootstrapLogin])).rows[0];
  if (row.ordinary_databases?.length !== 1 || row.ordinary_databases[0] !== selectedDatabase
    || row.extra_schemas || row.public_relations || row.public_functions || row.public_types
    || row.extra_extensions || row.extra_roles || row.other_client_sessions) refuse("fresh_cluster_required");
}
async function executeRecipe(config, receipt) {
  const { tsImport } = await import("tsx/esm/api");
  const { Pool } = await import("pg");
  const { runQualifiedAdminCompositionProof } = await tsImport("./m14QualifiedAdminComposition.proof.ts", import.meta.url);
  const { runReleasedSchemaUpgradeProof } = await tsImport("./m14ReleasedSchemaUpgrade.proof.ts", import.meta.url);
  const sourceSha256 = sourceDigest();
  const databases = Object.fromEntries(modes.map(mode => [mode, { connectionString: config.installations[mode].connectionString,
    ssl: { ca: config.installations[mode].ca, rejectUnauthorized: true, checkServerIdentity: (_host, cert) => checkServerIdentity(new URL(config.installations[mode].connectionString).hostname, cert) }, ...poolLimits }]));
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
  const packageIdentities = ["core", "outbox", "platform"].map(name => {
    const bytes = readFileSync(resolve(root, `packages/${name}/package.json`));
    return { name: `@openlup/${name}`, version: JSON.parse(bytes).version, manifestSha256: hash(bytes), compiledSha256: directoryDigest(resolve(root, `packages/${name}/dist`)), artifact: "workspace-build" };
  });
  const previous = resolve(dirname(config.previousApplicationPath), "../../package.json");
  const previousBytes = readFileSync(previous);
  const previousManifest = JSON.parse(previousBytes);
  if (previousManifest.name !== "@openlup/platform" || previousManifest.version !== "0.23.0") refuse("previous_application_identity_refused");
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

async function executeHostedNode(config, receipt) {
  if (git(["rev-parse", "HEAD"]) !== config.sourceCommit || git(["rev-parse", "HEAD^{tree}"]) !== config.sourceTree
    || git(["diff", "HEAD", "--binary"]) || git(["ls-files", "--others", "--exclude-standard"])) refuse("source_identity_refused");
  const before = sourceDigest();
  const compiled = ["core", "outbox", "platform"].map(name => ({ name: `@openlup/${name}`,
    version: JSON.parse(readFileSync(resolve(root, `packages/${name}/package.json`))).version,
    compiledSha256: directoryDigest(resolve(root, `packages/${name}/dist`)) }));
  receipt.identity = { status: "PASS", sourceCommit: config.sourceCommit, sourceTree: config.sourceTree,
    sourceSha256: before, packages: compiled, node: process.versions.node, npm: npmVersion(),
    target: "hosted AWS VM", region: config.region, originScheme: "https", originClass: "public-https-dns",
    limits: ["single synthetic VM; source workspace proof", "no production qualification or SLO"] };
  receipt.activePhase = "nodeHosts";
  const { tsImport } = await import("tsx/esm/api");
  const { runSelfhostHost } = await tsImport("./m14SelfhostHost.ts", import.meta.url);
  receipt.nodeHosts = await runSelfhostHost({ image: config.localNodeImage, database: config.database,
    hosted: { origin: config.origin, certificatePath: config.certificatePath, keyPath: config.keyPath } });
  if (sourceDigest() !== before || compiled.some(item => directoryDigest(resolve(root, `packages/${item.name.split("/")[1]}/dist`)) !== item.compiledSha256)) refuse("source_changed_during_proof");
  if (receipt.nodeHosts.status !== "PASS" || receipt.nodeHosts.cleanup.status !== "PASS") refuse("hosted_node_incomplete");
  receipt.hostedRecipes["10H"] = { status: "PASS", claim: receipt.nodeHosts.claim, nodeHosts: "nodeHosts",
    paas: receipt.paas, limits: ["operator provisioning and final external teardown recorded separately", "Netlify access not provided"] };
  receipt.status = "PASS_HOSTED_NODE"; receipt.claim = receipt.nodeHosts.claim;
  delete receipt.activePhase;
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 6 || args[0] !== "--target" || args[2] !== "--credentials" || args[4] !== "--receipt" || !targets.includes(args[1])) refuse("usage: --target self-host|neon|rds|hosted-node --credentials /external/file.json --receipt /new/receipt.json");
  const [, target, , credentials, , destination] = args;
  if (process.versions.node !== "24.21.0" || npmVersion() !== "11.19.0") refuse("pinned_tools_required");
  const config = loadCredentials(credentials, target); // Refuse bad declarations before spawning or connecting.
  const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const receipt = initialReceipt(target);
  const started = performance.now();
  try {
    const result = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
        cwd: root, env: target === "hosted-node" ? { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, PLAYWRIGHT_BROWSERS_PATH: resolve(root, ".context/scratch/hosted-node-receipt/browsers") } : {}, stdio: ["pipe", "ignore", "ignore", "ipc"], timeout: 600000, killSignal: "SIGKILL" });
      let message;
      child.on("message", value => { message = value; });
      child.once("error", () => reject(new Error("recipe_worker_unavailable")));
      child.once("exit", code => code === 0 && message ? done(message) : reject(new Error("recipe_worker_failed")));
      child.stdin.end(JSON.stringify({ credentials, target }));
    });
    Object.assign(receipt, result);
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
  if (!["PASS_INITIAL_PHASES", "COMPLETE", "PASS_HOSTED_NODE"].includes(receipt.status)) refuse("recipe_conformance_failed; inspect redacted receipt");
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
    if (target === "hosted-node") await executeHostedNode(config, receipt);
    else await executeRecipe(config, receipt);
  } catch (error) {
    receipt.status = "FAIL"; receipt.failure = "recipe_phase_failed; credential-bearing details suppressed";
    receipt.diagnostic = { source: error?.stack?.match(/(?:runM14RecipeConformance\.mjs|m14QualifiedAdminComposition\.proof\.ts|m14ReleasedSchemaUpgrade\.proof\.ts):[0-9]+:[0-9]+/u)?.[0] ?? null };
  }
  process.send(receipt, () => process.disconnect());
} else if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(receipt => { console.log(receipt.status === "PASS_HOSTED_NODE" ? "Hosted Node/OCI recipe receipt (single synthetic VM): PASS; PaaS remains PENDING" : receipt.status === "COMPLETE"
    ? "Local self-host recipe receipt: COMPLETE; managed first leg and hosted recipes remain pending"
    : "Recipe conformance initial phases: passed; later sections pending"); })
    .catch(() => { console.error("Recipe conformance refused or failed; credential-bearing details suppressed. Check the redacted receipt, target declaration, private external file, fresh PG16 clusters, TLS, built dependencies and cached image/browser prerequisites."); process.exitCode = 1; });
}
