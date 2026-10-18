import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { ADAPTER_ENTRIES, assertConsumerIsolation, assertExportInventory, compileConsumer, consumerNode, NON_ADAPTER_ENTRIES, OPTIONAL_PEERS, proveAdapterRefusals, runPlatformColdConsumer } from "./platform-cold-consumer.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary: string[] = [];
function scratch() { const path = mkdtempSync(join(tmpdir(), "platform-consumer-falsifier-")); temporary.push(path); return path; }
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function packageFixture(consumer: string, name: string, exports: Record<string, unknown>) {
  const path = join(consumer, "node_modules", name); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify({ name, type: "module", exports }));
  writeFileSync(join(path, "index.js"), "export {};\n");
  writeFileSync(join(path, "index.d.ts"), "export interface Synthetic { value: string }\n");
}
function fixture() {
  const consumer = scratch();
  writeFileSync(join(consumer, "package.json"), '{"type":"module"}');
  packageFixture(consumer, "@openlup/core", { ".": "./index.js" });
  packageFixture(consumer, "@openlup/platform", Object.fromEntries([...NON_ADAPTER_ENTRIES, ...ADAPTER_ENTRIES].map(name => [`./${name}`, { types: "./index.d.ts", default: "./index.js" }])));
  packageFixture(consumer, "zod", { ".": "./index.js" });
  return consumer;
}

