import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedConsumerEnv } from "./pack-manifest-input.ts";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { installA1HostBinding, proveA1ReferenceBindingConsumer, ADAPTER_ENTRIES, assertConsumerIsolation, assertExportInventory, compileConsumer, consumerNode, NON_ADAPTER_ENTRIES, OPTIONAL_PEERS, proveAdapterRefusals, proveOidcRefusals, provePostgresOperations, proveNativeCommunicationsOperations, proveResendConsumer, proveMarketingSyncConsumer, runPlatformColdConsumer } from "./platform-cold-consumer.ts";

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
  expect(NON_ADAPTER_ENTRIES).toEqual(expect.arrayContaining([
    "shipping",
    "shipping/contracts",
  ]));
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
it("uses a compact JWS with the configured issuer and an allowed algorithm before proving the missing JWT library refusal", () => {
  const consumer = fixture();
  writeFileSync(join(consumer, "node_modules/@openlup/platform/index.js"), `
import assert from "node:assert/strict";
export const OIDC_FAILURE_CODES = ["OIDC_NATIVE_SESSION_REQUIRED"];
export const deriveOidcPrincipalId = () => "262d8593-5c2f-8ce3-a5f2-de2751bbfe90";
export const createOidcIdentityVerifier = (config, dependencies) => ({ verifyToken: async token => {
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  for (const part of parts) {
    assert(part.length > 0);
    assert.equal(Buffer.from(part, "base64url").toString("base64url"), part);
  }
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  assert(config.algorithms.includes(header.alg));
  assert.equal(header.kid, "key");
  assert.equal(payload.iss, config.issuer);
  await assert.rejects(dependencies.loadJwt, error => error.code === "ERR_MODULE_NOT_FOUND");
  return { ok: false, code: "OIDC_JWT_LIBRARY_UNAVAILABLE" };
} });
export const createPostgresAccountLinkStore = () => ({
  findAccountByPrincipalId: async () => { throw new Error("OPENLUP_E_PEER_MISSING: pg is required by synthetic capability", { cause: new Error("synthetic missing peer") }); },
  close: async () => {},
});
`);
  proveOidcRefusals(consumer);
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
export const createPostgresDataGateway = () => ({ asService: () => fail("pg"), asActor: () => fail("pg") });
export const createPostgresCustomerMePort = () => ({});
export const createPostgresPrivacyStore = () => ({});
export const createPostgresRoleFreeTransactionLane = () => ({ run: () => fail("pg"), close: async () => {} });
export const createPostgresMigrationRunner = () => ({ status: () => fail("pg") });
export const createPostgresOperatorIdentityStore = () => ({ findMembership: () => fail("pg"), close: async () => {} });
export const createPostgresCustomerChallengeStore = () => ({ pruneChallenges: () => fail("pg"), close: async () => {} });
export const createDirectOperatorInvitationStore = () => ({ read: () => fail("pg"), close: async () => {} });
export const createDirectOperatorIdentityDirectory = () => ({ ensurePrincipal: () => fail("pg"), close: async () => {} });
export const createSupabaseIdentityVerifier = client => ({ verifyAccessToken: async token => { const { data } = await client.auth.getUser(token); return { ...data.user, emailVerified: true }; } });
export const createSupabaseAccountLinkStore = client => ({ findAccountByPrincipalId: async id => (await client.from("clients").select("id").eq("id", id).maybeSingle()).data });
export const createPostgresPrivacyUnitOfWork = createPostgresRoleFreeTransactionLane;
export const createManagedPrivacyStore = () => ({ erasureSupported: false });
export const createPersonalDataContributorRegistry = (_, options) => ({ missingContributors: options.requiredContributorIds });
export const privacyExportRequestSchema = { safeParse: () => ({ success: true }) };
export const createOperatorSessionService = () => {};
export const createOperatorAdminAuth = () => {};
export const createOperatorIdentityVerifier = () => {};
export const operatorChallengeRequestSchema = { safeParse: () => ({ success: true }) };
export const operatorSessionSchema = { safeParse: () => ({ success: false }) };
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
function postgresFixture(mode: "unmigrated" | "operator-success" | "wrong-sqlstate" | "privacy-wrong-result") {
  const consumer = refusalFixture("correct"), path = join(consumer, "node_modules/@openlup/platform/index.js");
  // Retain the import/contract fixtures; replace only the selected database operations.
  const source = readFileSync(path, "utf8").replace(/export const (createPostgres(?:DataGateway|RoleFreeTransactionLane|MigrationRunner|OperatorIdentityStore|PrivacyUnitOfWork)|createEnvAdvisoryLock) = [^\n]+\n/gu, "");
  writeFileSync(path, source + `
export const createPostgresDataGateway = () => ({ asService: async work => work() });
export const createPostgresRoleFreeTransactionLane = () => ({ run: async work => work(), close: async () => {} });
export const createPostgresMigrationRunner = () => ({ status: async () => ({ pending: ["baseline.sql"], applied: [] }) });
export const createEnvAdvisoryLock = () => ({ tryAcquire: async () => true, release: async () => {}, close: async () => {} });
export const createPostgresOperatorIdentityStore = () => ({ findMembership: async () => {
  if (${JSON.stringify(mode)} === "operator-success") return null;
  throw Object.assign(new Error("synthetic missing relation"), { code: ${JSON.stringify(mode === "wrong-sqlstate" ? "42501" : "42P01")} });
}, close: async () => {} });
export const createPostgresPrivacyUnitOfWork = () => ({ run: async work => ${mode === "privacy-wrong-result" ? '"wrong"' : "work()"}, close: async () => {} });
`);
  return consumer;
}
it("proves operator schema refusal and a successful privacy transaction independently", () => {
  provePostgresOperations(postgresFixture("unmigrated"), "postgresql://unused.invalid/consumer");
});
it.each(["operator-success", "wrong-sqlstate", "privacy-wrong-result"] as const)("refuses unsound database operation evidence: %s", mode => {
  expect(() => provePostgresOperations(postgresFixture(mode), "postgresql://unused.invalid/consumer")).toThrow();
});
it("compiles actual declarations in both modes and refuses leaked peer types", () => {
  const consumer = fixture(), compiler = join(root, "node_modules/typescript/bin/tsc");
  // Tooling declarations are explicit fixtures; no ancestor node_modules is searched.
  const nodeTypes = join(consumer, "node_modules/@types/node"); mkdirSync(nodeTypes, { recursive: true });
  writeFileSync(join(nodeTypes, "index.d.ts"), "export {};\n");
  compileConsumer(consumer, NON_ADAPTER_ENTRIES, compiler);
  writeFileSync(join(consumer, "node_modules/@openlup/platform/index.d.ts"), 'import type { Pool } from "pg"; export type Leaked = Pool;\n');
  expect(() => compileConsumer(consumer, NON_ADAPTER_ENTRIES, compiler)).toThrow();
});
it("refuses a runtime import that throws even if its declaration exists", () => {
  const consumer = fixture(); writeFileSync(join(consumer, "node_modules/@openlup/platform/index.js"), 'throw new Error("synthetic provider initialization");');
  expect(() => consumerNode(consumer, 'await import("@openlup/platform/identity");')).toThrow(/synthetic provider initialization/);
});
it("the source-checkout wrapper invokes the cold proof and preserves its refusal", () => {
  const wrapper = join(root, "packages/platform/scripts/consumer-proof.ts");
  expect(() => execFileSync(process.execPath, ["--experimental-strip-types", wrapper], { cwd: root, env: {}, stdio: "pipe" })).toThrow(/OPENLUP_PACK_MANIFEST/);
});

it("classifies the browser identity entry separately from the mixed server adapter entry", () => {
  expect(ADAPTER_ENTRIES).toContain("catalog");
  expect(NON_ADAPTER_ENTRIES).not.toContain("catalog");
  expect(NON_ADAPTER_ENTRIES).toContain("catalog/contracts");
  expect(ADAPTER_ENTRIES).toContain("communications");
  expect(NON_ADAPTER_ENTRIES).toContain("communications/contracts");
  expect(ADAPTER_ENTRIES).toContain("identity");
  expect(NON_ADAPTER_ENTRIES).toContain("identity/contracts");
  expect(NON_ADAPTER_ENTRIES).toContain("pricing");
  expect(NON_ADAPTER_ENTRIES).toContain("pricing/contracts");
});

it.each(["createPostgresCustomerChallengeStore", "createDirectOperatorInvitationStore", "createDirectOperatorIdentityDirectory"])("requires a refusal from identity adapter %s", name => {
  const consumer = refusalFixture("correct"), path = join(consumer, "node_modules/@openlup/platform/index.js");
  const source = readFileSync(path, "utf8");
  writeFileSync(path, source.replace(new RegExp("export const " + name + " = [^\\n]+"), "export const " + name + " = () => ({ pruneChallenges: async () => null, read: async () => null, ensurePrincipal: async () => null, close: async () => {} });"));
  expect(() => proveAdapterRefusals(consumer)).toThrow();
});
it("refuses an eager identity driver import while optional peers are absent", () => {
  const consumer = refusalFixture("correct"), path = join(consumer, "node_modules/@openlup/platform/index.js");
  writeFileSync(path, 'import "pg";\n' + readFileSync(path, "utf8"));
  expect(() => proveAdapterRefusals(consumer)).toThrow(/pg/);
});

it("the SDK-absent phase admits only the five supplied packages, including nested dependencies", () => {
  for (const suffix of ["unselected-sdk", "zod/node_modules/unselected-sdk"]) {
    const consumer = fixture(); mkdirSync(join(consumer, "node_modules", suffix), { recursive: true });
    expect(() => assertConsumerIsolation(consumer, root)).toThrow(/Unexpected cold dependency/);
  }
});

function nativeCommunicationsFixture(mode: "correct" | "no-op" | "wrong-token" | "false-delivery" | "second-executor") {
  const consumer=fixture();
  writeFileSync(join(consumer,"node_modules/@openlup/platform/index.js"), `
const mode=${JSON.stringify(mode)};
let queued={},observed=mode==="false-delivery"?"delivered":null,settled=false,recipient=null;
export const createPostgresDeliveryReconciliationPort=()=>({
 registerNetworkTarget:async input=>{if(input.evidence!=="network_accepted")throw Error("capture refused");observed=mode==="false-delivery"?"delivered":null;return {id:"send"};},
 findFrozenSends:async()=>mode==="no-op"?[]:[{id:"send",messageId:"network:cold"}],
 findByMessageId:async()=>({id:"send"}),listEvidence:async()=>[{id:"send"}],
 readEvidence:async()=>({observedState:observed}),applyPolledEvent:async()=>{observed="delivered";},close:async()=>{},
});
export const createPostgresCommunicationSyncStore=()=>({
 registerWork:async input=>{queued=input;settled=false;return {id:"work"};},claimBatch:async()=>settled&&mode!=="second-executor"?[]:[{...queued,id:"work",claimToken:"current",payload:{},attemptCount:0}],
 markSent:async input=>{if(mode==="wrong-token")return true;if(settled||input.claimToken!=="current")return false;settled=true;return true;},close:async()=>{},
});
export const createPostgresNotificationRecipientsPort=()=>({
 createNotificationRecipient:async input=>{recipient={...input,id:"recipient"};},listNotificationRecipients:async()=>({recipients:recipient?[recipient]:[]}),
 updateNotificationRecipient:async input=>{recipient.active=input.active;},deleteNotificationRecipient:async()=>{recipient=null;},close:async()=>{},
});
const admitted=new WeakSet();
export const guardEmailTransport=transport=>admitted.has(transport)?transport:{send:async()=>({outcome:{ok:false}})};
export const createGuardedEmailTransport=input=>{const transport={send:async message=>{const context=await input.policy(message.to);const result=await input.send({...message,to:context.recipient},context);return {...result,outcome:{...result.outcome,egressMode:context.mode}};}};admitted.add(transport);return transport;};
export const createInMemoryEmailTransport=()=>({send:async()=>({outcome:{ok:true}})});
export const runCommunicationSyncDispatch=async({store,provider})=>{const events=await store.claimBatch({});for(const event of events){await provider.sync(event);await store.markSent({eventId:event.id,claimToken:event.claimToken,providerKind:provider.providerKind});}return {sent:events.length,checked:events.length};};
export const createPostgresConsentEvaluator=()=>({evaluate:async()=>({allowed:false,decisionId:"decision"}),guarantees:{managedFrequencyCaps:false,legacyContactTouching:false,sendTimeFence:false},close:async()=>{}});
`);
  return consumer;
}
it("admits a complete native operations transcript through the installed-consumer witness",()=>{
  proveNativeCommunicationsOperations(nativeCommunicationsFixture("correct"),"postgresql://unused.invalid/synthetic");
});
it.each(["no-op","wrong-token","false-delivery","second-executor"] as const)("turns the native operations witness red for %s",mode=>{
  expect(()=>proveNativeCommunicationsOperations(nativeCommunicationsFixture(mode),"postgresql://unused.invalid/synthetic")).toThrow();
});
it("requires native scoped lookup and bounded evidence rather than accepting an unrelated installed store",()=>{
 const consumer=nativeCommunicationsFixture("correct");
 const path=join(consumer,"node_modules/@openlup/platform/index.js");
 writeFileSync(path,readFileSync(path,"utf8").replace("findByMessageId:async()=>({id:\"send\"}),", ""));
 // This deliberately incompatible candidate has no composed lookup.
 expect(()=>proveNativeCommunicationsOperations(consumer,"postgresql://unused.invalid/synthetic")).toThrow();
 expect(readFileSync(path,"utf8")).not.toContain("findByMessageId");
});

function resendFixture(mode: "correct" | "extra-export" | "raw-bypass") {
  const consumer = fixture(), packageRoot = join(consumer, "node_modules/@openlup/platform");
  const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  metadata.exports["./communications/resend"] = "./communications/resend/index.js";
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify(metadata));
  mkdirSync(join(packageRoot, "communications/resend"), { recursive: true });
  for (const path of ["resend/index.js", "emailTransport.js", "emailEgress.js", "emailObservation.js", "deliveryReconciliation.js"]) {
    copyFileSync(join(root, "packages/platform/dist/communications", path), join(packageRoot, "communications", path));
  }
  const path = join(packageRoot, "communications/resend/index.js");
  if (mode === "extra-export") writeFileSync(path, readFileSync(path, "utf8") + "\nexport const unexpected = true;\n");
  if (mode === "raw-bypass") {
    const source = readFileSync(path, "utf8");
    const changed = source.replace("return createGuardedEmailTransport({", "return ({").replace("policy: input.policy,", "")
      .replace("send: (message, context) => postResendEmail(message, context,",
        'send: message => postResendEmail(message, { mode: "sandbox_direct", reason: "synthetic_bypass", recipient: message.to, intendedRecipient: message.to, credential: "synthetic-bypass", environmentTag: "non_production" },');
    expect(changed).not.toBe(source); writeFileSync(path, changed);
  }
  return consumer;
}
function marketingFixture(mode: "correct" | "extra-export" | "unverified") {
  const consumer = fixture(), packageRoot = join(consumer, "node_modules/@openlup/platform");
  const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  metadata.exports["./communications/klaviyo"] = "./communications/klaviyo/index.js";
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify(metadata));
  const entry = Object.entries(metadata.exports).find(([, value]) => typeof value === "string")![0].slice(2);
  cpSync(join(root, "packages/platform/dist", entry), join(packageRoot, entry), { recursive: true });
  const path = join(packageRoot, entry, "index.js");
  if (mode === "extra-export") writeFileSync(path, readFileSync(path, "utf8") + "\nexport const unexpected = true;\n");
  if (mode === "unverified") writeFileSync(path, readFileSync(path, "utf8").replace('state: "verification_pending"', 'state: "supported"'));
  return consumer;
}
it("proves the installed Resend surface with no SDK/optional peers and only injected IO", () => {
  const consumer = resendFixture("correct"); assertConsumerIsolation(consumer, root); proveResendConsumer(consumer);
  const marketing = marketingFixture("correct"); assertConsumerIsolation(marketing, root); proveMarketingSyncConsumer(marketing);
});
it("refuses extra exports and raw bypass in the installed Resend adapter", () => {
  for (const mode of ["extra-export", "unverified"] as const) {
    expect(() => proveMarketingSyncConsumer(marketingFixture(mode)), `P2 installed ${mode}`)
      .toThrow(mode === "extra-export" ? /P2 installed exact one-export surface/ : /P2 installed pending account evidence/);
  }
  for (const mode of ["extra-export", "raw-bypass"] as const) {
    expect(() => proveResendConsumer(resendFixture(mode)), `I02 ${mode}: named invariant assertion`)
      .toThrow(mode === "raw-bypass" ? /AssertionError.*I02 blocked\/drop zero POST/s : /AssertionError.*I02 exact three-export surface/s);
  }
});

