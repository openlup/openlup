/** Cold installed-artifact proof. Never repack or use workspace resolution. */
import { env as processEnvironment } from "node:process";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertInstalledPackages, isolatedConsumerEnv, readCurrentPackManifest } from "./pack-manifest-input.ts";
import { POSTGRES_PROOF_IMAGE } from "./outbox-disposable-postgres.ts";

export const NON_ADAPTER_ENTRIES = ["http", "bff", "scheduler", "kernel", "composition"] as const;
export const ADAPTER_ENTRIES = ["blob", "data", "migrations", "job-ledger"] as const;
export const OPTIONAL_PEERS = ["pg", "@types/pg", "@aws-sdk/client-s3"] as const;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function command(name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(name, args, { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
export function consumerNode(consumer: string, source: string, args: string[] = []): string {
  // The file (rather than --eval in the checkout) anchors both ESM and CJS resolution.
  const script = join(consumer, "proof.mjs");
  writeFileSync(script, source);
  return command(process.execPath, [script, ...args], consumer);
}

export function assertConsumerIsolation(consumer: string, checkout: string, peersAbsent = true): void {
  const owned = realpathSync(consumer), repository = realpathSync(checkout);
  if (owned === repository || owned.startsWith(repository + sep) || repository.startsWith(owned + sep)) throw new Error("Consumer must be outside the repository and its ancestors");
  // With no ancestor node_modules and no module-path environment, even transitive
  // dependency resolution cannot accidentally borrow a checkout/host dependency.
  for (let parent = dirname(owned); ; parent = dirname(parent)) {
    if (lstatSync(join(parent, "node_modules"), { throwIfNoEntry: false })) throw new Error(`Ancestor node_modules can supply packages: ${parent}`);
    if (parent === dirname(parent)) break;
  }
  assertInstalledPackages(consumer, ["@openlup/core", "@openlup/platform", "zod"]);
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
const owned = realpathSync(process.cwd()), require = createRequire(import.meta.url);
const peers = ${JSON.stringify(OPTIONAL_PEERS)};
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    assert(!lstatSync(path).isSymbolicLink(), "Installed package tree contains a symlink: " + path);
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    ${peersAbsent ? 'assert(!peers.some(peer => path.endsWith(sep + "node_modules" + sep + peer) || (peer.startsWith("@") && path.endsWith(sep + "node_modules" + sep + peer.split("/").join(sep)))), "Optional peer is physically present: " + path);' : ''}
    walk(path);
  }
}
// .bin consists of npm-generated executable symlinks, not resolvable package directories.
for (const entry of readdirSync(join(owned, "node_modules"))) {
  if (entry === ".bin") continue;
  const path = join(owned, "node_modules", entry);
  assert(!lstatSync(path).isSymbolicLink(), "Installed package is a symlink: " + path);
  if (lstatSync(path).isDirectory()) walk(path);
}
${peersAbsent ? `for (const peer of peers) {
  assert(!lstatSync(join(owned, "node_modules", peer), { throwIfNoEntry: false }), "Optional peer is physically present: " + peer);
  for (const resolve of [name => require.resolve(name), name => import.meta.resolve(name)]) {
    assert.throws(() => resolve(peer), error => ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(error.code), "Optional peer resolves: " + peer);
  }
}` : ''}
for (const name of ["@openlup/core", "@openlup/platform"]) {
  const metadata = JSON.parse(require("node:fs").readFileSync(join(owned, "node_modules", name, "package.json"), "utf8"));
  for (const entry of Object.keys(metadata.exports)) {
    const specifier = name + (entry === "." ? "" : entry.slice(1));
    for (const resolved of [require.resolve(specifier), fileURLToPath(import.meta.resolve(specifier))]) {
      assert(realpathSync(resolved).startsWith(owned + sep), "OpenLup resolves outside consumer: " + specifier);
    }
  }
}
`);
}

export function assertExportInventory(consumer: string): void {
  const metadata = JSON.parse(readFileSync(join(consumer, "node_modules/@openlup/platform/package.json"), "utf8"));
  const expected = [...NON_ADAPTER_ENTRIES, ...ADAPTER_ENTRIES].map(name => `./${name}`).sort();
  if (JSON.stringify(Object.keys(metadata.exports).sort()) !== JSON.stringify(expected)) throw new Error("Platform export inventory needs classification");
}

export function compileConsumer(consumer: string, entries: readonly string[], compiler: string): void {
  const file = join(consumer, "consumer.ts");
  writeFileSync(file, entries.map((name, index) => `import type * as Entry${index} from "@openlup/platform/${name}";\nexport type Surface${index} = typeof Entry${index};`).join("\n"));
  for (const mode of ["NodeNext", "Bundler"]) {
    const configuration = join(consumer, "tsconfig.json");
    writeFileSync(configuration, JSON.stringify({ compilerOptions: {
      target: "ES2022", module: mode === "NodeNext" ? "NodeNext" : "ESNext", moduleResolution: mode,
      strict: true, skipLibCheck: false, noEmit: true, types: ["node"],
      typeRoots: [join(consumer, "node_modules/@types")],
    }, files: [file] }));
    process.stdout.write(command(process.execPath, [compiler, "-p", configuration], consumer));
    console.log(`Platform declarations PASS (${mode}; ${entries.join(", ")})`);
  }
}

// A valid synthetic catalogue gets as far as the lazy driver, never a deployment's SQL.
const adapterOperations = `
import assert from "node:assert/strict";
import { bindBlobPort } from "@openlup/platform/blob";
import { createPostgresDataGateway, createPostgresRoleFreeTransactionLane } from "@openlup/platform/data";
import { createPostgresMigrationRunner } from "@openlup/platform/migrations";
import { createEnvAdvisoryLock } from "@openlup/platform/scheduler";
const manifest = { schemaVersion: 1, baseline: { file: "baseline.sql", sha256: "0".repeat(64) }, forward: [], objectInventorySha256: "0".repeat(64) };
function postgresOperations(connectionString) {
  return [
    () => createPostgresDataGateway({ connectionString }).asService(async () => "service"),
    async () => { const lane = createPostgresRoleFreeTransactionLane({ connectionString }); try { return await lane.run(async () => "transaction"); } finally { await lane.close(); } },
    () => createPostgresMigrationRunner({ connectionString }, {
      root: process.cwd(), lockName: "platform-cold-consumer", catalogProjectionPayload: async () => "",
      source: { readMigrations: () => ({ migrations: [{ file: "baseline.sql", content: "SELECT 1;" }], errors: [] }), readManifest: () => manifest, evaluate: () => [] },
    }).status(),
    async () => { const lock = createEnvAdvisoryLock({ DATABASE_URL: connectionString }); try { assert.equal(await lock.tryAcquire("consumer"), true); await lock.release("consumer"); } finally { await lock.close(); } },
  ];
}
`;

export function proveAdapterRefusals(consumer: string): void {
  consumerNode(consumer, adapterOperations + `
const blob = bindBlobPort("s3", { BLOB_S3_BUCKET: "consumer", BLOB_S3_BASE_URL: "https://example.invalid" });
const checks = [["@aws-sdk/client-s3", () => blob.upload("probe", Buffer.from("probe"))],
  ...postgresOperations("postgresql://unused.invalid/consumer").map(operation => ["pg", operation])];
for (const [peer, operation] of checks) {
  await assert.rejects(operation, error => error.message.startsWith("OPENLUP_E_PEER_MISSING: " + peer + " is required by ") && Boolean(error.cause));
}
`);
}

export function proveInstalledAdapters(consumer: string): void {
  consumerNode(consumer, adapterOperations + `
import * as sdk from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { createS3ClientFromEnv } from "@openlup/platform/blob";
// The default loaders must reach real SDK configuration, without opening a socket.
// Invalid URLs deterministically fail before a transport can contact any provider.
const invalidBlob = bindBlobPort("s3", { BLOB_S3_BUCKET: "consumer", BLOB_S3_BASE_URL: "https://example.invalid",
  BLOB_S3_ENDPOINT: "invalid endpoint", BLOB_S3_ACCESS_KEY_ID: "synthetic", BLOB_S3_SECRET_ACCESS_KEY: "synthetic" });
await assert.rejects(() => invalidBlob.upload("probe", Buffer.from("probe")), error => error.code === "ERR_INVALID_URL");
for (const operation of postgresOperations("postgresql://synthetic@localhost:invalid/consumer")) {
  await assert.rejects(operation, error => error.code === "ERR_INVALID_URL");
}
// Inject only the transport into the real S3 SDK; execute its serializer,
// middleware, deserializer and the platform's binding/storage operations.
const objects = new Map();
const requestHandler = { async handle(request) {
  const key = decodeURIComponent(request.path);
  let statusCode = 200, body = "";
  if (request.method === "PUT") {
    const chunks = [];
    if (typeof request.body === "string" || ArrayBuffer.isView(request.body)) chunks.push(Buffer.from(request.body));
    else for await (const chunk of request.body) chunks.push(Buffer.from(chunk));
    objects.set(key, Buffer.concat(chunks));
  } else if (request.method === "HEAD") statusCode = objects.has(key) ? 200 : 404;
  else if (request.method === "DELETE") { objects.delete(key); statusCode = 204; }
  else body = "<ListBucketResult>" + [...objects.keys()].map(key => "<Contents><Key>" + key.split("/").slice(2).join("/") + "</Key></Contents>").join("") + "</ListBucketResult>";
  return { response: { statusCode, headers: { "content-type": "application/xml" }, body: Readable.from([Buffer.from(body)]) } };
} };
class TransportClient extends sdk.S3Client {
  constructor(config) { super({ ...config, requestHandler }); }
}
const clients = [];
const blob = bindBlobPort("s3", { BLOB_S3_BUCKET: "consumer", BLOB_S3_BASE_URL: "https://storage.invalid/consumer",
  BLOB_S3_ENDPOINT: "https://storage.invalid", BLOB_S3_FORCE_PATH_STYLE: "true", BLOB_S3_ACCESS_KEY_ID: "synthetic", BLOB_S3_SECRET_ACCESS_KEY: "synthetic" }, {
  s3ClientFactory: env => createS3ClientFromEnv(env, () => ({ ...sdk, S3Client: class extends TransportClient {
    constructor(config) { super(config); clients.push(this); }
  } })),
});
try {
  assert.equal(await blob.exists("probe"), false);
  const uploaded = await blob.upload("probe", Buffer.from("probe"));
  assert.equal(objects.get("/consumer/probe").toString(), "probe");
  assert.equal(await blob.exists("probe"), true);
  assert.deepEqual(await blob.list(), { keys: ["probe"] });
  await blob.delete(uploaded.url); assert.equal(await blob.exists("probe"), false);
} finally { for (const client of clients) client.destroy(); }

`);
}

// Like the outbox proof: the trusted job service when CI supplies its identity, otherwise an owned
// labelled container; a unique database either way, and no skip when neither is available.
function proveDockerPostgres(consumer: string, environment: NodeJS.ProcessEnv): void {
  const service = environment.OPENLUP_PROOF_SERVICE_CONTAINER, servicePort = environment.OPENLUP_PROOF_SERVICE_PORT;
  if (Boolean(service) !== Boolean(servicePort) || (service && (!/^[a-f0-9]{12,64}$/u.test(service) || !/^\d{1,5}$/u.test(servicePort!) || Number(servicePort) < 1 || Number(servicePort) > 65535))) {
    throw new Error("Missing or malformed job-service identity");
  }
  const docker = (args: string[]) => command("docker", args, root, isolatedConsumerEnv()).trim();
  const owner = randomUUID(), name = `openlup-platform-proof-${owner}`, database = `openlup_platform_proof_${owner.replaceAll("-", "")}`;
  let container: string | undefined, ownedContainer = false, createdDatabase = false;
  try {
    if (service) {
      // Identity comes from job.services, not an ambient port or URL. Require the pinned image.
      const info = JSON.parse(docker(["inspect", service]))[0];
      if (info?.Id !== service || info?.Config?.Image !== POSTGRES_PROOF_IMAGE || !info?.State?.Running
        || !info?.NetworkSettings?.Ports?.["5432/tcp"]?.some((binding: { HostPort: string }) => binding.HostPort === servicePort)) {
        throw new Error("Job service is not the exact pinned running container/port");
      }
      container = service;
    } else {
      ownedContainer = true;
      container = docker(["run", "--detach", "--rm", "--name", name, "--label", `openlup-proof=${owner}`, "--cpus=1", "--memory=512m", "--pids-limit=128", "--tmpfs", "/var/lib/postgresql/data", "--publish", "127.0.0.1::5432", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", POSTGRES_PROOF_IMAGE]);
    }
    docker(["exec", container, "sh", "-c", "for i in $(seq 1 30); do pg_isready -h 127.0.0.1 -U postgres -t 1 && exit 0; sleep 1; done; exit 1"]);
    const port = servicePort ?? docker(["port", container, "5432/tcp"]).split(":").at(-1)!;
    createdDatabase = true; // Only this run's unique name, including a lost CREATE response.
    docker(["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${database}`]);
    // Roles are cluster-wide; create the three the gateway assumes only when they are absent.
    docker(["exec", container, "psql", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1", "-c",
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF; END $$;"]);
    consumerNode(consumer, adapterOperations + `
const operations = postgresOperations(process.argv[2]);
assert.equal(await operations[0](), "service");
assert.equal(await operations[1](), "transaction");
assert.deepEqual(await operations[2](), { pending: ["baseline.sql"], applied: [] });
await operations[3]();
// Default gateway and migration pools have no public shutdown API.
process.exit(0);
`, [`postgresql://postgres@127.0.0.1:${port}/${database}`]);
    console.log(`Platform PostgreSQL SQL conformance PASS (${service ? "job service" : "owned container"}, database ${database})`);
  } finally {
    if (service && createdDatabase) docker(["exec", service, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`]);
    if (ownedContainer) docker(["rm", "--force", name]);
  }
}

export function runPlatformColdConsumer(checkout = root, environment = processEnvironment): void {
  const manifest = environment.OPENLUP_PACK_MANIFEST, commit = environment.OPENLUP_PACK_COMMIT;
  if (!manifest || !commit || !/^[a-f0-9]{40}$/u.test(commit)) throw new Error("Missing or malformed OPENLUP_PACK_MANIFEST / OPENLUP_PACK_COMMIT");
  const packs = readCurrentPackManifest(checkout, resolve(manifest), commit); // Refuse before install or service startup.
  const inputs = ["@openlup/core", "@openlup/platform"].map(name => {
    const pack = packs.get(name);
    if (!pack) throw new Error(`Verified manifest has no ${name} tarball (platform must be publishable in the package inventory)`);
    return pack;
  });
  const consumer = mkdtempSync(join(tmpdir(), "openlup-platform-consumer-"));
  try {
    const lock = JSON.parse(readFileSync(join(checkout, "package-lock.json"), "utf8"));
    const locked = (name: string): string => {
      const version = lock.packages?.[`node_modules/${name}`]?.version;
      if (typeof version !== "string") throw new Error(`Missing locked consumer input: ${name}`);
      return `${name}@${version}`;
    };
    const artifacts = join(consumer, "packs"); mkdirSync(artifacts);
    const tarballs = inputs.map(pack => {
      const bytes = readFileSync(pack.path);
      if (createHash("sha256").update(bytes).digest("hex") !== pack.sha256 || `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== pack.integrity) throw new Error(`Verified artifact changed before use: ${pack.name}`);
      const target = join(artifacts, `${pack.name.split("/")[1]}.tgz`); writeFileSync(target, bytes); return target;
    });
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "platform-cold-consumer", private: true, type: "module" }));
    // The SDK-absent phase uses only npm's default cache. Legacy peer mode prevents automatic peer installs;
    // physical and independent resolution checks below prove what omission flags cannot.
    const install = (packages: string[], sdkPresent = false) => process.stdout.write(command("npm", ["install", sdkPresent ? "--prefer-offline" : "--offline", "--ignore-scripts", "--omit=optional", "--legacy-peer-deps", "--no-audit", "--fund=false", ...packages], consumer, isolatedConsumerEnv()));
    install([...tarballs, locked("zod"), locked("@types/node")]);
    assertConsumerIsolation(consumer, checkout);
    assertExportInventory(consumer);
    for (const entry of NON_ADAPTER_ENTRIES) consumerNode(consumer, `await import("@openlup/platform/${entry}");`);
    const compiler = join(checkout, "node_modules/typescript/bin/tsc");
    compileConsumer(consumer, NON_ADAPTER_ENTRIES, compiler);
    assertConsumerIsolation(consumer, checkout); // Compilation must not have supplied a peer.
    proveAdapterRefusals(consumer);
    install(OPTIONAL_PEERS.map(locked), true);
    assertInstalledPackages(consumer, OPTIONAL_PEERS);
    assertConsumerIsolation(consumer, checkout, false);
    compileConsumer(consumer, [...NON_ADAPTER_ENTRIES, ...ADAPTER_ENTRIES], compiler);
    proveInstalledAdapters(consumer);
    proveDockerPostgres(consumer, environment);
    console.log("Platform cold consumer PASS; verified tarballs, isolated optional peers, no live provider");
  } finally { rmSync(consumer, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) runPlatformColdConsumer();
