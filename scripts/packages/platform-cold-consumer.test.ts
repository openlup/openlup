import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedConsumerEnv } from "./pack-manifest-input.ts";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  proveCommerceServerConsumer,
  provePortabilityConsumer,
  proveAccountSupportReadsConsumer,
  ACCOUNT_SUPPORT_READ_SCENARIOS,
  type AccountSupportReadScenarioResult,
  proveAccountSupportConsumer,
  proveMarketingConsumer,
  proveMarketingServerConsumer,
  compileMarketingAnalyticsConsumer,
  proveCommerceConsumer,
  proveInvoicingConsumer,
  proveSubscriptionsConsumer,
  proveWarehouseAdapterConsumer,
  proveFulfillmentConsumer,
  provePaymentAdapterConsumer,
  provePaymentsConsumer,
  installA1HostBinding,
  proveA1ReferenceBindingConsumer,
  ADAPTER_ENTRIES,
  assertConsumerIsolation,
  assertExportInventory,
  compileConsumer,
  consumerNode,
  NON_ADAPTER_ENTRIES,
  OPTIONAL_PEERS,
  proveAdapterRefusals,
  proveOidcRefusals,
  provePostgresOperations,
  proveNativeCommunicationsOperations,
  proveResendConsumer,
  proveMarketingSyncConsumer,
  runPlatformColdConsumer
} from "./platform-cold-consumer.ts";
import { proveSelfServiceConsumer } from "./platform-cold-consumer.ts";
import { ACCOUNT_SUPPORT_COMPOSITION_PROOFS, proveAccountSupportCompositionConsumer } from "./platform-cold-consumer.ts";

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
  const platformManifest = join(consumer, "node_modules/@openlup/platform/package.json");
  const platformMetadata = JSON.parse(readFileSync(platformManifest, "utf8"));
  platformMetadata.exports["./portability"] = { types: "./portability/index.d.ts", default: "./portability/index.js" };
  platformMetadata.exports["./account-support/contracts"].default = "./contracts.js";
  platformMetadata.exports["./marketing/server"].types = "./marketing-server.d.ts";
  writeFileSync(platformManifest, JSON.stringify(platformMetadata));
  cpSync(join(root, "packages/platform/dist/portability"), join(consumer, "node_modules/@openlup/platform/portability"), { recursive: true });
  writeFileSync(join(consumer, "node_modules/@openlup/platform/contracts.js"), "export {};\n");
  // The server port extends the browser contract with historical commands.
  writeFileSync(join(consumer, "node_modules/@openlup/platform/marketing-server.d.ts"), [
    'import type { AcquisitionCasePort as PortableAcquisitionCasePort } from "./index.js";',
    'export interface AcquisitionCasePort extends PortableAcquisitionCasePort { submit(command: unknown): Promise<unknown>; transition(command: unknown): Promise<unknown> }',
    'export interface AcquisitionCaseDirectDeps { resolveBinding(): Promise<unknown> }',
    'export declare function createAcquisitionCaseHandlers(port: AcquisitionCasePort): unknown;',
    'export declare function createAcquisitionCaseActiveCountDirectHandler(deps: AcquisitionCaseDirectDeps): unknown;',
  ].join("\n") + "\n");
  // The typed consumer registers the payments factory with the composer.
  writeFileSync(join(consumer, "node_modules/@openlup/platform/index.d.ts"), [
    "export interface Synthetic { value: string }",
    'export type AcquisitionCaseListRequest = { view: "acquisition_case_v1"; limit: number; cursor?: string };',
    'export declare const acquisitionCaseListRequestSchema: { parse(value: unknown): AcquisitionCaseListRequest };',
    'export type PrelaunchAcquisitionListRequest = { view: "prelaunch_acquisition_v1"; limit: number; cursor?: string };',
    'export declare const prelaunchAcquisitionListRequestSchema: { parse(value: unknown): PrelaunchAcquisitionListRequest };',
    'export interface AcquisitionCasePort { list(query: { actorRef: string; scope: "public_tester_application"; limit: number }): Promise<unknown> }',
    'export interface AcquisitionEvidencePort { listSurveys(query: { actorReference: string; view: "acquisition_survey_v1"; limit: number }): Promise<unknown> }',
    'export type AcquisitionNewsletterConsentEvent = { explicitOptInEvidence: boolean };',
    'export interface MarketingResearchSurveySubmitPort { submitSurveyResponse(request: { surveyType: "producer" | "consumer"; responseData: Record<string, unknown> }): Promise<unknown> }',
    'export { buildHeadDescriptor } from "./seo/metadata.js";',
    'export { organizationLd } from "./seo/jsonLd.js";',
    'export type * from "./contracts/contactLegal.js";',

    'export { tryCompensate, type CheckoutCompensationPort } from "./commerceCheckoutCompensation.js";',
    "export type NativeOperatorSubscriptionResult = { outcome: 'refused'; refusalCode: 'operator_subscription_authority_unavailable' };",
    "export interface AccountReadPort<A,L,D> { getAccount(userId: string): Promise<A|null>; listOrders(userId: string, input: {limit:number}): Promise<L|null>; getOrderDetail(userId: string, orderId: string): Promise<D|null> }",
    "export declare function createAccountReadFacade<A,L,D>(ports: { account: Pick<AccountReadPort<A,L,D>, 'getAccount'>; orders: Pick<AccountReadPort<A,L,D>, 'listOrders'|'getOrderDetail'> }): AccountReadPort<A,L,D>;",
    "export interface InvoiceAccessPort { resolveDownload(input: {accountRef:string;orderId:string;documentRef:string}): Promise<unknown> }",

    "export interface CommerceOfferAvailabilityRequestItem { sku: string; productSlug: string; variantId: string; requestedQuantity: number; checkoutMode: \"one_time\" | \"subscription\" }",
    "export interface CommerceOfferAvailabilityPort { getAvailability(input: { items: readonly CommerceOfferAvailabilityRequestItem[] }): Promise<unknown[]> }",
    "export declare function offerAvailabilityRequestItems(variants: readonly { sku: string; slug: string; variantId: string }[], checkoutMode: \"one_time\" | \"subscription\"): CommerceOfferAvailabilityRequestItem[];",
    "export type InvoiceSellerRevision = { seller: object; revisionRef: string }; export type InvoiceDocumentIdentity = Synthetic; export type InvoiceProviderPort = Synthetic; export type InvoiceSettlementPort = Synthetic; export type InvoiceSettlementItem = Synthetic; export type InvoiceDutyReadback = Synthetic; export type InvoiceUnsupported = Synthetic; export type InvoiceDiagnosticCode = Synthetic; export type InvoiceProof = Synthetic; export type InvoiceClearanceObservation = Synthetic; export type InvoiceFacts = Synthetic; export type InvoiceLine = Synthetic; export type InvoiceSeller = Synthetic; export type InvoiceBuyer = Synthetic; export type InvoiceIdentity = Synthetic; export type InvoiceWriteResult = Synthetic; export type InvoiceArtifactResult = Synthetic; export type InvoiceSettlementResult = Synthetic; export type InvoiceCompanyLookupPort = Synthetic; export type { InvoiceStorePort } from \"./invoicing-contracts/index.js\"; export type InvoiceHostPorts = Synthetic; export type InvoiceServicesOptions = Synthetic;",
    "export interface InvoiceCapabilities { providerRef: string }",
    "export interface InvoiceReadbackResult { kind: 'absent'; identity: InvoiceIdentity; evidence: { exact: true; complete: true; scope: InvoiceIdentity; evidenceRef: string; fingerprint: string; observedAt: string } }",
    "export interface InvoiceServices { run(operation: string): Promise<unknown> } export declare function createInvoiceServices(input: unknown): InvoiceServices; export declare function createInvoiceContribution(input: unknown): unknown; export declare function claimInvoiceSellerRevision(input: unknown): Promise<unknown>;",
    "export declare function readInvoiceCapabilities(input: unknown): unknown;",
    "export declare function createNativeUnsupportedInvoicePorts(): unknown;",
    "export declare function runInvoiceAdapterConformance(subjects: readonly unknown[]): Promise<unknown>;",
    "export interface FulfillmentServicesOptions {}",
    "export interface FulfillmentServices { runDispatch(): Promise<unknown> }",
    "export declare function createFulfillmentServices(options: FulfillmentServicesOptions): FulfillmentServices;",
    "export declare function createFulfillmentContribution(input: unknown): unknown;",
    "export declare function createPaymentServices(): { run<T>(work: (port: { kind: \"truth\" }) => Promise<T>): Promise<T> } | null;",
    "export declare function createBundleComposer(binders: { blob: () => null; fulfillment?: () => FulfillmentServices | null; payments?: () => { run<T>(work: (port: unknown) => Promise<T>): Promise<T> } | null }): unknown;",
  ].join("\n") + "\n");
  copyFileSync(join(root, "packages/platform/dist/commerce/server/commerceCheckoutCompensation.d.ts"), join(consumer, "node_modules/@openlup/platform/commerceCheckoutCompensation.d.ts"));
  cpSync(join(root, "packages/platform/src/invoicing/contracts"), join(consumer, "node_modules/@openlup/platform/invoicing-contracts"), { recursive: true });
  const platformRoot = join(consumer, "node_modules/@openlup/platform");
  mkdirSync(join(platformRoot, "seo"), { recursive: true });
  for (const file of ["metadata", "jsonLd", "urls"]) copyFileSync(join(root, `packages/platform/dist/marketing/seo/${file}.d.ts`), join(platformRoot, `seo/${file}.d.ts`));
  mkdirSync(join(platformRoot, "contracts"), { recursive: true });
  copyFileSync(join(root, "packages/platform/dist/marketing/contracts/contactLegal.d.ts"), join(platformRoot, "contracts/contactLegal.d.ts"));
  packageFixture(consumer, "zod", { ".": "./index.js" });
  return consumer;
}

