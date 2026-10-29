// Opt-in only: this process owns one isolated installation and never skips a failed prerequisite.
import { ownedStackCleanup } from "../../scripts/owned-stack-cleanup.mjs";
import { disposableLabelArgs } from "../../scripts/disposable-docker.mjs";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

export function acceptanceBundle(args) {
  if (args.length !== 2 || args[0] !== "--bundle" || !["node-postgres", "node-supabase"].includes(args[1])) throw new Error("Usage: node tests/identity/runAcceptance.mjs --bundle node-postgres|node-supabase OR --check-module-graph");
  return args[1];
}
export function managedAcceptanceEmailFrequencyMs(config) {
  const email = config.split(/^[ \t]*\[auth\.email\][ \t]*(?:#.*)?\r?$/m)[1]?.split(/^[ \t]*\[/m)[0];
  const setting = email?.match(/^[ \t]*max_frequency[ \t]*=[ \t]*["']([^"']+)["'][ \t]*(?:#.*)?$/m);
  // The pinned local CLI defaults auth.email.max_frequency to 1s when omitted.
  if (!email || !/^[ \t]*max_frequency[ \t]*=/m.test(email)) return 1000;
  if (!setting || !/^(?:[0-9]+(?:\.[0-9]+)?(?:ms|s|m|h))+$/.test(setting[1])) throw new Error("Invalid managed acceptance email frequency");
  const units = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  return [...setting[1].matchAll(/([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)/g)].reduce((ms, part) => ms + Number(part[1]) * units[part[2]], 0);
}
/**
 * Wait only the remaining per-address window, with 100ms for scheduling margin.
 * @param {{ Created: string, To?: (string | { Address: string })[] }[]} messages
 * @param {string} email
 * @param {number} frequencyMs
 * @param {number} nowMs
 */
export function managedEmailWaitMs(messages, email, frequencyMs, nowMs) {
  /** @type {number | undefined} */
  let latest;
  for (const message of messages) {
    if (!message.To?.some(value => (typeof value === "string" ? value : value.Address).trim().toLowerCase() === email.trim().toLowerCase())) continue;
    const sent = Date.parse(message.Created);
    assert(Number.isFinite(sent), "Managed captured mail requires a send timestamp");
    latest = Math.max(latest ?? sent, sent);
  }
  return latest === undefined ? 0 : Math.max(0, latest + frequencyMs + 100 - nowMs);
}
export function renderManagedAcceptanceConfig(template, replacements) {
  const origin = `http://127.0.0.1:${replacements.APP_PORT}`;
  const config = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in replacements)) throw new Error("Unknown managed configuration placeholder"); return String(replacements[key]);
  }).replace(`additional_redirect_urls = ["${origin}/account/auth/callback"]`, `additional_redirect_urls = ["${origin}/account/auth/callback", "${origin}/admin/auth/callback"]`);
  // Only the owned template's canonical table/key spelling can be overridden.
  for (const line of config.split(/\r?\n/)) {
    const setting = line.split("#", 1)[0].trim();
    if (/rate_limit|email_sent/.test(setting) && !/^(?:\[auth\.rate_limit\]|email_sent\s*=\s*[0-9]+)$/.test(setting)) {
      throw new Error("Ambiguous managed acceptance email rate limit");
    }
  }
  const sections = [...config.matchAll(/^[ \t]*\[([^\r\n]+)\][^\r\n]*(?:\r?\n|$)/gm)];
  const limits = sections.filter(section => section[1] === "auth.rate_limit");
  if (limits.length > 1) throw new Error("Ambiguous managed acceptance email rate limit");
  if (!limits.length) return `${config}${config.endsWith("\n") ? "" : "\n"}\n[auth.rate_limit]\nemail_sent = 20\n`;
  const section = limits[0], start = section.index + section[0].length;
  const end = sections[sections.indexOf(section) + 1]?.index ?? config.length;
  const body = config.slice(start, end);
  const settings = [...body.matchAll(/^[ \t]*email_sent[ \t]*=[^\r\n]*/gm)];
  if (settings.length > 1) throw new Error("Ambiguous managed acceptance email rate limit");
  const rendered = settings.length
    ? body.replace(/^([ \t]*email_sent[ \t]*=[ \t]*)[0-9]+/m, (_, prefix) => `${prefix}20`)
    : `email_sent = 20\n${body}`;
  return config.slice(0, start) + (section[0].endsWith("\n") ? "" : "\n") + rendered + config.slice(end);
}
async function loadAcceptanceModule() {
  // Scoped tsImport namespaces break builtin requires in the build tooling on Node 24.
  const { register } = await import("tsx/esm/api");
  register();
  return import("./acceptance.conformance.ts");
}
function must(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 240000, ...options });
  if (result.error || result.status !== 0) throw new Error(`Identity acceptance operation failed: ${command} (exit ${result.status ?? "unavailable"}); credential-bearing output suppressed`);
  return result.stdout.trim();
}
export function assertContainerOwnership(container, expected) {
  if (container.Id !== expected.containerId || !/^[a-f0-9]{64}$/.test(container.Id)
    || container.Config?.Labels?.[expected.label] !== expected.value) throw new Error("Identity acceptance container ownership mismatch");
}
export function assertPortBindings(container, managedPortBase) {
  for (const ports of [container.NetworkSettings?.Ports, container.HostConfig?.PortBindings]) {
    if (ports === null) continue;
    if (!ports || typeof ports !== "object" || Array.isArray(ports)) throw new Error("Identity acceptance port bindings unavailable");
    for (const bindings of Object.values(ports)) {
      // Null is Docker's representation of an exposed but unpublished port.
      if (bindings === null) continue;
      if (!Array.isArray(bindings)) throw new Error("Identity acceptance port bindings unavailable");
      for (const binding of bindings) {
        if (managedPortBase === undefined) {
          if (!["127.0.0.1", "::1"].includes(binding?.HostIp)) throw new Error("Identity acceptance services must publish on loopback only");
        } else if (typeof binding?.HostPort !== "string" || !/^[1-9][0-9]*$/.test(binding.HostPort)
          || Number(binding.HostPort) < managedPortBase || Number(binding.HostPort) > managedPortBase + 10) {
          throw new Error("Identity acceptance managed ports must stay inside the allocated port block");
        }
      }
    }
  }
}
export function assertManagedAcceptanceTargets(apiUrl, databaseUrl, base) {
  for (const [value, protocol, port, label] of [
    [apiUrl, "http:", base + 1, "API"],
    [databaseUrl, "postgresql:", base + 2, "database"],
  ]) {
    let target;
    try { target = new URL(value); } catch { throw new Error(`Identity acceptance ${label} target unavailable`); }
    // Query parameters can override the database driver's connection host and port.
    if (target.protocol !== protocol || !["127.0.0.1", "[::1]"].includes(target.hostname)
      || target.port !== String(port) || target.search || target.hash
      || (label === "API" && (target.username || target.password || target.pathname !== "/"))) {
      throw new Error(`Identity acceptance ${label} target must use loopback at its allocated port`);
    }
  }
}
async function freePort() {
  return new Promise((done, reject) => {
    const server = createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => typeof address === "object" && address ? done(address.port) : reject(new Error("Loopback port unavailable"))); });
  });
}
async function managedPorts() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const base = 54000 + randomBytes(2).readUInt16BE() % 8000;
    const available = await Promise.all([0,1,2,3,4,9,10].map(offset => new Promise(done => {
      const server = createServer(); server.once("error", () => done(false)); server.listen(base + offset, "127.0.0.1", () => server.close(() => done(true)));
    })));
    if (available.every(Boolean)) return base;
  }
  throw new Error("Identity acceptance requires a free loopback port block");
}
export async function main(args = process.argv.slice(2)) {
  if ((args.length === 1 && args[0] === "--check-module-graph")
    || (args.length === 3 && args[2] === "--check-module-graph" && acceptanceBundle(args.slice(0, 2)))) {
    const { runAcceptance } = await loadAcceptanceModule();
    if (typeof runAcceptance !== "function") throw new Error("Identity acceptance module entrypoint unavailable");
    console.log("Identity acceptance module graph: loaded");
    return;
  }
  const bundle = acceptanceBundle(args);
  if (process.versions.node.split(".")[0] !== "24" || must("npm", ["--version"]) !== "11.19.0") throw new Error("Identity acceptance requires Node 24 and npm 11.19.0");
  // Refuse before provisioning if the other part of the reference composition is absent.
  if (!existsSync("server/runtime/auth/referenceIdentity.ts")) throw new Error("Identity acceptance requires the identity reference composition, route bindings and readiness admission");
  if (bundle === "node-supabase" && !existsSync("supabase/migrations/20261018160000_identity_service_role_capabilities.sql")) throw new Error("Identity acceptance requires the reviewed managed identity service-role forward; fixture-only grants cannot satisfy shipped-install acceptance");
  must("docker", ["info"]);
  if (bundle === "node-supabase" && must("supabase", ["--version"]) !== "2.98.2") throw new Error("Identity acceptance requires installed Supabase CLI 2.98.2");
  const runId = randomUUID(), project = `openlup-identity-${runId.slice(0, 18)}`;
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "openlup-identity-"))); chmodSync(directory, 0o700);
  const inspect = id => JSON.parse(must("docker", ["inspect", id]))[0];
  let owned, managedStarted = false;
  const ids = [];
  let database, origin, auth, managedPortBase;
  const cleanup = ownedStackCleanup(options => {
    const cleanupInspect = id => JSON.parse(must("docker", ["inspect", id], options()))[0];
    // Cleanup failures are fatal. An unknown container is never removed.
    if (managedStarted && !ids.length) {
      const partial = must("docker", ["ps", "-aq", "--filter", `label=com.supabase.cli.project=${project}`], options()).split("\n").filter(Boolean);
      for (const id of partial) {
        const container = cleanupInspect(id), expected = { containerId: container.Id, label: "com.supabase.cli.project", value: project };
        assertContainerOwnership(container, expected); ids.push(expected);
      }
    }
    for (const entry of ids) assertContainerOwnership(cleanupInspect(entry.containerId), entry);
    if (managedStarted) {
      const current = must("docker", ["ps", "-aq", "--filter", `label=com.supabase.cli.project=${project}`], options()).split("\n").filter(Boolean);
      if (current.some(id => !ids.some(entry => entry.containerId.startsWith(id)))) throw new Error("Managed cleanup cannot establish complete ownership; run directory retained");
      must("supabase", ["stop", "--workdir", directory, "--no-backup"], options());
    } else if (bundle === "node-postgres") {
      // A failed start may have created a container without returning its ID.
      const partial = must("docker", ["ps", "-aq", "--filter", `label=com.openlup.identity.run=${runId}`], options()).split("\n").filter(Boolean);
      for (const id of partial) {
        const container = cleanupInspect(id);
        assertContainerOwnership(container, { containerId: container.Id, label: "com.openlup.identity.run", value: runId });
        must("docker", ["rm", "-f", "-v", container.Id], options());
      }
    }
    rmSync(directory, { recursive: true });
  });
  try {
    if (bundle === "node-postgres") {
      // Require a cached image; this runner does not fetch an image or install a tool.
      const image = "postgres:16"; must("docker", ["image", "inspect", image]);
      const password = randomBytes(24).toString("hex");
      const containerId = await cleanup.start("docker", ["run", "--pull=never", "--detach", "--tmpfs", "/var/lib/postgresql/data", "--label", `com.openlup.identity.run=${runId}`, ...disposableLabelArgs(), "--name", project,
        "-e", `POSTGRES_PASSWORD=${password}`, "-p", "127.0.0.1::5432", image]);
      owned = { containerId, label: "com.openlup.identity.run", value: runId };
      const container = inspect(containerId); assertContainerOwnership(container, owned); ids.push(owned);
      assertPortBindings(container);
      const binding = container.NetworkSettings.Ports["5432/tcp"];
      if (binding.length !== 1 || binding[0].HostIp !== "127.0.0.1") throw new Error("Identity database must bind loopback only");
      database = `postgresql://postgres:${password}@127.0.0.1:${binding[0].HostPort}/postgres`;
      origin = `http://127.0.0.1:${await freePort()}`;
    } else {
      const base = managedPortBase = await managedPorts(); origin = `http://127.0.0.1:${base + 10}`;
      mkdirSync(join(directory, "supabase"), { mode: 0o700 });
      const replacements = { PROJECT_ID: project, SHADOW_PORT: base, API_PORT: base + 1, DB_PORT: base + 2, STUDIO_PORT: base + 3, MAIL_PORT: base + 4, POOLER_PORT: base + 9, APP_PORT: base + 10 };
      const config = renderManagedAcceptanceConfig(readFileSync("config/public-reference-subscription-supabase.toml", "utf8"), replacements);
      const emailFrequencyMs = managedAcceptanceEmailFrequencyMs(config);
      writeFileSync(join(directory, "supabase/config.toml"), config, { mode: 0o600 });
      const names = must("docker", ["ps", "-a", "--format", "{{.Names}}"]);
      if (names.split("\n").some(name => name.endsWith(`_${project}`))) throw new Error("Identity project already exists");
      managedStarted = true;
      await cleanup.start("supabase", ["start", "--workdir", directory, "--exclude", "realtime,storage-api,imgproxy,studio,postgres-meta,edge-runtime,logflare,vector,supavisor"]);
      const credentials = parseEnv(must("supabase", ["status", "--workdir", directory, "-o", "env"]));
      if (!credentials.ANON_KEY || !credentials.SERVICE_ROLE_KEY) throw new Error("Owned managed credentials unavailable");
      const managedIds = must("docker", ["ps", "-aq", "--filter", `label=com.supabase.cli.project=${project}`]).split("\n").filter(Boolean);
      const containers = managedIds.length ? JSON.parse(must("docker", ["inspect", ...managedIds])) : [];
      for (const container of containers) {
        const expected = { containerId: container.Id, label: "com.supabase.cli.project", value: project };
        assertContainerOwnership(container, expected); ids.push(expected);
      }
      for (const container of containers) assertPortBindings(container, base);
      const container = inspect(`supabase_db_${project}`); owned = ids.find(entry => entry.containerId === container.Id);
      if (!owned) throw new Error("Managed database has no matching project label");
      const password = container.Config.Env.find(value => value.startsWith("POSTGRES_PASSWORD="))?.slice(18);
      if (!password) throw new Error("Owned managed database credential unavailable");
      database = `postgresql://supabase_admin:${encodeURIComponent(password)}@127.0.0.1:${base + 2}/postgres`;
      auth = { url: credentials.API_URL, anonKey: credentials.ANON_KEY, serviceKey: credentials.SERVICE_ROLE_KEY, mail: `http://127.0.0.1:${base + 4}`, emailFrequencyMs };
      assertManagedAcceptanceTargets(auth.url, database, base);
    }
    const marker = { version: 1, runId, bundle, origin, containerId: owned.containerId };
    writeFileSync(join(directory, "identity-owner.json"), JSON.stringify(marker), { mode: 0o600 });
    const assertContainer = () => { for (const entry of ids) {
      const container = inspect(entry.containerId);
      assertContainerOwnership(container, entry); assertPortBindings(container, managedPortBase);
    } };
    const { runAcceptance } = await loadAcceptanceModule();
    await runAcceptance({ bundle, directory, database, origin, runId, auth, assertContainer });
    console.log(`Identity acceptance ${bundle}: passed`);
  } finally {
    await cleanup.finish();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : "Identity acceptance failed"); process.exitCode = 1; });