it("accepts ordinary confined packages and independently verifies absent peers", () => {
  const consumer = fixture(); assertConsumerIsolation(consumer, root); assertExportInventory(consumer);
});
it.each(OPTIONAL_PEERS)("refuses a physically installed optional peer: %s", peer => {
  const consumer = fixture(); mkdirSync(join(consumer, "node_modules", peer), { recursive: true });
  expect(() => assertConsumerIsolation(consumer, root)).toThrow(/physically present/);
});
it("refuses an OpenLup package symlink resolving outside the consumer", () => {
  const consumer = fixture(), outside = scratch(), path = join(consumer, "node_modules/@openlup/core");
  rmSync(path, { recursive: true }); symlinkSync(outside, path, "dir");
  expect(() => assertConsumerIsolation(consumer, root)).toThrow(/confined ordinary directory/);
});
it("refuses export targets that resolve outside an otherwise ordinary OpenLup package", () => {
  const consumer = fixture(), outside = scratch(); writeFileSync(join(outside, "index.js"), "export {};\n");
  const packageRoot = join(consumer, "node_modules/@openlup/core");
  symlinkSync(outside, join(packageRoot, "external"), "dir");
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@openlup/core", type: "module", exports: { ".": "./external/index.js" } }));
  expect(() => assertConsumerIsolation(consumer, root)).toThrow(/symlink|outside consumer/);
});
it("refuses a nested optional peer even when top-level resolution cannot find it", () => {
  const consumer = fixture(); mkdirSync(join(consumer, "node_modules/zod/node_modules/pg"), { recursive: true });
  expect(() => assertConsumerIsolation(consumer, root)).toThrow(/physically present/);
});
it("refuses ancestor dependencies rather than allowing a host to satisfy the proof", () => {
  const parent = scratch(), consumer = join(parent, "consumer"); mkdirSync(consumer); mkdirSync(join(parent, "node_modules"));
  expect(() => assertConsumerIsolation(consumer, root)).toThrow(/Ancestor node_modules/);
});
it("refuses an unclassified export", () => {
  const consumer = fixture(), path = join(consumer, "node_modules/@openlup/platform/package.json");
  const metadata = JSON.parse(readFileSync(path, "utf8")); metadata.exports["./new-capability"] = "./index.js"; writeFileSync(path, JSON.stringify(metadata));
  expect(() => assertExportInventory(consumer)).toThrow(/inventory needs classification/);
});
it("refuses missing artifact environment before creating or installing a consumer", () => {
  expect(() => runPlatformColdConsumer(root, {})).toThrow(/OPENLUP_PACK_MANIFEST/);
});
it("refuses a missing manifest before any consumer installation", () => {
  expect(() => runPlatformColdConsumer(root, { OPENLUP_PACK_MANIFEST: join(scratch(), "missing.json"), OPENLUP_PACK_COMMIT: "a".repeat(40) })).toThrow(/ENOENT/);
});
it("imports in a fresh Node process with an empty environment", () => {
  const consumer = fixture(); expect(consumerNode(consumer, 'import { env } from "node:process"; console.log(JSON.stringify(Object.keys(env).filter(name => name !== "__CF_USER_TEXT_ENCODING"))); await import("@openlup/platform/kernel");').trim()).toBe("[]");
});
function refusalFixture(mode: "correct" | "raw" | "wrong-peer" | "no-cause" | "success") {
  const consumer = fixture();
  writeFileSync(join(consumer, "node_modules/@openlup/platform/index.js"), `
async function fail(peer) {
  if (${JSON.stringify(mode)} === "success") return;
  const cause = Object.assign(new Error("synthetic missing peer"), { code: "ERR_MODULE_NOT_FOUND" });
  const message = ${JSON.stringify(mode)} === "raw" ? "raw module failure" : "OPENLUP_E_PEER_MISSING: " + (${JSON.stringify(mode)} === "wrong-peer" ? "wrong-package" : peer) + " is required by synthetic capability";
  throw new Error(message, ${JSON.stringify(mode)} === "no-cause" ? undefined : { cause });
}
export const bindBlobPort = () => ({ upload: () => fail("@aws-sdk/client-s3") });
export const createPostgresDataGateway = () => ({ asService: () => fail("pg") });
export const createPostgresRoleFreeTransactionLane = () => ({ run: () => fail("pg"), close: async () => {} });
export const createPostgresMigrationRunner = () => ({ status: () => fail("pg") });
export const createEnvAdvisoryLock = () => ({ tryAcquire: () => fail("pg"), close: async () => {} });
`);
  return consumer;
}
it("accepts explicit missing-peer refusals from every selected adapter", () => {
  proveAdapterRefusals(refusalFixture("correct"));
});
it.each(["raw", "wrong-peer", "no-cause", "success"] as const)("refuses unsound adapter refusal evidence: %s", mode => {
  expect(() => proveAdapterRefusals(refusalFixture(mode))).toThrow();
});
it("compiles actual declarations in both modes and refuses leaked peer types", () => {
  const consumer = fixture(), compiler = join(root, "node_modules/typescript/bin/tsc");
  // Tooling declarations are explicit fixtures; no ancestor node_modules is searched.
  const nodeTypes = join(consumer, "node_modules/@types/node"); mkdirSync(nodeTypes, { recursive: true });
  writeFileSync(join(nodeTypes, "index.d.ts"), "export {};\n");
  compileConsumer(consumer, NON_ADAPTER_ENTRIES, compiler);
  writeFileSync(join(consumer, "node_modules/@openlup/platform/index.d.ts"), 'import type { Pool } from "pg"; export type Leaked = Pool;\n');
  expect(() => compileConsumer(consumer, NON_ADAPTER_ENTRIES, compiler)).toThrow();
}, 30_000);
it("refuses a runtime import that throws even if its declaration exists", () => {
  const consumer = fixture(); writeFileSync(join(consumer, "node_modules/@openlup/platform/index.js"), 'throw new Error("synthetic provider initialization");');
  expect(() => consumerNode(consumer, 'await import("@openlup/platform/kernel");')).toThrow(/synthetic provider initialization/);
});
it("the source-checkout wrapper invokes the cold proof and preserves its refusal", () => {
  const wrapper = join(root, "packages/platform/scripts/consumer-proof.ts");
  expect(() => execFileSync(process.execPath, ["--experimental-strip-types", wrapper], { cwd: root, env: {}, stdio: "pipe" })).toThrow(/OPENLUP_PACK_MANIFEST/);
});

it("starts both install phases and installed-input packs with a cache inside the consumer", () => {
  // The fixture exercises declarations and isolation without invoking npm; check the command construction directly.
  const source = readFileSync(join(root, "scripts/packages/platform-cold-consumer.ts"), "utf8");
  expect(source).toContain('const cache = join(consumer, "npm-cache"); mkdirSync(cache);');
  expect(source).toContain('["install", "--cache", cache, sdkPresent ? "--prefer-offline" : "--offline"');
  expect(source).toContain('["pack", "--cache", cache, "--json", "--ignore-scripts"');
  expect(source).toContain('install(OPTIONAL_PEERS.map(locked), true);');
});
