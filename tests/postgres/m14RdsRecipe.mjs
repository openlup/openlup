// Serial hosted phases for the common recipe runner; no provider SDK or secret retrieval.
import { createHash, randomUUID } from "node:crypto";
import { checkServerIdentity } from "node:tls";

export { rdsControlRoles } from "../../server/adapters/postgres/rdsControlRoles.ts";
import { rdsControlRoles } from "../../server/adapters/postgres/rdsControlRoles.ts";
export const applicationGroups = ["anon", "authenticated", "service_role", "platform_acquisition_owner",
  "platform_acquisition_runtime", "openlup_retained_import_owner"];
export const incarnationSha256 = row => createHash("sha256").update(JSON.stringify([
  row.address, row.port, row.started, row.database_oid,
])).digest("hex");
const fail = code => { throw new Error(code); };
const identifier = name => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(name)) fail("test_identifier_refused");
  return `"${name}"`;
};
const observedSql = `SELECT inet_server_addr()::text AS address, inet_server_port() AS port,
  pg_postmaster_start_time()::text AS started,
  (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS database_oid,
  current_setting('server_version') AS version, current_setting('server_version_num') AS version_num,
  current_user AS login, current_database() AS database,
  (SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls`;

export async function cleanupRdsPhase(pool, { database, rolePrefix, bootstrapLogin }, actions = { databaseDrops: 0, roleDrops: 0 }) {
  if (database !== rolePrefix || !/^m14_10r_[a-z0-9_]+$/u.test(rolePrefix)) fail("test_namespace_refused");
  const owner = (await pool.query("SELECT pg_catalog.pg_get_userbyid(datdba) AS owner FROM pg_catalog.pg_database WHERE datname=$1", [database])).rows[0]?.owner;
  if (![bootstrapLogin, `${rolePrefix}_m`].includes(owner)) fail("test_database_owner_differs");
  await pool.query(`SET ROLE ${identifier(owner)}`);
  try { await pool.query(`DROP DATABASE ${identifier(database)}`); actions.databaseDrops++; }
  finally { await pool.query("RESET ROLE"); }
  const roles = (await pool.query(`SELECT rolname::text FROM pg_catalog.pg_roles
    WHERE rolname = ANY($1::text[]) OR starts_with(rolname::text,$2) ORDER BY rolname`,
  [applicationGroups, `${rolePrefix}_`])).rows.map(row => row.rolname);
  // Drop granted roles before their test grantors; PG16 retains grant dependencies.
  const ordered = [...applicationGroups.filter(role => roles.includes(role)), ...roles.filter(role => !applicationGroups.includes(role))];
  for (const role of ordered) { await pool.query(`DROP ROLE ${identifier(role)}`); actions.roleDrops++; }
  const absent = (await pool.query(`SELECT
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datname=$1) AS database_absent,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=ANY($2::text[]) OR starts_with(rolname::text,$3)) AS roles_absent`,
  [database, applicationGroups, `${rolePrefix}_`])).rows[0];
  if (!absent.database_absent || !absent.roles_absent) fail("test_cleanup_incomplete");
  return { databaseAbsent: true, rolesAbsent: true, rolesDropped: roles.length };
}

