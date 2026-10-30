import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertConsumerIsolation } from "../../../scripts/packages/platform-cold-consumer.js";
import { evaluateSelectedPlatformMigrationManifest, readPlatformMigrationManifest, readPlatformMigrations, selectPlatformMigrationManifest, type PlatformMigrationManifest } from "../../../scripts/platform-migration-manifest.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../../server/adapters/postgres/selectedCatalogProjection.js";
import { channelPurchaseFixture } from "../../helpers/channelPurchaseFixture.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../../helpers/postgresContainer.js";

// This is raw local artifact proof, without a clean-commit cold-runner receipt.
// The external program imports only installed public exports; the host supplies
// PostgreSQL and the selected full catalogue, not a second channel implementation.
const consumerProgram = `
import { channelIngestNeedsAttention, channelOrderOpsResponseSchema } from "@openlup/platform/channels";
import * as contractRuntime from "@openlup/platform/channels/contracts";
import type { ChannelOrderOpsResponse, ChannelPurchaseCapture, ChannelPullPage } from "@openlup/platform/channels/contracts";
import { canonicalChannelSource, channelSourceDigest, createChannelWebhookPort, createChannelWebhookHandler, emptyChannelWebhookPort, createPostgresChannelPurchasedSourceStore, CHANNEL_INGEST_MIGRATIONS } from "@openlup/platform/channels/server";
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const operations: ChannelOrderOpsResponse = { contractVersion: "channels.ops.v1", orderId: "fixture-order", channel: null, ingest: null, openQuarantineCount: 0 };
assert(channelOrderOpsResponseSchema.parse(operations).contractVersion === "channels.ops.v1", "operations schema export");
assert(channelIngestNeedsAttention("blocked_stock") && !channelIngestNeedsAttention("done"), "attention vocabulary");
assert(canonicalChannelSource({ z: null, a: "Zoë χ" }) === '{"a":"Zoë χ","z":null}', "canonical Unicode/null");
assert(channelSourceDigest("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "digest export");
assert(CHANNEL_INGEST_MIGRATIONS.length === 2 && CHANNEL_INGEST_MIGRATIONS.every(unit => unit.url.protocol === "file:"), "SQL descriptors");
type CaptureIdentity = Pick<ChannelPurchaseCapture, "captureId" | "rawSourceDigest">;
type PageIdentity = Pick<ChannelPullPage, "pagePacketId" | "expected" | "next">;
const contractTypes: [CaptureIdentity | null, PageIdentity | null] = [null, null];
assert(contractTypes.length === 2, "contract types");
assert(Object.keys(contractRuntime).length === 0, "contracts remain type-only at runtime");
let effects = 0;
const portable = createPostgresChannelPurchasedSourceStore({ actorId: "10000000-0000-4000-8000-000000000111", executor: { async query() { effects++; throw new Error("unexpected SQL"); } } });
assert(portable.readiness.sourceCapture && !portable.readiness.settledIngest && portable.readiness.privacyLifecycle === "unavailable", "portable readiness");
async function refusal(work: () => Promise<unknown>, reason: string) {
  try { await work(); } catch (error) { assert(error instanceof Error && error.message.includes(reason), reason); return; }
  throw new Error("missing refusal: " + reason);
}
await refusal(() => emptyChannelWebhookPort().ingestOrder({} as never), "channel_webhook_port_unavailable");
const options = { store: {} as never, acceptedCurrencies: ["EUR"], noopSettlementForbidden: true };
await refusal(() => createChannelWebhookPort(options).ingestOrder({} as never), "channel_read_unavailable");
await refusal(() => createChannelWebhookPort({ ...options, channels: {} as never }).ingestOrder({} as never), "channel_ingest_rails_unbound");
let status = 0, body: unknown;
const response = { setHeader() {}, status(value: number) { status = value; return this; }, json(value: unknown) { body = value; return this; } };
await createChannelWebhookHandler({ connectorKind: "synthetic_source", enabled: () => false,
  verifyToken: () => { effects++; return true; }, readRawBody: async () => { effects++; return ""; },
  connector: { normalizeWebhook: async () => { effects++; throw new Error("unexpected connector"); } }, port: emptyChannelWebhookPort(),
})({ method: "POST" } as never, response as never);
assert(status === 503 && JSON.stringify(body).includes("feature_flag_disabled") && effects === 0, "disabled webhook before token/body/provider/SQL");
`;

