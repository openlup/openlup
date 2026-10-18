// Opt-in envelope proof. Own every stack, keep Auth/API/mail, and refuse missing prerequisites.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { readManagedMigrationChain } from "../../scripts/public-ci-pgtap.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function must(command, args, options = {}) {
  const { stage = command, ...spawnOptions } = options;
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 240000, ...spawnOptions });
  // Do not expose generated credentials, Auth tokens or SQL fixture bodies.
  if (result.error || result.status !== 0) throw new Error(`Identity conformance prerequisite or operation failed: ${stage} (exit ${result.status ?? "unavailable"})`);
  return result.stdout;
}
async function free(port) {
  return new Promise(done => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
  });
}
async function portBlock() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 55000 + randomBytes(2).readUInt16BE() % 8000;
    if ((await Promise.all([0, 1, 2, 3, 4, 9, 10].map(n => free(base + n)))).every(Boolean)) return base;
  }
  throw new Error("Identity conformance needs a free loopback port block");
}
async function main() {
  if (process.argv.slice(2).join(" ") !== "--phase email-trust") throw new Error("Usage: node tests/postgres/runIdentityEnvelopeConformance.mjs --phase email-trust (joint is unsupported)");
  if (process.versions.node.split(".")[0] !== "24" || must("npm", ["--version"]).trim() !== "11.19.0"
    || must("supabase", ["--version"]).trim() !== "2.98.2") throw new Error("Identity conformance requires Node 24, npm 11.19.0 and Supabase CLI 2.98.2");
  must("docker", ["info"]);
  const migrations = readManagedMigrationChain(root);
  // Existing installed TS loader resolves the reference bindings' .js-to-.ts edges.
  const { tsImport } = await import("tsx/esm/api");
  const { runIdentityEnvelopeConformance } = await tsImport("./identityEnvelope.conformance.ts", import.meta.url);
  const { externalProviderFixture } = await tsImport("./identityEnvelopeManagedAdapter.ts", import.meta.url);
  for (const scenario of ["confirmed", "automatic", "external"]) {
    const project = `openlup-identity-${randomBytes(8).toString("hex")}`;
    const directory = mkdtempSync(join(tmpdir(), `${project}-`));
    const base = await portBlock();
    const replacements = { PROJECT_ID: project, SHADOW_PORT: base, API_PORT: base + 1, DB_PORT: base + 2,
      STUDIO_PORT: base + 3, MAIL_PORT: base + 4, POOLER_PORT: base + 9, APP_PORT: base + 10 };
    let config = readFileSync(join(root, "config/public-reference-subscription-supabase.toml"), "utf8").replace(/\{\{([A-Z_]+)\}\}/gu, (_, key) => {
      if (!(key in replacements)) throw new Error("Unknown identity configuration placeholder");
      return String(replacements[key]);
    });
    if (scenario === "automatic") config = config.replace("enable_confirmations = true", "enable_confirmations = false");
    if (scenario === "external") config += externalProviderFixture.config;
    if (config.includes("{{")) throw new Error("Unrendered identity configuration");
    mkdirSync(join(directory, "supabase"), { mode: 0o700 });
    writeFileSync(join(directory, "supabase/config.toml"), config, { mode: 0o600 });
    const existingNames = must("docker", ["ps", "-a", "--format", "{{.Names}}"]);
    if (existingNames.split("\n").some(name => name.endsWith(`_${project}`))) {
      rmSync(directory, { recursive: true });
      throw new Error("Identity conformance refuses an already owned project");
    }
    // A unique random project is never reused; cleanup is limited to this CLI workdir.
    let cleanupError;
    try {
      must("supabase", ["start", "--workdir", directory, "--exclude", "realtime,storage-api,imgproxy,studio,postgres-meta,edge-runtime,logflare,vector,supavisor"]);
      const env = parseEnv(must("supabase", ["status", "--workdir", directory, "-o", "env"]));
      if (env.API_URL !== `http://127.0.0.1:${base + 1}` || !env.ANON_KEY || !env.SERVICE_ROLE_KEY) throw new Error("Owned identity stack credentials unavailable");
      const container = `supabase_db_${project}`;
      const dockerEnv = must("docker", ["inspect", container, "--format", "{{range .Config.Env}}{{println .}}{{end}}"]);
      const password = dockerEnv.match(/^POSTGRES_PASSWORD=(.+)$/m)?.[1];
      if (!password) throw new Error("Owned database credential unavailable");
      const sql = source => must("docker", ["exec", "-e", `PGPASSWORD=${password}`, "-i", container,
        "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", "postgres", "-At", "-1"], { input: source, stage: "owned database replay/fixture/query" }).trim();
      const defaults = ["postgres", "supabase_admin"].flatMap(role => ["", " IN SCHEMA public"].flatMap(scope =>
        ["TABLES", "SEQUENCES", "FUNCTIONS"].map(kind => `ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC, anon, authenticated, service_role;`))).join("\n");
      // Same complete committed replay and default-ACL discipline as public-ci-pgtap.
      sql([readFileSync(join(root, "scripts/public-reference/subscription-prereqs.sql"), "utf8"), defaults,
        "SET ROLE postgres;", ...migrations.map(entry => entry.contents), "RESET ROLE;",
        // FIXTURE ONLY, never shipped: the committed managed reference grants give the service
        // role no INSERT and no UPDATE(auth_user_id) on clients, which the identity adapters'
        // create and link paths need. This disposable stack grants exactly those columns so
        // the proof exercises the package against real Auth; the reference schema's own grant
        // is a separate reviewed managed forward.
        "GRANT INSERT (email, auth_user_id, acquisition_source, lifecycle_stage), UPDATE (auth_user_id) ON public.clients TO service_role;",
        "NOTIFY pgrst, 'reload schema';"].join("\n"));
      let apiReady = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const response = await fetch(`${env.API_URL}/rest/v1/clients?select=id&limit=1`, {
            headers: { apikey: env.SERVICE_ROLE_KEY, authorization: `Bearer ${env.SERVICE_ROLE_KEY}` }, signal: AbortSignal.timeout(3000),
          });
          await response.arrayBuffer();
          if (response.ok) { apiReady = true; break; }
        } catch { /* Startup transport is bounded; no fixture assertion is retried. */ }
        await new Promise(done => setTimeout(done, 500));
      }
      if (!apiReady) throw new Error("Owned identity API did not expose the committed schema with its fixture-only service-role grant");
      await runIdentityEnvelopeConformance({ scenario, url: env.API_URL, anonKey: env.ANON_KEY,
        serviceRoleKey: env.SERVICE_ROLE_KEY, mail: `http://127.0.0.1:${base + 4}`,
        origin: `http://127.0.0.1:${base + 10}`, sql, externalProvider: externalProviderFixture.id });
      // No mutation or new migration can be hidden by changing checkout bytes during proof.
      readManagedMigrationChain(root);
      console.log(`Identity envelope ${scenario}: passed`);
    } finally {
      try { must("supabase", ["stop", "--workdir", directory, "--no-backup"]); }
      catch (error) { cleanupError = error; }
      if (!cleanupError) rmSync(directory, { recursive: true });
      if (cleanupError) throw cleanupError;
    }
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Identity envelope conformance failed"); process.exitCode = 1; });