let packedA1Consumer: string;
const packedA1Originals: [string, Buffer][] = [];
function packedA1Fixture(consumer: string) {
  writeFileSync(join(consumer, "package.json"), '{"type":"module"}');
  for (const name of ["core", "platform"]) {
    const output = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", consumer], { cwd: join(root, "packages", name), encoding: "utf8", env: { ...isolatedConsumerEnv(), npm_config_cache: join(consumer, "cache") } }));
    const target = join(consumer, "node_modules/@openlup", name); mkdirSync(target, { recursive: true });
    execFileSync("tar", ["-xzf", join(consumer, output[0].filename), "-C", target, "--strip-components=1"]);
  }
  cpSync(join(root, "node_modules/zod"), join(consumer, "node_modules/zod"), { recursive: true });
  installA1HostBinding(consumer);
  return consumer;
}
beforeAll(() => {
  packedA1Consumer = mkdtempSync(join(tmpdir(), "platform-consumer-falsifier-"));
  packedA1Fixture(packedA1Consumer);
  for (const path of ["node_modules/@openlup/platform/package.json", "server/runtime/communications/a1ReferenceBinding.js"]) {
    const fullPath = join(packedA1Consumer, path); packedA1Originals.push([fullPath, readFileSync(fullPath)]);
  }
}, 60_000);
afterAll(() => { if (packedA1Consumer) rmSync(packedA1Consumer, { recursive: true, force: true }); });
function pristinePackedA1Fixture() {
  for (const [path, source] of packedA1Originals) writeFileSync(path, source);
  return packedA1Consumer;
}
it("P3 case 7: actual host binding resolves packed subpaths with no SDK, peers or checkout fallback", () => {
  const consumer = pristinePackedA1Fixture(); assertConsumerIsolation(consumer, root);
  proveA1ReferenceBindingConsumer(consumer, "imports");
  const metadataPath = join(consumer, "node_modules/@openlup/platform/package.json");
  const metadataSource = readFileSync(metadataPath, "utf8");
  for (const entry of ADAPTER_ENTRIES.filter(entry => entry.startsWith("communications/"))) {
    const metadata = JSON.parse(metadataSource); delete metadata.exports["./" + entry];
    try {
      writeFileSync(metadataPath, JSON.stringify(metadata));
      expect(() => proveA1ReferenceBindingConsumer(consumer, "imports"), `P3 missing packed ${entry}`).toThrow(/ERR_PACKAGE_PATH_NOT_EXPORTED/);
    } finally { writeFileSync(metadataPath, metadataSource); }
  }
  const bindingPath = join(consumer, "server/runtime/communications/a1ReferenceBinding.js"), source = readFileSync(bindingPath, "utf8");
  try {
    writeFileSync(bindingPath, source.replace('"@openlup/platform/communications"', JSON.stringify(pathToFileURL(join(root, "packages/platform/dist/communications/index.js")).href)));
    expect(() => proveA1ReferenceBindingConsumer(consumer, "imports")).toThrow(/P3 checkout fallback/);
  } finally { writeFileSync(bindingPath, source); }
  proveA1ReferenceBindingConsumer(consumer, "imports");
});
it("P3 case 8: exact callable selection leaves no default work and uses one existing executor", () => {
  const consumer = pristinePackedA1Fixture(); assertConsumerIsolation(consumer, root);
  proveA1ReferenceBindingConsumer(consumer, "selection");
  const path = join(consumer, "server/runtime/communications/a1ReferenceBinding.js"), source = readFileSync(path, "utf8");
  for (const [before, after, diagnostic] of [
    ['selected?.routes ?? []', 'selected?.routes ?? [{ id: "/unselected", handle: ports.webhook }]', /P3 empty default routes/],
    ['sender.send = guard(sender.send);', 'const originalSend = sender.send; sender.send = guard(async message => { await originalSend(message); return originalSend(message); });', /P3 single sender/],
  ] as const) {
    const changed = source.replace(before, after); expect(changed).not.toBe(source);
    try { writeFileSync(path, changed); expect(() => proveA1ReferenceBindingConsumer(consumer, "selection")).toThrow(diagnostic); }
    finally { writeFileSync(path, source); }
  }
  proveA1ReferenceBindingConsumer(consumer, "selection");
});
// Inventory reference compatibility remains in the repository consumer proof.
import { expectTypeOf } from "vitest";
import { z } from "zod";
import { createInventorySubscriptionForecastResponseSchema, InventoryConflictError, InventoryPersistenceError } from "@openlup/platform/inventory";
import type * as Dto from "@openlup/platform/inventory/contracts";
import * as reference from "../../src/domains/inventory/contracts.js";
import * as referencePorts from "../../src/domains/inventory/ports.js";