let scratch: string, consumer: string, container: PostgresContainer | undefined, pool: Pool;
let channels: typeof import("@openlup/platform/channels/server");
const npm = (args: string[], cwd: string) => execFileSync("npm", args, { cwd, stdio: "pipe", timeout: 120_000 }).toString();

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "channel-packed-"));
  const tarballs = ["packages/core", "packages/platform", "node_modules/zod"].map(directory => {
    const packed = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], resolve(directory)));
    return join(scratch, packed[0].filename);
  });
  consumer = join(scratch, "consumer"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), '{"type":"module","private":true}');
  npm(["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--omit=optional", "--no-audit", "--no-fund", ...tarballs], consumer);
  assertConsumerIsolation(consumer, process.cwd());
  const installedResolve = createRequire(join(consumer, "package.json")).resolve;
  channels = await import(pathToFileURL(installedResolve("@openlup/platform/channels/server")).href);
}, postgresSetupTimeoutMs);

afterAll(async () => {
  await closePostgres(container, pool);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}, postgresTeardownTimeoutMs);

it("compiles NodeNext and Bundler consumers and runs all three installed exports without optional peers", () => {
  writeFileSync(join(consumer, "consumer.mts"), consumerProgram);
  const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  for (const mode of ["NodeNext", "Bundler"] as const) {
    const output = mode.toLowerCase();
    const config = { compilerOptions: { target: "ES2022", module: mode === "NodeNext" ? "NodeNext" : "ESNext", moduleResolution: mode,
      strict: true, skipLibCheck: true, types: [], lib: ["ES2022", "DOM"], outDir: output }, files: ["consumer.mts"] };
    const configPath = join(consumer, `tsconfig.${output}.json`);
    writeFileSync(configPath, JSON.stringify(config));
    execFileSync(process.execPath, [compiler, "--project", configPath], { cwd: consumer, stdio: "pipe", timeout: 120_000 });
    execFileSync(process.execPath, [join(consumer, output, "consumer.mjs")], { cwd: consumer, stdio: "pipe", timeout: 30_000 });
  }
  const requireInstalled = createRequire(join(consumer, "package.json"));
  const peerManifest: { peerDependenciesMeta: Record<string, { optional?: boolean }> } =
    JSON.parse(readFileSync(join(consumer, "node_modules/@openlup/platform/package.json"), "utf8"));
  for (const [name, metadata] of Object.entries(peerManifest.peerDependenciesMeta)) if (metadata.optional) {
    expect(existsSync(join(consumer, "node_modules", name, "package.json"))).toBe(false);
    expect(() => requireInstalled.resolve(name)).toThrow();
  }
  assertConsumerIsolation(consumer, process.cwd());
}, 300_000);

