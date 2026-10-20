import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { ADAPTER_ENTRIES, assertConsumerIsolation, assertExportInventory, compileConsumer, consumerNode, NON_ADAPTER_ENTRIES, OPTIONAL_PEERS, proveAdapterRefusals, proveOidcRefusals, provePostgresOperations, proveNativeCommunicationsOperations, runPlatformColdConsumer } from "./platform-cold-consumer.ts";

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
  expect(NON_ADAPTER_ENTRIES).toContain("catalog");
  expect(NON_ADAPTER_ENTRIES).toContain("pricing");
  expect(NON_ADAPTER_ENTRIES).toContain("pricing/contracts");
  expect(NON_ADAPTER_ENTRIES).toContain("catalog/contracts");
  expect(NON_ADAPTER_ENTRIES).toContain("identity/contracts");
  expect(ADAPTER_ENTRIES).toContain("identity");
  expect(NON_ADAPTER_ENTRIES).toContain("communications/contracts");
  expect(ADAPTER_ENTRIES).toContain("communications");
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