export async function runRdsRecipe({ config, receipt, databases, identity, assertFresh, assertUnchanged, runInstall, Pool }) {
  const started = performance.now();
  const adminConfig = databases["installer-managed"];
  const declared = config.installations["installer-managed"];
  const baselineDatabase = decodeURIComponent(new URL(adminConfig.connectionString).pathname.slice(1));
  if (baselineDatabase === "rdsadmin") fail("provider_database_refused");
  const bootstrapLogin = decodeURIComponent(new URL(adminConfig.connectionString).username);
  const baselineDatabases = [...new Set(["postgres", baselineDatabase])].sort();
  const cleanup = [];
  const actions = { databaseCreates: 0, databaseDrops: 0, roleDrops: 0, phaseLaunches: 0, freshnessReads: 0 };
  receipt.effortCleanup = { status: "RUNNING", actions, phases: cleanup };
  const inventory = mode => mode === "operator-provisioned"
    ? "807ea0c9b303c04c4ad3e9892ab16ee7e89acaea8b7641d1cedd4c79949fab7d"
    : "c94d71fd28d5571cda30307bce4c4b48ebe0a3685c76819d8fa3b3efa8fa9ae7";
  const configFor = name => { const url = new URL(adminConfig.connectionString); url.pathname = `/${name}`;
    return { ...adminConfig, connectionString: url.toString(), application_name: "m14-10r-recipe" }; };
  async function fresh(activeDatabase) {
    // Inspect both accessible baseline DB catalogues, never the provider-owned administrative DB.
    for (const name of [...baselineDatabases, ...(activeDatabase ? [activeDatabase] : [])]) {
      const pool = new Pool(configFor(name));
      try {
        await assertFresh(pool, name, bootstrapLogin, { target: "rds", baselineDatabases, activeDatabase });
        actions.freshnessReads++;
      } finally { await pool.end(); }
    }
  }
  const admin = new Pool(adminConfig);
  try {
    receipt.activePhase = "admission:rds";
    const facts = (await admin.query(observedSql)).rows[0];
    if (!/^16\d{4}$/u.test(facts.version_num) || facts.tls !== true
      || incarnationSha256(facts) !== declared.incarnationSha256) fail("target_identity_or_tls_refused");
    // Close our observation session before inspecting other client sessions.
    await admin.end();
    await fresh();
    const bad = new Pool({ ...adminConfig, ssl: { ...adminConfig.ssl,
      checkServerIdentity: (_host, cert) => checkServerIdentity("wrong-host.example.invalid", cert) } });
    try {
      let refused = false;
      try { await bad.query("SELECT 1"); } catch (error) { refused = error.code === "ERR_TLS_CERT_ALTNAME_INVALID"; }
      if (!refused) fail("tls_hostname_refusal_missing");
    } finally { await bad.end(); }
    receipt.identity = { status: "PASS", ...identity, region: config.region,
      installations: [{ target: "managed PG16 (RDS)", incarnationSha256: incarnationSha256(facts), version: facts.version,
        identityKind: "nonprivileged address/port/start-time/database-OID observation", tls: true }],
      tlsCaSha256: createHash("sha256").update(declared.ca).digest("hex"),
      limits: ["single synthetic instance", "incarnation observation changes after restart; not a system identifier",
        "managed service image not inspected; no OCI image claim", "workspace source proof; no installed-current-package claim"] };
    receipt.install = { status: "RUNNING", modes: [] };
    for (const phase of ["installer-managed", "operator-provisioned", "schema"]) {
      receipt.activePhase = phase;
      await fresh();
      const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
      const database = `m14_10r_${suffix}`;
      const rolePrefix = `m14_10r_${suffix}`;
      const admin = new Pool(adminConfig);
      let created = false;
      try {
        // Recheck the observed incarnation immediately before the first phase write.
        if (incarnationSha256((await admin.query(observedSql)).rows[0]) !== declared.incarnationSha256)
          fail("target_incarnation_changed");
        await admin.query(`CREATE DATABASE ${identifier(database)} TEMPLATE template0`);
        created = true; actions.databaseCreates++;
        await admin.end();
        await fresh(database);
        const roleMode = phase === "operator-provisioned" ? phase : "installer-managed";
        actions.phaseLaunches++;
        const result = await runInstall({ roleMode, inventory: inventory(roleMode), database: configFor(database),
          rolePrefix, target: config.target, layout: config.layout, trustedControlPlane: { roleNames: rdsControlRoles },
          ...(phase === "schema" ? { schemaProof: { previousApplicationPath: config.previousApplicationPath } } : {}) });
        if (phase === "schema") receipt.schema = { status: "PASS", ...result };
        else receipt.install.modes.push({ ...result, identities: { ...result.identities, bootstrap: "host bootstrap" } });
      } finally {
        if (!admin.ended) await admin.end();
        if (created) {
          const cleaner = new Pool(adminConfig);
          try {
            // Never force-disconnect a session: a leak refuses cleanup and PASS.
            const absent = await cleanupRdsPhase(cleaner, { database, rolePrefix, bootstrapLogin }, actions);
            if (incarnationSha256((await cleaner.query(observedSql)).rows[0]) !== declared.incarnationSha256)
              fail("target_incarnation_changed");
            cleanup.push({ phase, status: "PASS", ...absent });
          } finally { await cleaner.end(); }
          await fresh();
        }
      }
    }
    receipt.install.status = "PASS";
    receipt.connections = { status: "PASS", tls: "verify-full: RDS CA and hostname verified; wrong hostname refused",
      paths: ["runtime client pool", "direct migration/admin", "read-only runtime transaction", "dedicated runtime session lock"],
      pooler: "no pooler provisioned", badAffinityRefusal: true, contention: true,
      limits: ["direct endpoint only; deterministic backend-switch refusal, no external pooler or read replica qualification"] };
    assertUnchanged();
    receipt.transfer = { status: "PENDING", owner: "10P" };
    receipt.recovery = { status: "PENDING", owner: "10P" };
    receipt.effortCleanup = { status: "PASS", wallSeconds: (performance.now() - started) / 1000,
      actions, interventions: [], automaticRetries: 0, phases: cleanup, finalFreshCatalogue: true,
      exclusions: ["resource provisioning, source transfer, dependency installation and package builds"],
      claim: "declared-scope fixture measurement, not an SLO" };
    receipt.hostedRecipes["10R"] = { status: "PASS", claim: "hosted RDS PG16 recipe receipt (single synthetic instance)",
      sections: ["identity", "install", "connections", "schema", "effortCleanup"],
      transfer: { status: "PENDING", owner: "10P" }, recovery: { status: "PENDING", owner: "10P" },
      limits: ["not production qualification or an SLO", "no pooler provisioned", "restricted-generation prefix upgrade; no released restricted predecessor claimed"] };
    receipt.status = "PASS_INITIAL_PHASES";
    receipt.claim = receipt.hostedRecipes["10R"].claim;
    delete receipt.activePhase;
  } finally { if (!admin.ended) await admin.end(); }
}