it("accepts ordinary confined packages and independently verifies absent peers", () => {
  const consumer = fixture(); assertConsumerIsolation(consumer, root); assertExportInventory(consumer);
  expect(NON_ADAPTER_ENTRIES).toEqual(expect.arrayContaining([
    "invoicing",
    "invoicing/contracts",
    "subscriptions",
    "subscriptions/contracts",
    "fulfillment",
    "fulfillment/contracts",
    "payments",
    "payments/contracts",
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
  const manifestPath = join(consumer, "node_modules/@openlup/platform/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.exports["./marketing/server/postgres"].default = "./postgres.js";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(consumer, "node_modules/@openlup/platform/postgres.js"), 'import "pg";\n');
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
  expect(NON_ADAPTER_ENTRIES).toContain("marketing/server");
  expect(ADAPTER_ENTRIES).not.toContain("marketing/server");
  expect(ADAPTER_ENTRIES).toContain("marketing/server/postgres");
  expect(NON_ADAPTER_ENTRIES).not.toContain("marketing/server/postgres");
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
it("proves installed portability copy/resume and rejects a copy that skips byte publication", () => {
  const consumer = pristinePackedA1Fixture(); assertConsumerIsolation(consumer, root);
  provePortabilityConsumer(consumer);
  const path = join(consumer, "node_modules/@openlup/platform/dist/portability/objects.js");
  const original = readFileSync(path, "utf8");
  const mutant = original.replace("export async function copyTransferObjects(input) {", "export async function copyTransferObjects(input) { return {copied:0,replayed:0,verifiedKeys:[]};");
  expect(mutant).not.toBe(original);
  try {
    writeFileSync(path, mutant);
    expect(() => provePortabilityConsumer(consumer)).toThrow(/installed byte copy must reach verified checkpoint/);
  } finally { writeFileSync(path, original); }
});
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

it("M11 K1 proves installed commerce success and refusal without optional peers", () => {
  const consumer = pristinePackedA1Fixture();
  assertConsumerIsolation(consumer, root);
  proveCommerceConsumer(consumer);
  const serverExports = JSON.parse(consumerNode(consumer, `
const entry = await import("@openlup/platform/commerce/server");
process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(entry).map(([name, value]) => [name, typeof value]))));
`));
  expect(serverExports).toEqual({
    CHECKOUT_RECOVERY_TOKEN_PREFIX: "string",
    EXPIRED_CHECKOUT_RECOVERY_WINDOW_MS: "number",
    ORDER_DRAFT_RPC_NAME: "string",
    ORDER_DRAFT_SUPERSEDE_RPC_NAME: "string",
    cancelAbandonedCheckout: "function",
    cancelUnstartedPromotionCheckout: "function",
    classifyCheckoutRecoveryTokenState: "function",
    createExpiredCheckoutRecoveryPolicy: "function",
    createManagedCommerceRuntimeOrderPort: "function",
    createManagedReservationSweepPort: "function",
    createOrderDraftRpcPayload: "function",
    createOfferAvailabilityPort: "function",
    createCheckoutCompensationRpcAdapter: "function",
    createCommerceCheckoutResumeQueryPort: "function",
    createCommerceOrderDraftRpcPort: "function",
    createConfiguratorIntentPersistenceRpcPort: "function",
    generateCheckoutRecoveryToken: "function",
    hashCheckoutRecoveryToken: "function",
    mapCommerceFinalizeRpcError: "function",
    quotesMatchForRecovery: "function",
    OUTBOX_CHECKOUT_EXPIRED_TEMPLATE_SLUG: "string",
    OUTBOX_ORDER_CONFIRMATION_TEMPLATE_SLUG: "string",
    OUTBOX_ORDER_PAID_TEMPLATE_SLUG: "string",
    OUTBOX_ORDER_REFUNDED_TEMPLATE_SLUG: "string",
    OUTBOX_PAYMENT_FAILED_TEMPLATE_SLUG: "string",
    OUTBOX_RETURN_APPROVED_TEMPLATE_SLUG: "string",
    OUTBOX_RETURN_REJECTED_TEMPLATE_SLUG: "string",
    OUTBOX_SHIPMENT_DELIVERED_TEMPLATE_SLUG: "string",
    OUTBOX_SHIPMENT_DISPATCHED_TEMPLATE_SLUG: "string",
    OUTBOX_SHIPMENT_EXCEPTION_TEMPLATE_SLUG: "string",
    assertOutboxRegistryDescriptors: "function",
    composeOutboxHandlerDescriptors: "function",
    createAdminReturnApproveHandler: "function",
    createAdminReturnRejectHandler: "function",
    createCustomerReturnRequestHandler: "function",
    createOrderReviewAdminHandlers: "function",
    createOrderReviewHandlers: "function",
    createOrderReviewRawUploadHandler: "function",
    createOutboxCheckoutExpiredEmailHandler: "function",
    createOutboxCheckoutRecoveryEmailHandler: "function",
    createOutboxDispatchRegistry: "function",
    createOutboxOrderDraftEmailHandler: "function",
    createOutboxOrderPaidEmailHandler: "function",
    createOutboxOrderPaidFulfillmentHandler: "function",
    createOutboxOrderRefundedEmailHandler: "function",
    createOutboxPaymentFailedEmailHandler: "function",
    createOutboxReturnApprovedEmailHandler: "function",
    createOutboxReturnRejectedEmailHandler: "function",
    createOutboxShipmentDeliveredEmailHandler: "function",
    createOutboxShipmentDispatchedEmailHandler: "function",
    createOutboxShipmentExceptionEmailHandler: "function",
    createPostgresOrderReviewAdminReadPort: "function",
    createPostgresOrderReviewLifecyclePort: "function",
    createPostgresOrderReviewMediaPort: "function",
    createSupabaseCommerceReturnsPort: "function",
    createSupabaseOrderFeedbackSubmitPort: "function",
    createSupabaseOrderFeedbackTokenCheckPort: "function",
    describeCoreOutboxHandlers: "function",
    describeOutboxReturnEmail: "function",
    inspectImageHeader: "function",
    outboxCheckoutExpiredEmailDescriptor: "object",
    outboxCheckoutRecoveryEmailDescriptor: "object",
    outboxOrderDraftEmailDescriptor: "object",
    outboxOrderPaidEmailDescriptor: "object",
    outboxOrderPaidFulfillmentDescriptor: "object",
    outboxOrderRefundedEmailDescriptor: "object",
    outboxPaymentFailedEmailDescriptor: "object",
    outboxReturnApprovedEmailDescriptor: "object",
    outboxReturnRejectedEmailDescriptor: "object",
    outboxShipmentDeliveredEmailDescriptor: "object",
    outboxShipmentDispatchedEmailDescriptor: "object",
    outboxShipmentExceptionEmailDescriptor: "object",
    addCommerceOmsNote: "function",
    authorize: "function",
    buildOmsOrderDetailResponse: "function",
    callOmsRpc: "function",
    createAdminCommerceOrderCancelHandler: "function",
    createAdminCommerceOrderDetailHandler: "function",
    createAdminCommerceOrderHoldHandler: "function",
    createAdminCommerceOrderMarkRefundedHandler: "function",
    createAdminCommerceOrderNoteHandler: "function",
    createAdminCommerceOrderReleaseHoldHandler: "function",
    createAdminCommerceOrderUpdateShippingAddressHandler: "function",
    createAdminCommerceOrdersListHandler: "function",
    createCommerceOmsControlPlaneDetailHandler: "function",
    createCommerceOmsControlPlaneListHandler: "function",
    createManagedCommerceOmsControlPlanePort: "function",
    createManagedCommerceOmsPort: "function",
    distinctIds: "function",
    emptyOmsManagedReadProjections: "object",
    getCommerceOmsOrderDetail: "function",
    getCommerceOmsOrderDetails: "function",
    isOptionalProviderEvidenceColumnError: "function",
    listCommerceOmsOrders: "function",
    mapReplacementRefusal: "function",
    mapRpcError: "function",
    parseOmsRequest: "function",
    readAccountingOutbox: "function",
    readActivePaymentAttempts: "function",
    readFulfillmentOrdersByOrderIds: "function",
    readFulfillmentParcelsByOrderId: "function",
    readOmsInboundEvents: "function",
    readOrderPaidOutboxEvents: "function",
    readQueueSelection: "function",
    readShipmentRefsByOrderId: "function",
    readShipmentRefsByOrderIds: "function",
    sendOmsMutationResponse: "function",
    CHECKOUT_OFFER_VERSION_UNSUPPORTED: "string",
    CheckoutOfferRefusedError: "function",
    CheckoutOrchestrationError: "function",
    ConfiguratorIntentPersistenceConflictError: "function",
    START_RUNTIME_SIMPLE_CONFLICTS: "object",
    buildCheckoutInvoiceBuyerSnapshot: "function",
    checkoutCommandJourney: "function",
    checkoutOrchestrationFailureDetails: "function",
    createCheckoutAdmission: "function",
    createCheckoutClientAction: "function",
    createCheckoutCommandExecutor: "function",
    createCheckoutFailureHandler: "function",
    createCheckoutHandlerHelpers: "function",
    createCheckoutPaymentContinuationCodec: "function",
    createCheckoutProviderAttemptFailure: "function",
    createCheckoutQuoteGuard: "function",
    createCheckoutResumeGuard: "function",
    createCheckoutSavedPaymentMethodResolver: "function",
    createCheckoutStartRuntimeFailure: "function",
    createCheckoutTimingLogger: "function",
    createCommerceCheckoutHandler: "function",
    createCommerceRuntimeService: "function",
    createConfiguratorIntentPersistenceHandler: "function",
    createPaidOrderOrchestration: "function",
    createPromotionPriceChange: "function",
    createReferenceCheckoutHandler: "function",
    createRuntimeStartResponse: "function",
    createSavedAcquisitionContinuation: "function",
    createStarterOfferGuard: "function",
    isJourneyConsumedCheckoutConflict: "function",
    isProviderAttemptInFlightCheckoutConflict: "function",
    isStockUnavailableCheckoutConflict: "function",
    mintCheckoutRefusalContinuation: "function",
    mintPaymentContinuationOnFreshAction: "function",
    providerPayerFromRequest: "function",
    readCheckoutCustomerDefaults: "function",
    readCheckoutCustomerDefaultsOrRespond: "function",
    resolveCheckoutOffer: "function",
    runBestEffortAccountLink: "function",
    safeCommerceDiagnosticValue: "function",
    selectedDeliveryMatches: "function",
    subscriptionResponse: "function",
    withCheckoutOfferContext: "function",
    withStarterPackContext: "function",
    tryCompensate: "function",
    unprojectedOmsReadGate: "object",
    updateCommerceOmsShippingAddress: "function",
  });
});

it("M11 K2 exercises installed commerce compensation without optional peers", () => {
  const consumer = pristinePackedA1Fixture();
  assertConsumerIsolation(consumer, root);
  proveCommerceServerConsumer(consumer);
  for (const name of ["@types/node", "undici-types"]) cpSync(join(root, "node_modules", name), join(consumer, "node_modules", name), { recursive: true });
  compileConsumer(consumer, ["commerce", "commerce/contracts", "commerce/server", "pricing/browser"], join(root, "node_modules/typescript/lib/tsc.js"));
}, 30_000);

it("payments and fulfillment: installed packed consumer proves injected execution, truth scope, fulfillment services, default-off and contribution", () => {
  const consumer = pristinePackedA1Fixture();
  assertConsumerIsolation(consumer, root);
  provePaymentsConsumer(consumer);
  proveFulfillmentConsumer(consumer);
  proveInvoicingConsumer(consumer);
  proveSubscriptionsConsumer(consumer);
  for (const name of ['@types/node', 'undici-types']) cpSync(join(root, 'node_modules', name), join(consumer, 'node_modules', name), { recursive: true });
  compileConsumer(consumer, NON_ADAPTER_ENTRIES, join(root, 'node_modules/typescript/lib/tsc.js'));
  // Hosted runners compile both resolution modes uncached, which can exceed the default floor.
}, 30_000);

it("CI rejects an added required invoice seam field in installed NodeNext and Bundler declarations", () => {
  const consumer = pristinePackedA1Fixture();
  for (const name of ["@types/node", "undici-types"]) cpSync(join(root, "node_modules", name), join(consumer, "node_modules", name), { recursive: true });
  const compiler = join(root, "node_modules/typescript/lib/tsc.js");
  const path = join(consumer, "node_modules/@openlup/platform/dist/invoicing/contracts/store.d.ts");
  const original = readFileSync(path, "utf8");
  // Change a real packed declaration, not the consumer check or its expected key list.
  const mutated = original.replace(/captureDuty\(input: \{/, '$& readonly unmappedRequiredSeamField: string;');
  expect(mutated).not.toBe(original);
  function rejectsMissingField(run: () => void) {
    let failure: unknown;
    try { run(); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ status: 2, stdout: expect.stringContaining("unmappedRequiredSeamField") });
  }
  try {
    writeFileSync(path, mutated);
    rejectsMissingField(() => compileConsumer(consumer, ["invoicing", "invoicing/contracts"], compiler));
    const configPath = join(consumer, "tsconfig.json"), config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.compilerOptions.moduleResolution).toBe("NodeNext");
    config.compilerOptions.module = "ESNext"; config.compilerOptions.moduleResolution = "Bundler";
    writeFileSync(configPath, JSON.stringify(config));
    rejectsMissingField(() => { execFileSync(process.execPath, [compiler, "-p", configPath], { cwd: consumer, encoding: "utf8", stdio: "pipe" }); });
  } finally { writeFileSync(path, original); }
  compileConsumer(consumer, ["invoicing", "invoicing/contracts"], compiler);
}, 30_000);

it("proves both opt-in installed payment adapters without SDK or import-time I/O", () => {
  const consumer = pristinePackedA1Fixture();
  assertConsumerIsolation(consumer, root);
  provePaymentAdapterConsumer(consumer);
});

it("proves the opt-in fulfillment/omnipack entry default-off without SDK, peers or ambient I/O", () => {
  const consumer = pristinePackedA1Fixture();
  assertConsumerIsolation(consumer, root);
  proveWarehouseAdapterConsumer(consumer);
});

it("M10 installed facades and composition prove positive selection, readiness refusal and lifecycle identity", () => {
  const consumer = pristinePackedA1Fixture();
  assertConsumerIsolation(consumer, root);
  for (const name of ["@types/node", "undici-types"]) cpSync(join(root, "node_modules", name), join(consumer, "node_modules", name), { recursive: true });
  const typed = join(consumer, "m10-consumer.ts");
  writeFileSync(typed, 'import type { SubscriptionLifecycleFact } from "@openlup/platform/subscriptions";\nexport type PaymentFailure = Extract<SubscriptionLifecycleFact, { kind: "payment_failed" | "payment_expired" }>;\n');
  const configuration = join(consumer, "tsconfig-m10.json");
  writeFileSync(configuration, JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "NodeNext", target: "ES2022", types: ["node"], typeRoots: [join(consumer, "node_modules/@types")] }, files: [typed] }));
  const compile = () => execFileSync(process.execPath, [join(root, "node_modules/typescript/lib/tsc.js"), "-p", configuration], { cwd: consumer, encoding: "utf8", stdio: "pipe" });
  compile();
  const entry = join(consumer, "node_modules/@openlup/platform/dist/subscriptions/index.d.ts");
  const original = readFileSync(entry, "utf8");
  const mutant = original.replace('export type { SubscriptionLifecycleFact } from "./contracts/messages.js";', "");
  expect(mutant).not.toBe(original);
  try {
    writeFileSync(entry, mutant);
    try { compile(); expect.unreachable("missing public fact export must fail compilation"); }
    catch (error) { expect(String((error as { stdout?: string }).stdout)).toMatch(/TS2724|TS2305/); }
  } finally { writeFileSync(entry, original); }
  compile();
  expect(consumerNode(consumer, `
import assert from "node:assert/strict";
import { createSubscriptionServices, createSubscriptionCommandExamples, createSubscriptionLifecycleMessages, subscriptionLifecycleTemplate, NATIVE_SUBSCRIPTION_CAPABILITIES } from "@openlup/platform/subscriptions";
import { createSubscriptionContribution } from "@openlup/platform/composition";
let effects=0;
const options={capabilities:NATIVE_SUBSCRIPTION_CAPABILITIES,readiness:async()=>({kind:"ready"}),run:async()=>++effects};
assert.deepEqual(await createSubscriptionServices(options).run(),{kind:"refused",code:"disabled"});
assert.equal(effects,0);
assert.deepEqual(await createSubscriptionServices({...options,enabled:true,readiness:async()=>({kind:"refused",code:"schema_unknown"})}).run(),{kind:"refused",code:"schema_unknown"});
assert.equal(effects,0);
const services=createSubscriptionServices({...options,enabled:true});
const contribution=createSubscriptionContribution({version:"0.24.0",requiredSchema:{version:"host-catalogue",migration:"host",objects:[]},run:services.run,cadenceSeconds:60});
assert.equal(contribution.contributions[0].schedules.length,1);
assert.equal(contribution.triggers["@openlup/platform/subscriptions:subscriptions-renewal"],services.run);
assert.equal(await contribution.contributions[0].schedules[0].run(),1);
let received;
const examples=createSubscriptionCommandExamples({capabilities:NATIVE_SUBSCRIPTION_CAPABILITIES,apply:async command=>{received=command;return {outcome:"refused",reason:"subscription_command_payment_blocked"};}});
const context={actor:{kind:"customer",actorId:"actor",clientId:"client"},subscriptionId:"sub",idempotencyKey:"original-key",now:"at"};
assert.equal((await examples.customerSkip(context)).outcome,"refused");
assert.deepEqual(received,{...context,action:"skip",reason:null,confirmedChargeTiming:true});
assert.throws(()=>examples.operatorSlide(context,"later"),/operator_required/);
let descriptor;
const messages=createSubscriptionLifecycleMessages({enqueue:async value=>{descriptor=value;return {notificationId:"m04",replayed:false};}});
const fact={kind:"stock_wait_started",factId:"event",idempotencyKey:"wait:started",subscriptionId:"sub",clientId:"client",cycleId:null,caseId:"case",orderId:null,occurredAt:"at",firstRecordedAt:"at",frozenFingerprint:"frozen"};
const input={fact,messageKey:fact.idempotencyKey,recipientRef:"recipient",locale:"en",recoveryUrlPath:null};
assert.equal((await messages.deliver(input)).notificationId,"m04");
assert.equal(descriptor.templateSlug,"subscription-stock-wait-started");
assert.throws(()=>messages.deliver({...input,messageKey:"changed"}),/identity_mismatch/);
assert.equal(subscriptionLifecycleTemplate("subscription_stock_wait.resumed"),"subscription-stock-wait-resumed");
assert.equal(NATIVE_SUBSCRIPTION_CAPABILITIES.multiCyclePrepaid.supported,false);
console.log("M10 installed positive/refusal passed");
`)).toContain("M10 installed positive/refusal passed");
}, 30_000);

it("M10 packed public renewal parent forwards applied attribution and rejects its omission mutant", () => {
  const consumer = pristinePackedA1Fixture();
  assertConsumerIsolation(consumer, root);
  const proof = `
import assert from "node:assert/strict";
import { executeRenewalCycle } from "@openlup/platform/subscriptions";
let captured;
const failure={resolveClassification:()=>({failureClass:"soft_retryable",decidedBy:"host"}),recordKey:key=>key,applyKey:key=>key,dunningKey:key=>key,preparedSuffix:"/prepared",blockedSuffix:"/blocked",dunningFailureKey:"refused",logBelowRetry(){},logRejected(){},logUnavailable(){}};
const preflight={isOperatorOnly:()=>false,readTotal:()=>2400,cycleKey:()=>"cycle-key",executionKey:()=>"execution-key",intentInput:()=>({}),identity:()=>({providerIdempotencyKey:"provider-key",providerRequestFingerprint:"fingerprint"}),normalizedProvider:value=>value,defaultNow:()=>"at",failure,failed:()=>({outcome:"failed"})};
const deps={deliveryAlignmentAdmission:{allowed:true,state:"clear",reason:"clear"},
 persistence:{buildCycleSnapshots:async()=>({cycleNumber:1,retryAttempt:0,providerAttemptSequence:0,templateSnapshot:{},pricingSnapshot:{},orderSnapshot:{}}),createCycleOrder:async()=>({cycleId:"cycle",orderUuid:"order"})},
 paymentPort:{createIntent:async()=>({paymentIntentId:"intent",replayed:false})},
 chargeFailurePropagation:{recordBlockedPreflightAttempt:async()=>{},readDurableAttemptInstant:async()=>"durable-at",applyFailedResult:async()=>({replayed:true,paymentAttemptId:"durable-attempt-A"}),readCycleRetryState:async()=>({retryAttempt:1,nextRetryAt:null,rowPresent:true}),openDunningCase:async input=>{captured=input;return {status:"opened",caseId:"case"};}}};
await executeRenewalCycle(deps,{subscriptionId:"subscription",nextCycleAt:"at",providerKind:"example",providerMethodRef:"method"},{validateProvider:()=>"provider-blocked",preflight});
assert.equal(captured.failedPaymentAttemptId,"durable-attempt-A");
console.log("packed parent attribution passed");
`;
  expect(consumerNode(consumer, proof)).toContain("packed parent attribution passed");
  const path = join(consumer, "node_modules/@openlup/platform/dist/subscriptions/renewalCycleFailureMechanism.js");
  const original = readFileSync(path, "utf8");
  const mutant = original.replace("        failedPaymentAttemptId,", "");
  expect(mutant).not.toBe(original);
  try {
    writeFileSync(path, mutant);
    expect(() => consumerNode(consumer, proof)).toThrow();
  } finally { writeFileSync(path, original); }
  expect(consumerNode(consumer, proof)).toContain("packed parent attribution passed");
}, 30_000);

it("executes the account-support consumer and detects a swallowed owner refusal", () => {
  const consumer = packedA1Fixture(scratch());
  proveAccountSupportConsumer(consumer);
  const facade = join(consumer, "node_modules/@openlup/platform/dist/account-support/accountReadFacade.js");
  writeFileSync(facade, readFileSync(facade, "utf8").replace(
    "return ports.account.getAccount(userId);", "return ports.account.getAccount(userId).catch(() => null);",
  ));
  expect(() => proveAccountSupportConsumer(consumer)).toThrow();
});

// R2 reuses the existing packed fixture and isolated consumer boundary.
function r2Consumer(): string {
  const consumer = pristinePackedA1Fixture();
  mkdirSync(join(consumer, "node_modules/@types"), { recursive: true });
  for (const name of ["@types/node", "undici-types"]) cpSync(
    join(root, "node_modules", name),
    join(consumer, "node_modules", name),
    { recursive: true }
  );
  assertConsumerIsolation(consumer, root);
  return consumer;
}
// The runtime scenarios execute identical JavaScript under either module mode, so they
// run once; the compiler-mode cases below vary resolution.
let r2Results: AccountSupportReadScenarioResult[] = [];
beforeAll(() => {
  r2Results = proveAccountSupportReadsConsumer(r2Consumer(), { throwOnFailure: false });
}, 60_000);
it.each(ACCOUNT_SUPPORT_READ_SCENARIOS)(
  "R2 installed scenario: %s", name => {
    const result = r2Results.find(result => result.name === name);
    expect(result, JSON.stringify(result, null, 2)).toMatchObject({ name, pass: true });
    expect(result?.comparisons.length).toBeGreaterThan(0);
  }
);
it.each(["NodeNext", "Bundler"] as const)(
  "R2 installed strict owner aliases: %s",
  module => {
    const consumer = pristinePackedA1Fixture();
    writeFileSync(
      join(consumer, "r2.ts"),
      `
import { readCustomerOrderSummaries } from "@openlup/platform/account-support";
import type { InvoiceOwnerAccessPort, InvoiceArtifactDownloadPort } from "@openlup/platform/account-support";
import type { InvoiceHostPorts } from "@openlup/platform/invoicing/contracts";
import type { AccountReadPort, AccountInvoiceHistoryResult } from "@openlup/platform/account-support/contracts";
type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Assert<T extends true>=T;
type Owner=[Assert<Equal<InvoiceOwnerAccessPort,InvoiceHostPorts["accountHistory"]>>,Assert<Equal<InvoiceArtifactDownloadPort,Pick<InvoiceHostPorts["artifacts"],"download">>>];
declare const account: AccountReadPort<unknown,unknown,unknown>;
// @ts-expect-error history remains limit-only
account.listOrders("a",{limit:20,cursor:"private"});
// @ts-expect-error owner refusal is a discriminated union with a stable code
const unsupported: Awaited<ReturnType<InvoiceOwnerAccessPort["read"]>> = {kind:"unsupported",code:"invented",retryable:false,effectMayHaveSucceeded:false};
declare const result: Extract<AccountInvoiceHistoryResult,{kind:"found"}>;
// @ts-expect-error owner documents remain readonly
result.documents.push({});
// @ts-expect-error provider payloads do not belong to browser document DTOs
result.documents[0].providerPayload;
// @ts-expect-error deep implementations are not public exports
import {} from "@openlup/platform/account-support/orderHistory";
void readCustomerOrderSummaries;
`
    );
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ES2022",
        "--module",
        module === "NodeNext" ? "NodeNext" : "ESNext",
        "--moduleResolution",
        module,
        "r2.ts"
      ],
      { cwd: consumer, env: isolatedConsumerEnv(), stdio: "inherit" }
    );
  },
  60_000
);
it.each(["missing export", "foreign order"] as const)(
  "R2 installed witness rejects %s",
  mutation => {
    const consumer = r2Consumer(),
      entry = join(consumer, "node_modules/@openlup/platform/dist/account-support/orderHistory.js"),
      source = readFileSync(entry, "utf8");
    try {
      const changed = mutation === "missing export"
        ? source.replace("export async function readCustomerOrderDetail", "async function readCustomerOrderDetail")
        : source.replace("if (!row)\n        return null;", "if (!row) return { order: {} };");
      expect(changed).not.toBe(source);
      writeFileSync(entry, changed);
      expect(() => proveAccountSupportReadsConsumer(consumer)).toThrow();
    } finally {
      writeFileSync(entry, source);
    }
  },
  60_000
);
it("C11 rejects removal of the envelope-returning self-service callable", () => {
  const consumer = fixture();
  const implementation = readFileSync(join(root, "packages/platform/dist/account-support/selfService.js"), "utf8");
  const mutant = implementation.replace("export function createSelfServiceCommandFacade", "export const createSelfServiceCommandFacade = undefined;\nfunction removedSelfServiceCommandFacade");
  expect(mutant).not.toBe(implementation);
  writeFileSync(join(consumer, "node_modules/@openlup/platform/index.js"), mutant);
  expect(() => proveSelfServiceConsumer(consumer)).toThrow(/self-service factory must be callable/);
});

it("C11 accepts the installed account-support closure with declared module and package edges", () => {
  proveSelfServiceConsumer(pristinePackedA1Fixture());
});

it("C11 refuses an undeclared bare package in installed account-support", () => {
  const consumer = pristinePackedA1Fixture();
  const entry = join(consumer, "node_modules/@openlup/platform/dist/account-support/contracts/index.d.ts");
  const source = readFileSync(entry, "utf8");
  try {
    writeFileSync(entry, source + '\nimport "undeclared-package/subpath";\n');
    expect(() => proveSelfServiceConsumer(consumer)).toThrow(/installed import escapes declared module boundaries: undeclared-package\/subpath/);
  } finally {
    writeFileSync(entry, source);
  }
});

it.each(["js", "d.ts"])("C11 refuses an undeclared module import in installed %s", extension => {
  const consumer = pristinePackedA1Fixture();
  const entry = join(consumer, "node_modules/@openlup/platform/dist/account-support/contracts/index." + extension);
  const source = readFileSync(entry, "utf8");
  try {
    writeFileSync(entry, source + '\nimport "../../subscriptions/index.js";\n');
    expect(() => proveSelfServiceConsumer(consumer)).toThrow(/installed import escapes declared module boundaries: .*subscriptions/);
  } finally {
    writeFileSync(entry, source);
  }
});

it.each(["js", "d.ts"])("C11 refuses nested modules and non-entry files of declared modules in installed %s", extension => {
  const consumer = pristinePackedA1Fixture();
  const entry = join(consumer, "node_modules/@openlup/platform/dist/account-support/contracts/index." + extension);
  const source = readFileSync(entry, "utf8");
  try {
    for (const specifier of ["../../commerce/server/index.js", "../../invoicing/contracts/store.js"]) {
      writeFileSync(entry, source + `\nimport "${specifier}";\n`);
      expect(() => proveSelfServiceConsumer(consumer)).toThrow("installed import escapes declared module boundaries: " + specifier);
    }
  } finally {
    writeFileSync(entry, source);
  }
});

it("C11 refuses an unexported subpath of a declared installed dependency", () => {
  const consumer = pristinePackedA1Fixture();
  const entry = join(consumer, "node_modules/@openlup/platform/dist/account-support/contracts/index.d.ts");
  const source = readFileSync(entry, "utf8");
  try {
    writeFileSync(entry, source + '\nimport "@openlup/core/dist/index.js";\n');
    expect(() => proveSelfServiceConsumer(consumer)).toThrow("installed import escapes declared module boundaries: @openlup/core/dist/index.js");
  } finally {
    writeFileSync(entry, source);
  }
});

function packedR5CompositionFixture() {
  const consumer = pristinePackedA1Fixture();
  for (const name of ["@types/node", "undici-types"]) cpSync(join(root, "node_modules", name), join(consumer, "node_modules", name), { recursive: true });
  return consumer;
}

it.each(ACCOUNT_SUPPORT_COMPOSITION_PROOFS)("K1 proves packed account-support composition: %s", proof => {
  const consumer = packedR5CompositionFixture();
  assertConsumerIsolation(consumer, root);
  proveAccountSupportCompositionConsumer(consumer, join(root, "node_modules/typescript/lib/tsc.js"), proof);
}, 30_000);

it.each(["export", "delegate"] as const)("K2 rejects the packed R5 %s corruption", corruption => {
  const consumer = packedR5CompositionFixture(), packageRoot = join(consumer, "node_modules/@openlup/platform");
  const path = join(packageRoot, corruption === "export" ? "dist/account-support/index.d.ts" : "dist/account-support/contribution.js");
  const original = readFileSync(path, "utf8");
  const mutant = corruption === "export" ? original.replace('export { createAccountSupportBindings } from "./bindings.js";', "")
    : original.replace("operation(...args)", "undefined");
  expect(mutant).not.toBe(original);
  try {
    writeFileSync(path, mutant);
    expect(() => proveAccountSupportCompositionConsumer(consumer, join(root, "node_modules/typescript/lib/tsc.js"), corruption === "export" ? "NodeNext" : "ready"))
      .toThrow(corruption === "export" ? /TS(?:2305|2724)/ : /R5 selected delegate must execute/);
  } finally { writeFileSync(path, original); }
}, 30_000);

it("proves installed marketing subpaths, prelaunch schemas, reachable ports and deep-import refusal without optional peers", () => {
  const consumer = pristinePackedA1Fixture();
  assertConsumerIsolation(consumer, root);
  proveMarketingConsumer(consumer);
  for (const name of ["@types/node", "undici-types"]) cpSync(join(root, "node_modules", name), join(consumer, "node_modules", name), { recursive: true });
  compileMarketingAnalyticsConsumer(consumer, join(root, "node_modules/typescript/lib/tsc.js"));
  compileConsumer(consumer, ["marketing", "marketing/contracts"], join(root, "node_modules/typescript/lib/tsc.js"));
}, 60_000);

it("proves installed marketing server reads, port refusal, default-off privacy and exact exports without optional peers", () => {
  const consumer = pristinePackedA1Fixture();
  assertConsumerIsolation(consumer, root);
  proveMarketingServerConsumer(consumer);
  for (const name of ["@types/node", "undici-types"]) cpSync(join(root, "node_modules", name), join(consumer, "node_modules", name), { recursive: true });
  compileConsumer(consumer, ["marketing/server"], join(root, "node_modules/typescript/lib/tsc.js"));
}, 30_000);