const inventoryForecastFixture = {
  contractVersion: "inventory.v0",
  generatedAt: "2026-01-01T00:00:00Z",
  stockMasterProvider: "source-x",
  horizonDays: 60,
  protectionDays: 45,
  skus: [],
  totals: {
    activeSubscriptionCount: 0,
    excludedSubscriptionCount: 0,
    missingProviderStockSkuCount: 0,
    staleProviderStockSkuCount: 0,
    horizonShortageSkuCount: 0,
    protectionShortageSkuCount: 0,
    shortageSkuCount: 0,
    recommendedProductionQty: 0,
  },
};

  it("keeps DTO assignability and compatibility error identities", () => {
    expectTypeOf<Dto.InventoryReservationStatus>().toEqualTypeOf<reference.InventoryReservationStatus>();
    expectTypeOf<Dto.AdminInventoryStockRequest>().toEqualTypeOf<reference.AdminInventoryStockRequest>();
    expectTypeOf<Dto.AdminInventoryReservationsRequest>().toEqualTypeOf<reference.AdminInventoryReservationsRequest>();
    expectTypeOf<Dto.AdminInventoryStockAdjustmentRequest>().toEqualTypeOf<reference.AdminInventoryStockAdjustmentRequest>();
    expectTypeOf<Dto.AdminInventorySubscriptionForecastRequest>().toEqualTypeOf<reference.AdminInventorySubscriptionForecastRequest>();
    expectTypeOf<Dto.InventoryStockListResponse>().toEqualTypeOf<reference.InventoryStockListResponse>();
    expectTypeOf<Dto.InventoryReservationsListResponse>().toEqualTypeOf<reference.InventoryReservationsListResponse>();
    expectTypeOf<Dto.InventoryStockAdjustmentResponse>().toEqualTypeOf<reference.InventoryStockAdjustmentResponse>();
    expectTypeOf<Omit<Dto.InventorySubscriptionForecastResponse, "stockMasterProvider">>().toEqualTypeOf<Omit<reference.InventorySubscriptionForecastResponse, "stockMasterProvider">>();
    expectTypeOf<Dto.InventorySubscriptionForecastResponse["stockMasterProvider"]>().toEqualTypeOf<string>();
    expectTypeOf<Dto.InventorySubscriptionForecastSku>().toEqualTypeOf<reference.InventorySubscriptionForecastSku>();
    expectTypeOf<Dto.InventoryForecastDemandLine>().toEqualTypeOf<reference.InventoryForecastDemandLine>();
    expectTypeOf<Dto.InventoryForecastSupplyLine>().toEqualTypeOf<reference.InventoryForecastSupplyLine>();
    expectTypeOf<Dto.InventoryForecastResponse>().toEqualTypeOf<reference.InventoryForecastResponse>();
    expect(InventoryConflictError).toBe(referencePorts.InventoryConflictError);
    expect(InventoryPersistenceError).toBe(referencePorts.InventoryPersistenceError);
    expect(new InventoryConflictError().message).toBe("Inventory conflict");
    expect(new InventoryPersistenceError().message).toBe("Inventory persistence failed");
  });

  it("preserves fixed reference forecast wire bytes and refuses a substituted provider", () => {
    // The reference literal is pinned by the byte-equality proof; it stays reference-owned.
    const provider = reference.inventorySubscriptionForecastResponseSchema.shape.stockMasterProvider.value;
    const response = { ...inventoryForecastFixture, stockMasterProvider: provider };
    const bytes = '{"contractVersion":"inventory.v0","generatedAt":"2026-01-01T00:00:00Z","stockMasterProvider":' + JSON.stringify(provider) + ',"horizonDays":60,"protectionDays":45,"skus":[],"totals":{"activeSubscriptionCount":0,"excludedSubscriptionCount":0,"missingProviderStockSkuCount":0,"staleProviderStockSkuCount":0,"horizonShortageSkuCount":0,"protectionShortageSkuCount":0,"shortageSkuCount":0,"recommendedProductionQty":0}}';
    expect(JSON.stringify(reference.inventorySubscriptionForecastResponseSchema.parse(response))).toBe(bytes);
    expect(JSON.stringify(createInventorySubscriptionForecastResponseSchema(z.literal(provider)).parse(response))).toBe(bytes);
    expect(reference.inventorySubscriptionForecastResponseSchema.safeParse(inventoryForecastFixture).success).toBe(false);
  });