it("installs exact packed SQL in the full selected native catalogue and executes capture/read/CAS with named portable refusals", async () => {
  if (!await dockerAvailable()) throw new Error("Installed channel proof requires Docker PostgreSQL");
  container = await runPostgresContainer({ name: `channel-consumer-${process.pid}`, password: "synthetic-channel-proof" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Installed channel PostgreSQL unavailable");
  pool = new Pool({ connectionString: container.connectionString, max: 2 });
  const raw = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest;
  const manifest = selectPlatformMigrationManifest(raw, "legacy");
  const selected = [manifest.baseline, ...manifest.forward];
  expect(channels.CHANNEL_INGEST_MIGRATIONS).toHaveLength(2);
  const installedSql = new Map<string, string>(channels.CHANNEL_INGEST_MIGRATIONS.map(unit => {
    const bytes = readFileSync(unit.url);
    expect(bytes).toEqual(readFileSync(unit.catalogPath));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(unit.sha256);
    expect(selected[unit.position]).toEqual({ file: unit.catalogPath, sha256: unit.sha256 });
    return [unit.catalogPath, bytes.toString()] as const;
  }));
  const installedResolve = createRequire(join(consumer, "package.json")).resolve;
  const migrations = await import(pathToFileURL(installedResolve("@openlup/platform/migrations")).href) as typeof import("@openlup/platform/migrations");
  const catalog = readPlatformMigrations(process.cwd());
  const selectedPaths = new Set(selected.map(unit => unit.file));
  const runner = migrations.createPostgresMigrationRunner({ connectionString: container.connectionString }, {
    lockName: "openlup:public-platform-migrations:v1", poolFactory: () => pool,
    source: {
      readManifest: () => manifest,
      readMigrations: () => ({ errors: catalog.errors, migrations: catalog.migrations.filter(unit => selectedPaths.has(unit.file))
        .map(unit => ({ ...unit, content: installedSql.get(unit.file) ?? unit.content })) }),
      evaluate: input => evaluateSelectedPlatformMigrationManifest(input, "legacy"),
    },
    catalogProjectionPayload: async client => selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client)),
  });
  expect((await runner.apply()).applied).toEqual(selected.map(unit => unit.file));
  expect(await runner.status()).toEqual({ applied: selected.map(unit => unit.file), pending: [] });
  for (const unit of channels.CHANNEL_INGEST_MIGRATIONS) {
    expect((await pool.query("SELECT catalog_path,sha256 FROM public.platform_schema_migrations WHERE position=$1", [unit.position])).rows)
      .toEqual([{ catalog_path: unit.catalogPath, sha256: unit.sha256 }]);
  }
  // Pristine installation does not enable or start the host-owned pull job.
  expect((await pool.query("SELECT enabled FROM public.platform_job_controls WHERE job_name='channel-order-pull'")).rows.every(row => row.enabled === false)).toBe(true);
  const db = await pool.connect();
  await db.query("BEGIN");
  try {
    const fixture = await channelPurchaseFixture(db, "portable");
    // Owner execution proves the installed native source rail, not restricted-role qualification.
    const source = channels.createPostgresChannelPurchasedSourceStore({ actorId: fixture.actor, executor: isolatedStatements(db) });
    expect(source.readiness).toEqual({ sourceCapture: true, settledIngest: false, privacyLifecycle: "unavailable" });
    await expect(source.commitPage(fixture.page)).rejects.toThrow("input_conflict");
    await source.recordPage(fixture.page);
    await expect(source.commitPage(fixture.page)).rejects.toThrow("input_conflict");
    const recorded = await source.recordCapture(fixture.capture);
    const read = await source.readCapture({ channelId: fixture.capture.scope.channelId, providerEventId: fixture.capture.providerEventId, actorId: fixture.actor });
    expect(read?.capture).toEqual(fixture.capture);
    expect(await source.recordCapture(fixture.capture)).toEqual(recorded);
    expect(read?.ledgerId).toBeTruthy();
    const competingPage = { ...structuredClone(fixture.page), pagePacketId: "10000000-0000-4000-8000-000000000999" };
    await source.recordPage(competingPage);
    const inputDigest = channels.channelSourceDigest(channels.canonicalChannelSource(fixture.page));
    expect(await source.readPage({ connectionId: fixture.capture.scope.connectionId, pagePacketId: fixture.page.pagePacketId, actorId: fixture.actor, inputDigest }))
      .toEqual({ page: fixture.page, cursorReceipt: null });
    const committed = await source.commitPage(fixture.page);
    expect(committed).toEqual({ outcome: "applied", result: { pagePacketId: fixture.page.pagePacketId, before: fixture.page.expected, after: fixture.page.next } });
    expect(await source.commitPage(fixture.page)).toEqual({ ...committed, outcome: "replayed" });
    await expect(source.commitPage(competingPage)).rejects.toThrow("input_conflict");
    expect((await source.readPage({ connectionId: fixture.capture.scope.connectionId, pagePacketId: fixture.page.pagePacketId, actorId: fixture.actor, inputDigest }))?.cursorReceipt)
      .toEqual(committed.result);
    const wrongEnvironment = structuredClone(fixture.capture);
    wrongEnvironment.scope.environmentRef = "different-test-region";
    await expect(source.recordCapture(wrongEnvironment)).rejects.toThrow("input_conflict");
    await expect(source.originalConversion({ ledgerId: read!.ledgerId, externalLineRef: fixture.capture.normalized.lines[0].externalLineRef,
      jobRunId: fixture.job, canonicalText: null })).rejects.toThrow("channel_purchase_physical_unavailable");
    expect((await db.query("SELECT count(*)::int count FROM public.channel_order_ingests")).rows).toEqual([{ count: 1 }]);
  } finally { await db.query("ROLLBACK"); db.release(); }
}, postgresSetupTimeoutMs);

function isolatedStatements(db: PoolClient) {
  return { async query(sql: string, parameters: readonly unknown[]) {
    await db.query("SAVEPOINT installed_channel_statement");
    try {
      const result = await db.query(sql, parameters.map(value => value !== null && typeof value === "object" ? JSON.stringify(value) : value));
      await db.query("RELEASE SAVEPOINT installed_channel_statement");
      return result;
    } catch (error) {
      await db.query("ROLLBACK TO SAVEPOINT installed_channel_statement; RELEASE SAVEPOINT installed_channel_statement");
      throw error;
    }
  } };
}
