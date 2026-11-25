import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedConsumerEnv } from "./pack-manifest-input.ts";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  platformConsumerInstallArgs,
  starterDependencyMatchesPlatform,
  proveRiskConsumer,
  RISK_WORKFLOW_PROOFS,
  proveRiskWorkflowConsumer,
  proveCommerceServerConsumer,
  provePortabilityConsumer,
  proveLifecycleConsumer,
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
  installPartnerAcquisitionHostBinding,
  provePartnerAcquisitionBindingConsumer,
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
  proveCommunicationsConsumer,
  catalogMigrationExpectations,
  proveCatalogCompositionConsumer,
  proveCatalogConformanceConsumer,
  runPlatformColdConsumer
} from "./platform-cold-consumer.ts";
import { proveSelfServiceConsumer, proveSavedAddressFormatsConsumer } from "./platform-cold-consumer.ts";
import { ACCOUNT_SUPPORT_COMPOSITION_PROOFS, proveAccountSupportCompositionConsumer } from "./platform-cold-consumer.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary: string[] = [];
it.each([
  { name: "musl refuses glibc", manifest: { libc: ["musl"] }, os: "linux", cpu: "x64", libc: "glibc", matches: false },
  { name: "glibc refuses musl", manifest: { libc: ["glibc"] }, os: "linux", cpu: "arm64", libc: "musl", matches: false },
  { name: "matching native platform", manifest: { os: ["linux"], cpu: ["x64"], libc: ["glibc"] }, os: "linux", cpu: "x64", libc: "glibc", matches: true },
  { name: "Linux refuses Darwin", manifest: { os: ["linux"] }, os: "darwin", cpu: "arm64", matches: false },
  { name: "CPU mismatch", manifest: { cpu: ["x64"] }, os: "linux", cpu: "arm64", libc: "glibc", matches: false },
  { name: "negated OS refuses", manifest: { os: ["!win32"] }, os: "win32", cpu: "x64", matches: false },
  { name: "negated OS permits another", manifest: { os: ["!win32"] }, os: "darwin", cpu: "arm64", matches: true },
  { name: "negative overrides positive", manifest: { os: ["linux", "!linux"] }, os: "linux", cpu: "x64", matches: false },
  { name: "positive choice still required", manifest: { cpu: ["x64", "!ia32"] }, os: "linux", cpu: "arm64", matches: false },
  { name: "negated libc refuses", manifest: { libc: ["!glibc"] }, os: "linux", cpu: "x64", libc: "glibc", matches: false },
  { name: "non-Linux ignores libc", manifest: { libc: ["musl"] }, os: "darwin", cpu: "arm64", matches: true },
  { name: "absent constraints", manifest: {}, os: "linux", cpu: "x64", libc: "glibc", matches: true },
  { name: "any constraint", manifest: { cpu: ["any"] }, os: "linux", cpu: "arm64", matches: true },
  { name: "normalized string constraint", manifest: { os: "linux" }, os: "darwin", cpu: "arm64", matches: false },
])("filters only optional installed manifests: $name", ({ manifest, os, cpu, libc, matches }) => {
  const target = { os, cpu, libc };
  expect(starterDependencyMatchesPlatform(manifest, true, target)).toBe(matches);
  expect(starterDependencyMatchesPlatform(manifest, false, target)).toBe(true);
});

it("applies the three-day release age only to the network install", () => {
  const packages = ["/packs/platform.tgz", "pg@8.21.0"];
  const common = ["--ignore-scripts", "--omit=optional", "--legacy-peer-deps", "--no-audit", "--fund=false", ...packages];
  expect(platformConsumerInstallArgs(packages, true)).toEqual(["install", "--prefer-offline", "--min-release-age=3", ...common]);
  expect(platformConsumerInstallArgs(packages)).toEqual(["install", "--offline", ...common]);
  expect(platformConsumerInstallArgs(packages, false)).toEqual(["install", "--offline", ...common]);
});

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
  packageFixture(consumer, "@openlup/core", {
    ".": "./index.js", "./payment": "./payment.js", "./pricing": { types: "./pricing.d.ts", default: "./index.js" },
    "./readiness": { types: "./readiness.d.ts", default: "./readiness.js" },
  });
  cpSync(join(root, "packages/core/dist/pricing/commerceMoneyV2.d.ts"), join(consumer, "node_modules/@openlup/core/pricing.d.ts"));
  writeFileSync(join(consumer, "node_modules/@openlup/core/payment.js"), "export {};\n");
  writeFileSync(join(consumer, "node_modules/@openlup/core/payment.d.ts"), "export type PaymentIntentStatus = 'paid';\n");
  writeFileSync(join(consumer, "node_modules/@openlup/core/readiness.js"), 'export async function checkReadiness() { throw new Error("synthetic readiness is import-only"); }\n');
  writeFileSync(join(consumer, "node_modules/@openlup/core/readiness.d.ts"), [
    'export type ReadinessInput = unknown;',
    'export interface ReadinessIssue { code: string }',
    'export interface ReadinessReport { state: "unknown"; candidate: unknown; loadedPackages: readonly unknown[]; issues: readonly ReadinessIssue[] }',
    'export type RequiredSchema = unknown;',
    'export type SchemaObservation = unknown;',
    'export declare function checkReadiness(input: ReadinessInput): Promise<ReadinessReport>;',
  ].join("\n") + "\n");
  packageFixture(consumer, "@openlup/platform", Object.fromEntries([...NON_ADAPTER_ENTRIES, ...ADAPTER_ENTRIES].map(name => [`./${name}`, { types: "./index.d.ts", default: "./index.js" }])));
  const platformManifest = join(consumer, "node_modules/@openlup/platform/package.json");
  const platformMetadata = JSON.parse(readFileSync(platformManifest, "utf8"));
  platformMetadata.exports["./portability"] = { types: "./portability/index.d.ts", default: "./portability/index.js" };
  platformMetadata.exports["./lifecycle"] = { types: "./lifecycle/index.d.ts", default: "./lifecycle/index.js" };
  platformMetadata.exports["./commerce/server/destinations"].types = "./commerce/server/destinations/index.d.ts";
  platformMetadata.exports["./account-support/contracts"].default = "./contracts.js";
  platformMetadata.exports["./marketing/server"].types = "./marketing-server.d.ts";
  writeFileSync(platformManifest, JSON.stringify(platformMetadata));
  cpSync(join(root, "packages/platform/dist/portability"), join(consumer, "node_modules/@openlup/platform/portability"), { recursive: true });
  cpSync(join(root, "packages/platform/dist/lifecycle"), join(consumer, "node_modules/@openlup/platform/lifecycle"), { recursive: true });
  for (const entry of ["commerce/contracts", "commerce/server/destinations"]) {
    cpSync(join(root, "packages/platform/dist", entry), join(consumer, "node_modules/@openlup/platform", entry), { recursive: true });
  }
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
    'export type TaxQuoteInputV1 = Synthetic;',
    'export type TaxQuoteRequestV1 = { key: string; input: TaxQuoteInputV1 };',
    'export interface TaxCalculationPort { quote(request: TaxQuoteRequestV1): Promise<unknown> }',
    'export type LocalRateTableOptionsV1 = Synthetic;',
    'export type TaxConformanceSubjectV1 = Synthetic;',
    'export type StripeTaxAdapterOptions = Synthetic;',
    'export declare function createStripeTaxAdapter(options: StripeTaxAdapterOptions): TaxCalculationPort;',
    'export declare function localRateTable(options: LocalRateTableOptionsV1): TaxCalculationPort;',
    'export declare function runTaxAdapterConformance(subject: TaxConformanceSubjectV1): Promise<readonly string[]>;',
    'export declare function makeTaxQuoteRequest(key: string, input: TaxQuoteInputV1): TaxQuoteRequestV1;',
    'export declare const taxQuoteRequestV1Schema: { parse(value: unknown): TaxQuoteRequestV1 };',
    'export type PartnerAcquisitionListRequest = { view: "partner_acquisition_v1"; limit: number; cursor?: string };',
    'export type PartnersB2BInquirySubmitRequest = { company: string; country: string; firstName: string; lastName: string; email: string; phone?: string | null; notes?: string | null; openlupInternalCheck?: string };',
    'export declare const partnerAcquisitionListRequestSchema: { parse(value: unknown): PartnerAcquisitionListRequest };',
    'export declare const partnersB2BInquirySubmitRequestSchema: { parse(value: unknown): PartnersB2BInquirySubmitRequest };',
    'export interface PartnerAcquisitionPort { list(query: PartnerAcquisitionListRequest & { actorRef: string }): Promise<unknown>; submit(command: { request: PartnersB2BInquirySubmitRequest; idempotencyKey: string; requesterKey: string; policyVersion: string; sourcePath: "/partners/b2b-inquiries"; acceptedAt: string }): Promise<unknown>; transition(command: { actorRef: string; idempotencyKey: string; request: { id: string; expectedVersion: number; status: "contacted" | "qualified" | "disqualified" | "closed_won" | "closed_lost" } }): Promise<unknown>; close(): Promise<void> }',
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
    'export type DbBackedCommerceQuotePortV2Deps = Synthetic; export type QuoteOwnerContext = Synthetic; export type CommerceQuoteV2Request = Synthetic; export type QuoteOutcome = Synthetic;',
    'export interface CommerceQuotePortV2 { createQuote(owner: QuoteOwnerContext, request: CommerceQuoteV2Request): Promise<QuoteOutcome> }',
    'export declare function createDbBackedCommerceQuotePortV2(deps: DbBackedCommerceQuotePortV2Deps): CommerceQuotePortV2;',
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
  writeFileSync(join(consumer, "node_modules/zod/index.d.ts"), "export namespace z { export interface ZodType<Output, Input = unknown> { parse(input: Input): Output } }\n");
  return consumer;
}

it("accepts ordinary confined packages and independently verifies absent peers", () => {
  const consumer = fixture(); assertConsumerIsolation(consumer, root); assertExportInventory(consumer);
  expect(NON_ADAPTER_ENTRIES).toEqual(expect.arrayContaining([
    "channels",
    "channels/contracts",
    "channels/server",
    "invoicing",
    "invoicing/contracts",
    "subscriptions",
    "subscriptions/contracts",
    "fulfillment",
    "fulfillment/contracts",
    "payments",
    "payments/contracts",
    "payments/testing",
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
const channelEntries = ["channels", "channels/contracts", "channels/server"] as const;
function channelFixture(entries: readonly string[]) {
  const consumer = fixture(), path = join(consumer, "node_modules/@openlup/platform/package.json");
  const metadata = JSON.parse(readFileSync(path, "utf8"));
  for (const entry of channelEntries) delete metadata.exports[`./${entry}`];
  for (const entry of entries) metadata.exports[`./${entry}`] = { types: "./channel.d.ts", default: "./channel.js" };
  writeFileSync(path, JSON.stringify(metadata));
  const platform = dirname(path);
  writeFileSync(join(platform, "channel.js"), "export {};\n");
  writeFileSync(join(platform, "channel.d.ts"), "export {};\n");
  const nodeTypes = join(consumer, "node_modules/@types/node"); mkdirSync(nodeTypes, { recursive: true });
  writeFileSync(join(nodeTypes, "index.d.ts"), "export {};\n");
  return consumer;
}
it("refuses absent channel exports after the landing window", () => {
  expect(() => assertExportInventory(channelFixture([]))).toThrow(/inventory needs classification/);
});
it("includes the complete channel group in runtime imports and both declaration modes", () => {
  const consumer = channelFixture(channelEntries), entries = assertExportInventory(consumer);
  expect(entries.filter(entry => channelEntries.includes(entry as typeof channelEntries[number]))).toEqual(channelEntries);
  for (const entry of entries) consumerNode(consumer, `await import("@openlup/platform/${entry}");`);
  const compiler = join(root, "node_modules/typescript/bin/tsc");
  compileConsumer(consumer, entries, compiler);
  const platform = join(consumer, "node_modules/@openlup/platform");
  writeFileSync(join(platform, "channel.js"), 'throw new Error("channel initialization refused");\n');
  for (const entry of channelEntries) expect(() => consumerNode(consumer, `await import("@openlup/platform/${entry}");`)).toThrow(/channel initialization refused/);
  writeFileSync(join(platform, "channel.d.ts"), 'import type { Pool } from "pg"; export type Leaked = Pool;\n');
  expect(() => compileConsumer(consumer, entries, compiler)).toThrow();
}, 45_000);
it.each(channelEntries)("refuses a partial channel group missing %s", missing => {
  expect(() => assertExportInventory(channelFixture(channelEntries.filter(entry => entry !== missing)))).toThrow(/inventory needs classification/);
});
it.each(channelEntries)("refuses a partial channel group containing only %s", entry => {
  expect(() => assertExportInventory(channelFixture([entry]))).toThrow(/inventory needs classification/);
});
it("refuses an unknown export beside the complete channel group", () => {
  expect(() => assertExportInventory(channelFixture([...channelEntries, "channels/unknown"])) ).toThrow(/inventory needs classification/);
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
  writeFileSync(join(consumer, "node_modules/@openlup/platform/postgres.js"), `
async function fail(peer) {
  if (${JSON.stringify(mode)} === "success") return;
  const cause = Object.assign(new Error("synthetic missing peer"), { code: "ERR_MODULE_NOT_FOUND" });
  const message = ${JSON.stringify(mode)} === "raw" ? "raw module failure" : "OPENLUP_E_PEER_MISSING: " + (${JSON.stringify(mode)} === "wrong-peer" ? "wrong-package" : peer) + " is required by synthetic capability";
  throw new Error(message, ${JSON.stringify(mode)} === "no-cause" ? undefined : { cause });
}
export const createPostgresAcquisitionCasePort = () => ({ activeCount: () => fail("pg"), close: async () => {} });
export const createPostgresAcquisitionEvidencePort = () => ({ listSurveys: () => fail("pg"), close: async () => {} });
export const createPostgresPartnerAcquisitionPort = () => ({ list: () => fail("pg"), close: async () => {} });
`);
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
  const declaration = join(consumer, "node_modules/@openlup/platform/index.d.ts");
  writeFileSync(declaration, readFileSync(declaration, "utf8") + 'import type { Pool } from "pg"; export type Leaked = Pool;\n');
  expect(() => compileConsumer(consumer, NON_ADAPTER_ENTRIES, compiler)).toThrow(expect.objectContaining({
    status: 2, stdout: expect.stringContaining("error TS2307: Cannot find module 'pg'"),
  }));
}, 35_000);
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
  const entry = "communications/klaviyo";
  cpSync(join(root, "packages/platform/dist", entry), join(packageRoot, entry), { recursive: true });
  copyFileSync(join(root, "packages/platform/dist/communications/ecommerceEvents.js"), join(packageRoot, "communications/ecommerceEvents.js"));
  cpSync(join(root, "node_modules/zod"), join(consumer, "node_modules/zod"), { recursive: true });
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
      .toThrow(mode === "extra-export" ? /P2 packed\/built export parity/ : /P2 installed pending account evidence/);
  }
  for (const mode of ["extra-export", "raw-bypass"] as const) {
    expect(() => proveResendConsumer(resendFixture(mode)), `I02 ${mode}: named invariant assertion`)
      .toThrow(mode === "raw-bypass" ? /AssertionError.*I02 blocked\/drop zero POST/s : /AssertionError.*I02 packed\/built export parity/s);
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
it("checks the packed inert catalogue skeleton and reports unavailable content evidence", () => {
  proveCatalogConformanceConsumer(pristinePackedA1Fixture());
});

const descriptorPath = "packages/platform/src/catalog/sql.ts";
const selectedPath = "db/platform/migrations/20260102000000_selected.sql";
const selectedDigest = "a".repeat(64);
const descriptorManifest = {
  baseline: { file: "db/platform/migrations/00000000000000_platform_baseline.sql", sha256: "b".repeat(64) },
  forward: [{ file: selectedPath, sha256: selectedDigest }],
};
const descriptorEntry = JSON.stringify({ catalogPath: selectedPath, position: 1, sha256: selectedDigest });
const descriptorSelection = `export const CATALOG_MIGRATIONS = [${descriptorEntry}] as const;`;

it.each([
  ["position disagrees", descriptorSelection.replace('"position":1', '"position":9'), `${selectedPath} position differs from the canonical manifest. Set position to 1`],
  ["digest disagrees", descriptorSelection.replace(selectedDigest, "0".repeat(64)), `${selectedPath} sha256 differs from the canonical manifest. Set sha256 to ${selectedDigest}`],
  ["invalid syntax", descriptorSelection + " const = ;", "does not evaluate:"],
  ["missing array", "export const CATALOG_MIGRATIONS = {};", "does not evaluate: export CATALOG_MIGRATIONS as an array"],
  ["extra comma", `export const CATALOG_MIGRATIONS = [${descriptorEntry},,];`, "does not evaluate: CATALOG_MIGRATIONS[1] must be an object with a string catalogPath, a numeric position and a string sha256. To fix it, remove the extra comma or restore the entry"],
  ["commented-out selection", `export const CATALOG_MIGRATIONS = [/* ${descriptorEntry} */];`, "empty CATALOG_MIGRATIONS selection. Restore at least one migration entry"],
  ["duplicate path", `export const CATALOG_MIGRATIONS = [${descriptorEntry},${descriptorEntry}];`, `duplicate path ${selectedPath}. Remove the repeated entry`],
  ["unmanifested path", descriptorSelection.replace("selected.sql", "unknown.sql"), `${selectedPath.replace("selected.sql", "unknown.sql")} is absent from the canonical manifest. Select a path from config/platform-migration-manifest.json`],
  ["unsupported import", 'import "node:path";\n' + descriptorSelection, "does not evaluate: unsupported import node:path. Extend the catalogue descriptor stub map"],
])("refuses the committed catalogue descriptor when %s", (_name, descriptor, diagnostic) => {
  const separator = diagnostic.startsWith("does not evaluate:") ? " " : ": ";
  expect(() => catalogMigrationExpectations(descriptor, descriptorManifest))
    .toThrow(`committed ${descriptorPath}${separator}${diagnostic}`);
});

it("evaluates the selected getter against the exact manifest tuple and ignores commented entries", () => {
  const descriptor = `import { packagedPlatformMigrationPosition } from "../migrations/index.js";
export const CATALOG_MIGRATIONS = [
  // ${descriptorEntry},
  { catalogPath: "${selectedPath}", sha256: "${selectedDigest}", get position() { return packagedPlatformMigrationPosition(this.catalogPath, this.sha256); } },
] as const;`;
  expect(catalogMigrationExpectations(descriptor, descriptorManifest)).toEqual([
    { catalogPath: selectedPath, position: 1, sha256: selectedDigest },
  ]);
  expect(() => catalogMigrationExpectations(descriptor.replaceAll(selectedDigest, "0".repeat(64)), descriptorManifest))
    .toThrow(`committed ${descriptorPath} does not evaluate: no canonical path and SHA-256 match for ${selectedPath}`);
});

it.each([
  ["missing", "CATALOG_MIGRATIONS.pop();"],
  // The added descriptor must leave the import-time manifest probe untouched.
  ["extra", "CATALOG_MIGRATIONS.push({ ...CATALOG_MIGRATIONS[0], position: Number.MAX_SAFE_INTEGER });"],
  ["reordered", "CATALOG_MIGRATIONS.reverse();"],
  ["catalogPath getter masks wrong position", `
const unit = CATALOG_MIGRATIONS[0];
const { catalogPath, position } = unit;
unit.position = 999;
Object.defineProperty(unit, "catalogPath", { get() { unit.position = position; return catalogPath; } });
`],
])("refuses packed catalogue migrations differing from the committed canonical manifest: %s", (_name, mutation) => {
  const consumer = pristinePackedA1Fixture();
  const path = join(consumer, "node_modules/@openlup/platform/dist/catalog/sql.js");
  const original = readFileSync(path, "utf8");
  proveCatalogCompositionConsumer(consumer);
  try {
    writeFileSync(path, original + "\n" + mutation);
    expect(() => proveCatalogCompositionConsumer(consumer)).toThrow(/installed catalogue migrations differ from the committed canonical manifest/);
  } finally { writeFileSync(path, original); }
});

it.each([
  ["sync", 'import { readFileSync } from "node:fs"; readFileSync(new URL("../../sql/manifest.json", import.meta.url));'],
  ["promises", 'import { readFile } from "node:fs/promises"; await readFile(new URL("../../sql/manifest.json", import.meta.url));'],
])("refuses an import-time packaged SQL manifest read via %s", (_name, mutation) => {
  const consumer = pristinePackedA1Fixture();
  const path = join(consumer, "node_modules/@openlup/platform/dist/catalog/index.js");
  const manifestPath = join(consumer, "node_modules/@openlup/platform/sql/manifest.json");
  const original = readFileSync(path, "utf8");
  const manifest = readFileSync(manifestPath);
  try {
    writeFileSync(path, original + "\n" + mutation);
    expect(() => proveCatalogCompositionConsumer(consumer)).toThrow(/presence-only import failed without the packaged SQL manifest/);
    expect(readFileSync(manifestPath)).toEqual(manifest);
  } finally { writeFileSync(path, original); }
});

it.each([
  ["wrong position only with manifest present", "if (manifestPresent) migrations[0].position = 999;", /installed catalogue migrations differ from the committed canonical manifest[\s\S]*\+ +999,/u],
  ["different wrong positions with and without manifest", "migrations[0].position = manifestPresent ? 999 : 998;", /installed catalogue migrations differ from the committed canonical manifest[\s\S]*\+ +999,/u],
  ["initialization throws only with manifest present", 'if (manifestPresent) throw new Error("synthetic present-manifest initialization failed");', /Error: synthetic present-manifest initialization failed/u],
])("checks normal packed catalogue initialization in a fresh process: %s", (_name, mutation, diagnostic) => {
  const consumer = pristinePackedA1Fixture();
  const path = join(consumer, "node_modules/@openlup/platform/dist/catalog/index.js");
  const original = readFileSync(path, "utf8");
  try {
    writeFileSync(path, original + `
import { existsSync } from "node:fs";
import { CATALOG_MIGRATIONS as migrations } from "./sql.js";
const manifestPresent = existsSync(new URL("../../sql/manifest.json", import.meta.url));
${mutation}
`);
    expect(() => proveCatalogCompositionConsumer(consumer)).toThrow(diagnostic);
  } finally { writeFileSync(path, original); }
});

it.each(["literal", "getter"] as const)("refuses stale packed SQL with a matching SHA-256 %s", digestKind => {
  const consumer = pristinePackedA1Fixture();
  const platform = join(consumer, "node_modules/@openlup/platform");
  const descriptor = join(platform, "dist/catalog/sql.js");
  const sql = join(platform, "sql/20260807140000_read_parity_catalog.sql");
  const originalDescriptor = readFileSync(descriptor, "utf8");
  const originalSql = readFileSync(sql, "utf8");
  const staleSql = originalSql + "\n-- Different packed bytes\n";
  const staleDigest = createHash("sha256").update(staleSql).digest("hex");
  const mutation = digestKind === "literal" ? `CATALOG_MIGRATIONS[0].sha256 = "${staleDigest}";` : `
const unit = CATALOG_MIGRATIONS[0];
const canonicalDigest = unit.sha256;
let reads = 0;
Object.defineProperty(unit, "sha256", { get() { return reads++ === 0 ? canonicalDigest : "${staleDigest}"; } });
`;
  const diagnostic = digestKind === "literal"
    ? /installed catalogue migrations differ from the committed canonical manifest/u
    : /Expected values to be strictly equal:/u;
  try {
    writeFileSync(sql, staleSql);
    writeFileSync(descriptor, originalDescriptor + "\n" + mutation);
    expect(() => proveCatalogCompositionConsumer(consumer)).toThrow(diagnostic);
  } finally {
    writeFileSync(descriptor, originalDescriptor);
    writeFileSync(sql, originalSql);
  }
});

it("refuses a missing catalogue read port before a lazy catalogPath getter fills the cache", () => {
  const consumer = pristinePackedA1Fixture();
  const dist = join(consumer, "node_modules/@openlup/platform/dist");
  const descriptor = join(dist, "catalog/sql.js");
  const composer = join(dist, "composition/catalogContribution.js");
  const originalDescriptor = readFileSync(descriptor, "utf8");
  const originalComposer = readFileSync(composer, "utf8");
  const mutant = originalComposer.replace("return { contributions, ports, routes };",
    'if (cachedCatalogPath === undefined) delete ports["@openlup/platform/catalog:read"];\n    return { contributions, ports, routes };');
  expect(mutant).not.toBe(originalComposer);
  try {
    writeFileSync(descriptor, originalDescriptor + `
export let cachedCatalogPath;
const unit = CATALOG_MIGRATIONS[0], catalogPath = unit.catalogPath;
Object.defineProperty(unit, "catalogPath", { get() { return cachedCatalogPath ??= catalogPath; } });
`);
    writeFileSync(composer, 'import { cachedCatalogPath } from "../catalog/sql.js";\n' + mutant);
    expect(() => proveCatalogCompositionConsumer(consumer)).toThrow(/Expected values to be strictly equal:[\s\S]*\+ undefined\s*\n- \[AsyncFunction: getSkuEnvelope\]/u);
  } finally {
    writeFileSync(descriptor, originalDescriptor);
    writeFileSync(composer, originalComposer);
  }
});

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
it("proves installed app-file upgrade and refuses a no-op apply implementation", () => {
  const consumer = pristinePackedA1Fixture(); assertConsumerIsolation(consumer, root);
  proveLifecycleConsumer(consumer);
  const path = join(consumer, "node_modules/@openlup/platform/dist/lifecycle/appUpgrade.js");
  const original = readFileSync(path, "utf8");
  const mutant = original.replace("export async function applyAppUpgrade(input) {", "export async function applyAppUpgrade(input) { return {plan:await planAppUpgrade(input),applied:[]};");
  expect(mutant).not.toBe(original);
  try {
    writeFileSync(path, mutant);
    expect(() => proveLifecycleConsumer(consumer)).toThrow();
  } finally { writeFileSync(path, original); }
});
it("refuses an installed legacy-role observer that admits a superuser blocker", () => {
  const consumer = pristinePackedA1Fixture(); assertConsumerIsolation(consumer, root);
  const path = join(consumer, "node_modules/@openlup/platform/dist/lifecycle/postgresInstallQualification.js");
  const original = readFileSync(path, "utf8");
  const mutant = original.replace("rolePrerequisitesMet: blockers.length === 0", "rolePrerequisitesMet: true");
  expect(mutant).not.toBe(original);
  try {
    writeFileSync(path, mutant);
    expect(() => proveLifecycleConsumer(consumer)).toThrow(/installed role observation must retain superuser refusal/);
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
  expect(consumerNode(consumer, `
const entry = await import("@openlup/platform/fulfillment");
process.stdout.write(typeof entry.FulfillmentStockReplayConflictError);
`)).toBe("function");
  const serverExports = JSON.parse(consumerNode(consumer, `
const entry = await import("@openlup/platform/commerce/server");
process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(entry).map(([name, value]) => [name, typeof value]))));
`));
  expect(serverExports).toEqual({
    CHECKOUT_RECOVERY_TOKEN_PREFIX: "string",
    CheckoutRecoveryScheduleChangeBlockedError: "function",
    EXPIRED_CHECKOUT_RECOVERY_WINDOW_MS: "number",
    ORDER_DRAFT_RPC_NAME: "string",
    ORDER_DRAFT_SUPERSEDE_RPC_NAME: "string",
    bindCommerceMoneyLimitsV2Reader: "function",
    createDbBackedCommerceQuotePortV2: "function",
    describeCommerceMoneyLimitsV2Setting: "function",
    inspectCommerceMoneyLimitsV2: "function",
    installCommerceMoneyLimitsV2: "function",
    installCheckoutRecoveryReminderSchedule: "function",
    readCheckoutRecoveryReminderSchedule: "function",
    readCheckoutRecoveryReminderObservation: "function",
    cancelAbandonedCheckout: "function",
    cancelUnstartedPromotionCheckout: "function",
    catalogAdmissionRefusal: "function",
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
    createPostgresCheckoutRecoveryTokenPort: "function",
    createPostgresCheckoutRecoveryWaves: "function",
    createAdminCheckoutPaymentLinkHandler: "function",
    createPostgresOperatorCheckoutLinkStore: "function",
    createCheckoutRecoveryStartHandler: "function",
    createCheckoutPaymentLinkHandler: "function",
    createPostgresCustomerCheckoutRecoveryStartPort: "function",
    createCheckoutRecoveryInspection: "function",
    createCheckoutRecoveryValidationPolicy: "function",
    createPostgresCheckoutRecoveryOrderPort: "function",
    createExpiredCheckoutRecoveryService: "function",
    ExpiredCheckoutRecoveryError: "function",
    createPostgresExpiredCheckoutRecoveryPort: "function",
    readAuthorizedPaymentRecovery: "function",
    createPostgresPaymentRecoveryGuidancePort: "function",
    createCheckoutRecoveryPayService: "function",
    createCheckoutRecoveryTokenPay: "function",
    createCheckoutInlineRecovery: "function",
    checkoutInlineRecoveryTransitionKey: "function",
    CheckoutInlineRecoveryError: "function",
    CheckoutRecoveryPayError: "function",
    withCheckoutRecoveryPaymentHold: "function",
    createPostgresExpiredCheckoutDraftPort: "function",
    createPostgresExpiredCheckoutRuntime: "function",
    createPostgresExpiredCheckoutCompensation: "function",
    checkoutRecoveryExecutionFingerprint: "function",
    createPostgresBuyerCheckoutLinkPort: "function",
    CheckoutLinkNotRecoverableError: "function",
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
  compileConsumer(consumer, ["commerce", "commerce/contracts", "commerce/server", "commerce/server/destinations", "pricing/browser"], join(root, "node_modules/typescript/lib/tsc.js"));
}, 65_000);

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
}, 65_000);

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
}, 65_000);

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

it("keeps the packed communications contracts surface and pure rendering", () => {
  const consumer = pristinePackedA1Fixture();
  assertConsumerIsolation(consumer, root);
  proveCommunicationsConsumer(consumer);
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
}, 50_000);

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
}, 40_000);

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

it("K4 accepts installed local address formats and preserves field refusals and defaults", () => {
  proveSavedAddressFormatsConsumer(pristinePackedA1Fixture());
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
}, 100_000);

it("proves installed marketing server reads, port refusal, default-off privacy and exact exports without optional peers", () => {
  const consumer = pristinePackedA1Fixture();
  assertConsumerIsolation(consumer, root);
  proveMarketingServerConsumer(consumer);
  for (const name of ["@types/node", "undici-types"]) cpSync(join(root, "node_modules", name), join(consumer, "node_modules", name), { recursive: true });
  compileConsumer(consumer, ["marketing/server"], join(root, "node_modules/typescript/lib/tsc.js"));
}, 40_000);

it("M15 consumes packed risk assessment and payment refusal without optional peers", () => {
  const consumer=pristinePackedA1Fixture();
  assertConsumerIsolation(consumer,root);
  proveRiskConsumer(consumer);
  for (const name of ["@types/node", "undici-types"]) cpSync(join(root,"node_modules",name),join(consumer,"node_modules",name),{recursive:true});
  compileConsumer(consumer,["risk","risk/contracts"],join(root,"node_modules/typescript/lib/tsc.js"));
},35_000);

// Four independently reported installed-artifact cases; each starts from its own copy.
it.each(RISK_WORKFLOW_PROOFS)("M15 R2 packed workflow: %s", proof => {
  const consumer = pristinePackedA1Fixture();
  assertConsumerIsolation(consumer, root);
  for (const name of ["@types/node", "undici-types"]) cpSync(join(root, "node_modules", name), join(consumer, "node_modules", name), { recursive: true });
  proveRiskWorkflowConsumer(consumer, join(root, "node_modules/typescript/lib/tsc.js"), proof);
}, 30_000);

it("runs the actual partner host selection guards without the optional pg peer", () => {
  const consumer = pristinePackedA1Fixture();
  installPartnerAcquisitionHostBinding(consumer);
  assertConsumerIsolation(consumer, root);
  provePartnerAcquisitionBindingConsumer(consumer);
});

it.each(["eager adapter", "missing URL guard", "shadow factory"] as const)("rejects broken partner host delegation: %s", corruption => {
  const consumer = pristinePackedA1Fixture();
  installPartnerAcquisitionHostBinding(consumer);
  const path = join(consumer, corruption === "shadow factory"
    ? "server/adapters/postgres/partners/partnerAcquisitionRoutines.js"
    : "server/runtime/partners/partnerAcquisitionBinding.js");
  const original = readFileSync(path, "utf8");
  const mutant = corruption === "eager adapter" ? 'import "../../adapters/postgres/partners/partnerAcquisitionRoutines.js";\n' + original
    : corruption === "missing URL guard" ? original.replace("if (!connectionString) return null;", "")
    : 'export function createPostgresPartnerAcquisitionPort() { throw new Error("shadow factory"); }\n';
  expect(mutant).not.toBe(original);
  try {
    writeFileSync(path, mutant);
    expect(() => provePartnerAcquisitionBindingConsumer(consumer)).toThrow();
  } finally { writeFileSync(path, original); }
});

it('executes the installed operator link command and store without database peer types', () => {
  const consumer = pristinePackedA1Fixture();
  assertConsumerIsolation(consumer, root);
  const result = JSON.parse(consumerNode(consumer, `
const { createAdminCheckoutPaymentLinkHandler, createPostgresOperatorCheckoutLinkStore } = await import('@openlup/platform/commerce/server');
const calls = [];
const tokenStore = createPostgresOperatorCheckoutLinkStore({ query: async (sql, values) => {
  calls.push({sql, values}); return {rows:[{result: sql.includes('commerce_operator_link_insert(') ? '44444444-4444-4444-8444-444444444444' : null}]};
}});
let response;
const orderId='11111111-1111-4111-8111-111111111111';
const handler=createAdminCheckoutPaymentLinkHandler({
 authorizeAdmin:async()=>({ok:true,userId:'22222222-2222-4222-8222-222222222222',isMachineActor:false}),
 respond:{sendMethodNotAllowed:()=>{throw Error('method');},sendBffError:(_,code)=>{response={code};},sendBffSuccess:(_,data)=>{response=data;}},
 orderPort:{getRecoveryOrder:async()=>({orderId,orderRef:'example-order',orderNumber:'1',clientId:'33333333-3333-4333-8333-333333333333',status:'pending_payment',mode:'one_time_order',
 totalMinor:100,currency:'XXX',cadenceDays:null,createdAt:'2040-01-02T12:00:00Z',customerEmail:null,customerName:null,paymentIntentId:null,paymentIntentStatus:null,subscriptionId:null,subscriptionCycleId:null})},
 tokenStore,policy:{operatorLifetimeMs:3600000,recoveryWindowMs:86400000},now:()=>new Date('2040-01-02T12:00:00Z'),generateToken:()=> 'rcv_installed_example'
});
await handler({method:'POST',body:{orderId,delivery:'email'}},null);
process.stdout.write(JSON.stringify({response,calls}));
`));
  expect(result.response).toEqual({token:'rcv_installed_example',expiresAt:'2040-01-02T13:00:00.000Z',orderRef:'example-order',emailQueued:true});
  expect(result.calls.map((call: {sql:string}) => call.sql.match(/public\.(\w+)\(/u)?.[1])).toEqual([
    'commerce_operator_link_receipt','commerce_operator_link_revoke','commerce_operator_link_insert','commerce_operator_link_enqueue','commerce_operator_link_receipt',
  ]);
  expect(result.calls[0].values[0]).toBe('22222222-2222-4222-8222-222222222222');
  expect(result.calls[4].values.slice(3,6)).toEqual(['succeeded','email_queued',true]);
});

it('executes installed customer start and cookie buyer links without database peer types', () => {
  const consumer = pristinePackedA1Fixture();
  assertConsumerIsolation(consumer, root);
  const result = JSON.parse(consumerNode(consumer, `
const {createCheckoutRecoveryStartHandler,createCheckoutPaymentLinkHandler,createPostgresCustomerCheckoutRecoveryStartPort,createPostgresBuyerCheckoutLinkPort,createCheckoutPaymentContinuationCodec}=await import('@openlup/platform/commerce/server');
const id='11111111-1111-4111-8111-111111111111',client='22222222-2222-4222-8222-222222222222';
const calls=[],responses=[];
const executor={query:async(sql,values)=>{calls.push({sql,values});return{rows:[{result:sql.includes('find_as_actor')?{orderId:id,createdAt:'2040-01-02T12:00:00Z',mode:'one_time_order',subscriptionId:null,clientHasLiveOrPendingSubscription:false}:sql.includes('token_issue_as_actor')?'token-id':{sent:true,queued:true}}]};}};
const respond={sendMethodNotAllowed:()=>{throw Error('method');},sendBffError:(_,code)=>{throw Error(code);},sendBffSuccess:(_,data)=>responses.push(data)};
await createCheckoutRecoveryStartHandler({recoveryEnabled:()=>true,authenticateUser:async()=>({ok:true,userId:'session'}),createPort:()=>createPostgresCustomerCheckoutRecoveryStartPort(executor),respond,lifetimeMs:86400000,now:()=>new Date('2040-01-02T12:00:00Z'),generateToken:()=> 'rcv_installed_start'})({method:'POST',body:{orderId:id}},null);
const codec=createCheckoutPaymentContinuationCodec('x'.repeat(40),{cookieName:'continuation',executionRails:['captured','redirect']});
const cookie=codec.issue({journeyId:'checkout:'+id,orderId:id,clientId:client,paymentAttemptId:id,paymentIntentId:id,executionRail:'captured'}).setCookie.split(';')[0];
await createCheckoutPaymentLinkHandler({codec,createPort:()=>createPostgresBuyerCheckoutLinkPort(executor,{lifetimeMs:86400000,sendBucketMs:600000}),respond,generateToken:()=> 'rcv_installed_buyer'})({method:'POST',headers:{cookie},body:{orderId:client}},null);
process.stdout.write(JSON.stringify({responses,calls}));
`));
  expect(result.responses).toEqual([{contractVersion:'commerce.checkout-recovery.v1',recoverable:true,token:'rcv_installed_start',mode:'one_time_order'},{sent:true}]);
  expect(result.calls.map((call: {sql:string})=>call.sql.match(/public\.(\w+)\(/u)?.[1])).toEqual([
    'customer_checkout_recovery_find_as_actor','customer_checkout_recovery_token_issue_as_actor','commerce_buyer_checkout_link_issue',
  ]);
  expect(result.calls[1].values[1]).not.toBe('rcv_installed_start');
  expect(result.calls[2].values.slice(0,3)).toEqual(['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','rcv_installed_buyer']);
});

it('executes installed recreation refusals and the neutral sandbox safety port without database peers',()=>{
 const consumer=pristinePackedA1Fixture();assertConsumerIsolation(consumer,root);
 const result=JSON.parse(consumerNode(consumer,`
const {createExpiredCheckoutRecoveryService,createPostgresExpiredCheckoutRecoveryPort}=await import('@openlup/platform/commerce/server');
const {createPostgresSandboxExpiredCheckoutSafety}=await import('@openlup/platform/payments');
const db={query:async()=>({rows:[]})},service=createExpiredCheckoutRecoveryService({supports:()=>false});
const validation=await service.validate({});let reason;
try{await service.recreate({order:{},clientId:'client'});}catch(error){reason=error.reason;}
const prior=await createPostgresSandboxExpiredCheckoutSafety(db).verifyPriorPayment({orderId:'missing',totalMinor:100,currency:'XXX'});
const port=createPostgresExpiredCheckoutRecoveryPort(db,{recoveryWindowMs:1000});
process.stdout.write(JSON.stringify({validation,reason,prior,writer:typeof port.prepareReplacement}));
`));
 expect(result).toEqual({validation:false,reason:'unavailable',prior:'unavailable',writer:'function'});
});

it('executes the installed atomic guidance port and validation-only composition without database peers', () => {
  const consumer = pristinePackedA1Fixture();
  assertConsumerIsolation(consumer, root);
  const result = JSON.parse(consumerNode(consumer, `
const {createPostgresPaymentRecoveryGuidancePort,readAuthorizedPaymentRecovery}=await import('@openlup/platform/commerce/server');
const {normalizeSandboxPaymentRecoveryEvidence}=await import('@openlup/platform/payments');
const orderId='11111111-1111-4111-8111-111111111111',clientId='22222222-2222-4222-8222-222222222222',paymentIntentId='33333333-3333-4333-8333-333333333333',attemptId='44444444-4444-4444-8444-444444444444',tokenId='55555555-5555-4555-8555-555555555555';
const calls=[];
const port=createPostgresPaymentRecoveryGuidancePort({query:async(sql,values)=>{calls.push({sql,values});return{rows:[{result:{
 snapshot:{orderId,clientId,paymentIntentId,orderStatus:'pending_payment',intentStatus:'created',paymentAttemptId:attemptId,attemptStatus:'refused',provider:'sandbox',providerPaymentId:null,updatedAt:'2040-01-01T00:00:00Z',failureReason:null,orderMode:'one_time',activationState:null,subscriptionId:null,subscriptionStatus:null,paidAt:null,hasExactGap:false},
 eligible:true,tokenAuthorized:true,observedSuccess:false,historyComplete:true,
 attempts:[{id:attemptId,status:'refused',provider:'sandbox',providerPaymentId:null,providerFlow:null,createdAt:'2040-01-01T00:00:00Z',evidence:[{version:1,source:'observation',sourceId:tokenId,observationId:tokenId,paymentAttemptId:attemptId,paymentIntentId,outcome:'refused',refusalVerified:true}]}]
}}]};}},normalizeSandboxPaymentRecoveryEvidence);
const value=await readAuthorizedPaymentRecovery({request:{orderId,clientId,paymentIntentId},claims:null,authorization:'Bearer installed-example',deps:{port,tokenPort:{validate:async()=>({tokenId,orderId,clientId,status:'pending_payment',mode:'one_time_order'})}}});
process.stdout.write(JSON.stringify({guidance:value.guidance,calls}));
`));
  expect(result.guidance).toMatchObject({ methodKey: null, operation: null, actions: ['change_instrument', 'change_method'] });
  expect(result.calls).toHaveLength(1);
  expect(result.calls[0].sql).toMatch(/^SELECT public\.commerce_checkout_payment_guidance_snapshot\(/u);
});

it('executes installed token pay and hold composition without database peers', () => {
 const consumer=pristinePackedA1Fixture();assertConsumerIsolation(consumer,root);
 const result=JSON.parse(consumerNode(consumer,`
const {createCheckoutRecoveryPayService,createCheckoutRecoveryTokenPay,withCheckoutRecoveryPaymentHold}=await import('@openlup/platform/commerce/server');
const {createPostgresSandboxCheckoutRecoveryAttemptPort}=await import('@openlup/platform/payments');
const order={orderId:'11111111-1111-4111-8111-111111111111',clientId:'22222222-2222-4222-8222-222222222222',status:'pending_payment',subscriptionCycleId:null,paymentIntentId:'33333333-3333-4333-8333-333333333333',paymentIntentStatus:'pending',totalMinor:100,currency:'XXX',mode:'one_time_order',createdAt:'2040-01-02T00:00:00Z'};
const calls=[];
const attemptPort=createPostgresSandboxCheckoutRecoveryAttemptPort({query:async(sql,values)=>{calls.push({sql,values});return{rows:[{response:{id:'44444444-4444-4444-8444-444444444444',orderId:order.orderId,settlementIntentId:order.paymentIntentId,state:'dispatched',replayed:false,dispatchedAt:'2040-01-02T00:00:00Z',methodFacts:{unattendedChargeAuthorizedAt:'2040-01-02T00:00:00Z'},latestObservation:null}}]};}},{dunningTemplateSlug:'dunning',recoveryUrlPath:'/recover',recoveryTemplateSlug:'recover'});
const service=withCheckoutRecoveryPaymentHold(createCheckoutRecoveryPayService(attemptPort),{classify:()=>null,readHolds:async()=>[],offeredMethods:()=>new Set()});
const api=createCheckoutRecoveryTokenPay({tokenPort:{validate:async()=>({tokenId:'55555555-5555-4555-8555-555555555555',orderId:order.orderId,clientId:order.clientId}),inspect:async()=>null},orderPort:{getRecoveryOrder:async()=>order},payService:service});
const value=await api.pay({token:'installed-example',idempotencyKey:'installed-click',method:undefined});
process.stdout.write(JSON.stringify({value,calls}));
`));
 expect(result.value).toMatchObject({status:'processing',replayed:false,paymentAttemptId:'44444444-4444-4444-8444-444444444444'});
 expect(result.calls).toHaveLength(1);expect(result.calls[0].sql).toContain('public.commerce_checkout_recovery_attempt_begin');
 expect(JSON.parse(result.calls[0].values[5])).toEqual({recoveryTokenId:'55555555-5555-4555-8555-555555555555',methodFacts:{}});
});

it('executes installed cookie-only inline authority and sandbox replay ports without database peers',()=>{
 const consumer=pristinePackedA1Fixture();assertConsumerIsolation(consumer,root);
 const result=JSON.parse(consumerNode(consumer,`
const {createCheckoutInlineRecovery,createCheckoutPaymentContinuationCodec,checkoutInlineRecoveryTransitionKey}=await import('@openlup/platform/commerce/server');
const {createPostgresSandboxInlineRecoveryAttemptPort}=await import('@openlup/platform/payments');
const orderId='11111111-1111-4111-8111-111111111111',clientId='22222222-2222-4222-8222-222222222222',intent='33333333-3333-4333-8333-333333333333',previous='44444444-4444-4444-8444-444444444444',nonce='55555555-5555-4555-8555-555555555555',attempt='66666666-6666-4666-8666-666666666666';
const calls=[],facts={methodRef:'sandbox:registered',methodEvidenceRef:'sandbox:registered:evidence',authorizationRef:'sandbox:authorization',payerAccountRef:null,unattendedChargeAuthorizedAt:'2026-11-10T00:00:00Z'};
const port=createPostgresSandboxInlineRecoveryAttemptPort({query:async(sql,values)=>{calls.push({sql,values});return{rows:[{response:{id:attempt,orderId,settlementIntentId:intent,settlementChannelKey:'sandbox',state:'dispatched',replayed:true,dispatchedAt:'2026-11-10T00:00:00Z',methodFacts:facts,latestObservation:null}}]};}},{dunningTemplateSlug:'dunning',recoveryUrlPath:'/recover',recoveryTemplateSlug:'recover',methodKeyFor:()=>{throw Error('replay_must_not_resolve_method');}});
const codec=createCheckoutPaymentContinuationCodec('synthetic-cookie-key-material'.repeat(2),{cookieName:'configured-inline',executionRails:['sandbox','external']});
const service=createCheckoutInlineRecovery({codec,guidance:{port:{getGuidanceSnapshot:async()=>{throw Error('unexpected_read');}}},orderPort:{getRecoveryOrder:async()=>{throw Error('unexpected_read');}},attemptPort:port,executionAllowed:()=>false});
let refusal;try{await service.retry({headers:{authorization:'Bearer ignored'},orderId,clientId,paymentIntentId:intent,journeyId:'checkout:'+orderId,expectedPaymentAttemptId:previous,retryRequestId:nonce,executionRail:'sandbox',methodKey:'registered',method:facts});}catch(e){refusal=e.kind;}
if(calls.length)throw Error('cookie_guard_read');
const value=await port.begin({order:{orderId},request:{orderId,clientId,paymentIntentId:intent,expectedPaymentAttemptId:previous,retryRequestId:nonce,executionRail:'sandbox',methodKey:'changed-after-response-loss'},method:facts,admission:{replayOnly:true,purchaseContext:null,previousMethodKey:null,actions:[],restriction:null}});
process.stdout.write(JSON.stringify({refusal,value,calls,key:checkoutInlineRecoveryTransitionKey(previous)}));
`));
 expect(result.refusal).toBe('unauthorized');expect(result.value).toMatchObject({status:'processing',replayed:true});expect(result.calls).toHaveLength(1);
 expect(result.calls[0].sql).toContain('public.commerce_checkout_inline_retry_begin');expect(result.calls[0].values[0]).toBe(`${result.key}:payment-execution:prepare-attempt`);
 expect(JSON.parse(result.calls[0].values[6])).toMatchObject({replayOnly:true,retryRequestId:'55555555-5555-4555-8555-555555555555',methodFacts:{}});
});

function packedCatalogue() {
  const consumer = pristinePackedA1Fixture();
  const app = mkdtempSync(join(consumer, "catalogue 'app-"));
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "catalogue 'scratch-")));
  temporary.push(app, temp);
  const platform = join(consumer, "node_modules/@openlup/platform");
  const bin = join(platform, "src/lifecycle/openlup.mjs");
  const environment = { ...isolatedConsumerEnv(), TMPDIR: temp, TMP: temp, TEMP: temp };
  const write = (path: string, bytes: string) => {
    const target = join(app, path);
    writeFileSync(target, bytes);
    return target;
  };
  write("package.json", '{"type":"module","dependencies":{"@openlup/core":"1.2.0","@openlup/platform":"1.2.0"}}');
  function call(args: string[], exit: number, preload: string[] = [], scratchRoot = temp, cwd = app) {
    const result = spawnSync(process.execPath, [...preload, bin, ...args, "--json"], {
      cwd, encoding: "utf8", env: { ...environment, TMPDIR: scratchRoot, TMP: scratchRoot, TEMP: scratchRoot },
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status, result.stdout).toBe(exit);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ formatVersion: 1, exitCode: exit });
    expect(result.stdout).not.toContain("SYNTHETIC_PRIVATE_DETAIL");
    return report;
  }
  return { app, temp, platform, bin, environment, write, call, consumer };
}

const productId = "00000000-0000-4000-8000-000000000001";
const skuId = "00000000-0000-4000-8000-000000000002";
const fixtureType = { key: "sample:item", version: 1 };
const fixturePack = { id: "sample", namespace: "sample", version: 1, openlupRange: "1.x",
  taxClasses: [], capabilities: {}, types: [{ ...fixtureType, units: [{ code: "sample:each", dimension: "count", integral: true }], netContentUnits: ["sample:each"], dimensions: [] }] };
const contentDraft = { schemaVersion: 1, product: { id: productId, type: fixtureType, dimensions: [], sharedContent: { title: "Example" } }, skus: [] };
const sourceModule = (data: unknown, callback = "() => []") => `
export const catalogueConformance = ${JSON.stringify(data)};
catalogueConformance.packs[0].pack.types[0].validateContent = ${callback};
`;
const sourceArgs = (path: string) => ["catalogue", "project", "--trusted-packs", path];
const replayArgs = (path: string) => ["catalogue", "check", "--packs", path];
const findingIdentity = ({ path, code, severity }: { path: string; code: string; severity: string }) => [path, code, severity];
const netContentWarning = ["/packs/0/pack/types/0/netContentUnits", "advisory_net_content_not_publishable", "warning"];

it("RP2 keeps executable suffixes inert", () => {
  const { app, write, call } = packedCatalogue();
  const effect = join(app, "effect");
  for (const suffix of ["ts", "mjs"]) {
    const path = write("source." + suffix, 'import { writeFileSync } from "node:fs"; writeFileSync("effect", "effect"); export const catalogueConformance = {};');
    expect(call(replayArgs(path), 64).state).toBe("refused");
    expect(existsSync(effect)).toBe(false);
    write("source." + suffix, JSON.stringify({ packs: [{ pack: fixturePack }] }));
    expect(call(replayArgs(path), 0).command).toBe("catalogue check");
  }
});

it("RP2 admits trust flags before loading and classifies failures", () => {
  const { app, temp, write, call } = packedCatalogue();
  const path = write("trusted 'example.mjs", 'import { writeFileSync } from "node:fs"; writeFileSync("effect", "effect"); throw new SyntaxError("SYNTHETIC_PRIVATE_DETAIL");');
  for (const args of [[...sourceArgs(path), "--packs", path], [...replayArgs(path), "--trusted-packs", path], [...sourceArgs(path), "--app", path]]) call(args, 64);
  expect(existsSync(join(app, "effect"))).toBe(false);
  call(sourceArgs(path), 74);
  expect(existsSync(join(app, "effect"))).toBe(true);
  call(sourceArgs(write("absent-export.mjs", "export const other = 1;")), 74);
  call(sourceArgs(join(app, "absent-module.mjs")), 74);
  const data = { packs: [{ pack: fixturePack, drafts: [contentDraft] }], requiredChecks: ["draft-content"] };
  for (const failure of ['new SyntaxError("SYNTHETIC_PRIVATE_DETAIL")', 'new Error("draft_json_invalid")', '"draft_json_invalid"']) {
    const file = write("throws.mjs", sourceModule(data, `() => { throw ${failure}; }`));
    expect(call(sourceArgs(file), 74).findings[0].code).toBe("OPENLUP_E_CLI_FAILURE");
  }
  const crossPackDuplicate = write("cross-pack-duplicate.mjs", sourceModule({ packs: [{ pack: fixturePack }, ...data.packs] })
    + 'catalogueConformance.packs[1].pack.types[0].validateContent = () => { throw new Error("SYNTHETIC_PRIVATE_DETAIL"); };');
  expect(call(sourceArgs(crossPackDuplicate), 74).findings[0].code).toBe("OPENLUP_E_CLI_FAILURE");
  const valid = write("valid.mjs", sourceModule(data));
  call(sourceArgs(valid), 74, [], join(temp, "missing"));
  const unavailable = { ...data, requiredChecks: ["taxonomy"] };
  call(sourceArgs(write("unavailable.mjs", sourceModule(unavailable))), 2);
  const broken = write("broken 'source.mjs", sourceModule({ ...unavailable, packs: [{ pack: fixturePack,
    drafts: [null], quantities: [{}] }] }));
  const report = call(sourceArgs(broken), 1);
  expect(report.state).toBe("violated");
  expect(report.findings.map(findingIdentity)).toEqual([
    ["/packs/0/drafts/0", "draft_input_invalid", "error"],
    netContentWarning,
    ["/packs/0/quantities/0/value", "quantity_invalid", "error"],
    ["/requiredChecks/0", "conformance_owner_unavailable", "error"],
  ]);
  expect(report.transport.recheck).toContain("'\"'\"'");
  expect(report.findings.every(({ recheck }: { recheck: string }) => recheck === report.transport.recheck)).toBe(true);
});

it("RP2 confines scratch from a nested working directory", () => {
  const { app, temp, write, call } = packedCatalogue();
  const owned = join(app, "owned"), cache = join(app, "cache");
  mkdirSync(owned); mkdirSync(cache);
  write("owned/catalogue.mjs", sourceModule({ packs: [{ pack: fixturePack }] }));
  const before = readdirSync(app, { recursive: true }).sort();
  for (const scratch of [app, cache]) {
    call(sourceArgs("./owned/catalogue.mjs"), 74, [], scratch);
    call(sourceArgs("./catalogue.mjs"), 74, [], scratch, owned);
    expect(readdirSync(app, { recursive: true }).sort()).toEqual(before);
  }
  // The working directory also needs protection when the app is elsewhere.
  call(sourceArgs(join(owned, "catalogue.mjs")), 74, [], temp, temp);
  expect(readdirSync(temp)).toEqual([]);
  expect(call(sourceArgs("./catalogue.mjs"), 0, [], temp, owned).command).toBe("catalogue project");
});

it.each([false, true])("RP2 confines scratch across nested package boundaries (symlinked: %s)", linked => {
  const { app, temp, write, call } = packedCatalogue();
  const owned = join(app, "owned"), submodule = join(owned, "submodule"), cache = join(app, "cache");
  mkdirSync(submodule, { recursive: true }); mkdirSync(cache);
  write("owned/catalogue.mjs", sourceModule({ packs: [{ pack: fixturePack }] }));
  write("owned/submodule/package.json", '{"type":"module"}');
  const source = write("owned/submodule/catalogue.mjs", 'export { catalogueConformance } from "../catalogue.mjs";');
  const sourceLink = join(temp, "linked-source.mjs"), cacheLink = join(temp, "linked-cache");
  symlinkSync(source, sourceLink); symlinkSync(cache, cacheLink);
  call(sourceArgs(linked ? sourceLink : "./submodule/catalogue.mjs"), 74, [], linked ? cacheLink : cache, owned);
  expect(readdirSync(cache)).toEqual([]);
  expect(call(sourceArgs(sourceLink), 0, [], temp, owned).command).toBe("catalogue project");
});

it.each([false, true])("RP2 reports the saved axis and independent owner evidence (unresolved reference: %s)", reference => {
  const { write, call } = packedCatalogue();
  const values = { namespace: "sample:finish", id: "unresolved" };
  const pack = { ...fixturePack, types: [{ ...fixturePack.types[0],
    dimensions: [{ key: "lined", kind: "boolean" }], attributes: [{
      key: "finish", scope: "product", valueType: { kind: "reference", allowlist: [values.namespace] }, required: false,
      cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {},
    }],
  }] };
  const base = { product: { ...contentDraft.product, dimensions: ["lined"], ...(reference ? { attributes: { finish: values } } : {}) },
    skus: [{ id: skuId, productId, options: { lined: { kind: "boolean", value: true } } }] };
  const v3 = { ...base, schemaVersion: 3, product: { ...base.product,
    sharedContent: { schemaVersion: 1, catalogAction: "create", presentation: {},
      offerMemberships: [], requestedModes: [], publicationSkus: [] } },
    publication: { kind: "release", evidence: {}, operations: [] } };
  const data = { packs: [{ pack, drafts: [{ ...base, schemaVersion: 2 }, v3] }] };
  const projected = call(sourceArgs(write("axis.mjs", sourceModule(data))), 1);
  const artifact = projected.transport.subjectPath;
  const subject = JSON.parse(readFileSync(artifact, "utf8"));
  for (const report of [projected, call(replayArgs(artifact), 1)]) {
    const checkFinding = (code: string, path: string, value: unknown) => {
      const finding = report.findings.find((entry: { code: string; path: string }) => entry.code === code && entry.path === path);
      expect(finding, `${code} at ${path}`).toBeDefined();
      const saved = finding.path.split("/").slice(1).reduce((node: unknown, key: string) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined, subject);
      expect(saved, path).toEqual(value);
    };
    for (const index of [0, 1]) {
      const draftPath = `/packs/0/drafts/${index}/product`;
      checkFinding("axis_not_installed", `${draftPath}/dimensions/0`, "lined");
      if (reference) checkFinding("attribute_reference_unresolved", `${draftPath}/attributes/finish`, values);
    }
  }
});

it("RP2 replays v2 owner violations and points to saved attribute values", () => {
  const { write, call } = packedCatalogue();
  const pack = { ...fixturePack, types: [{ ...fixturePack.types[0], attributes: [{
    key: "flag", scope: "product", valueType: { kind: "boolean" }, required: false,
    cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {},
  }] }] };
  const draft = { ...contentDraft, schemaVersion: 2, product: {
    ...contentDraft.product, attributes: { flag: "invalid boolean", "finish/~": "undeclared" },
  } };
  const projected = call(sourceArgs(write("attributes.mjs", sourceModule({ packs: [{ pack, drafts: [draft] }] }))), 1);
  const subject = JSON.parse(readFileSync(projected.transport.subjectPath, "utf8"));
  const replay = call(replayArgs(projected.transport.subjectPath), 1);
  expect(replay.findings).toContainEqual(expect.objectContaining({
    code: "conformance_owner_unavailable", path: "/packs/0/drafts/0/product/sharedContent",
  }));
  for (const { findings } of [projected, replay]) {
    for (const [code, key, value] of [
      ["attribute_value_invalid", "flag", "invalid boolean"],
      ["attribute_unknown_key", "finish~1~0", "undeclared"],
    ]) {
      const finding = findings.find((entry: { code: string }) => entry.code === code);
      expect(finding?.path, code).toBe("/packs/0/drafts/0/product/attributes/" + key);
      const saved = finding.path.split("/").slice(1).reduce((data: unknown, part: string) =>
        data && typeof data === "object" ? (data as Record<string, unknown>)[part.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined, subject);
      expect(saved, finding.path).toBe(value);
    }
  }
});

it("RP2 refuses async validators with one sanitized report and matching exit", () => {
  const { write, call } = packedCatalogue();
  const source = sourceModule({ packs: [{ pack: fixturePack, drafts: [contentDraft] }] },
    'async () => { throw new Error("SYNTHETIC_PRIVATE_DETAIL"); }');
  expect(call(sourceArgs(write("async.mjs", source)), 74).findings[0]).toMatchObject({
    code: "OPENLUP_E_CLI_FAILURE", fix: expect.stringContaining("return synchronously"),
  });
});

it("RP2 handles a rejecting thenable with a one-read getter", () => {
  const { write, call } = packedCatalogue();
  const source = sourceModule({ packs: [{ pack: fixturePack, drafts: [contentDraft] }] }, `() => {
    const rejection = Promise.reject(new Error("SYNTHETIC_PRIVATE_DETAIL"));
    let reads = 0;
    return { get then() { return ++reads === 1 ? rejection.then.bind(rejection) : undefined; } };
  }`);
  expect(call(sourceArgs(write("thenable.mjs", source)), 74).findings).toEqual([expect.objectContaining({
    code: "OPENLUP_E_CLI_FAILURE", fix: expect.stringContaining("return synchronously"),
  })]);
});

it("RP2 snapshots registration descriptors once and refuses getters", () => {
  const { app, write, call } = packedCatalogue();
  const registration = sourceModule({ packs: [{ pack: fixturePack }], requiredChecks: ["draft-content"] })
    .replace("export const catalogueConformance", "const catalogueConformance");
  const proxy = write("proxy.mjs", registration + `
    let enumerations = 0;
    const registration = new Proxy(catalogueConformance, {
      ownKeys(target) {
        return ++enumerations === 1 ? Reflect.ownKeys(target) : ["packs"];
      },
    });
    export { registration as catalogueConformance };
  `);
  const projected = call(sourceArgs(proxy), 2);
  expect(JSON.parse(readFileSync(projected.transport.subjectPath, "utf8")).requiredChecks).toEqual(["draft-content"]);
  const accessor = write("getter.mjs", registration + `
    import { writeFileSync } from "node:fs";
    Object.defineProperty(catalogueConformance, "requiredChecks", {
      enumerable: true,
      get() { writeFileSync("getter-effect", "unexpected"); return []; },
    });
    export { catalogueConformance };
  `);
  call(sourceArgs(accessor), 74);
  expect(existsSync(join(app, "getter-effect"))).toBe(false);
});

it("RP2 projects deterministic bytes and replays the quoted command", () => {
  const { consumer, app, temp, bin, environment, write, call } = packedCatalogue();
  const v3 = { ...contentDraft, schemaVersion: 3, product: { ...contentDraft.product,
    sharedContent: { schemaVersion: 1, catalogAction: "create", document: { title: "Café", details: { z: "last", a: "first" } },
      presentation: {}, offerMemberships: [], requestedModes: [], publicationSkus: [] } },
    skus: [{ id: skuId, productId, options: {}, priceOperations: [7, 3].map(unitPriceMinor => ({
      schemaVersion: 1, commandKey: "price:" + unitPriceMinor, variantId: skuId, priceListId: skuId,
      mode: "one_time", minQty: 1, amountKind: "gross", unitPriceMinor, expected: { entryId: null, unitPriceMinor: null },
    })) }], publication: { kind: "release", evidence: {}, operations: [
      { op: "create_product", name: "Example", productId, productSlug: "example" },
      { op: "set_product_presentation", productSlug: "example", presentation: { title: "Café" } },
    ] } };
  const data = { packs: [{ pack: fixturePack, drafts: [v3, contentDraft] },
    { pack: { ...fixturePack, id: "other", namespace: "other", types: [] } }] };
  const reverseKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)])) : value;
  const first = call(sourceArgs(write("first 'copy.mjs", sourceModule(data))), 0).transport;
  const second = call(sourceArgs(write("second copy.mjs", sourceModule(reverseKeys(data)))), 0).transport;
  const bytes = readFileSync(first.subjectPath);
  expect(bytes.equals(readFileSync(second.subjectPath))).toBe(true);
  expect(JSON.parse(bytes.toString())).toEqual(data);
  expect(bytes.toString()).toContain('"details":{"a":"first","z":"last"}');
  expect(first.subjectHash).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(second.subjectHash).toBe(first.subjectHash);
  expect(first.projectionMilliseconds).toBeGreaterThanOrEqual(0);
  expect(first.checkMilliseconds).toBeGreaterThanOrEqual(0);
  mkdirSync(join(app, "node_modules/.bin"), { recursive: true });
  symlinkSync(bin, join(app, "node_modules/.bin/openlup"));
  const runReported = (command: string) => spawnSync(command, { cwd: app, shell: true, encoding: "utf8",
    env: { ...environment, npm_config_offline: "true", npm_config_cache: join(consumer, "cache") } });
  const replay = runReported(first.replay);
  expect(replay.status, replay.stderr).toBe(2);
  expect(JSON.parse(replay.stdout)).toMatchObject({ command: "catalogue check", exitCode: 2 });
  const recheck = runReported(first.recheck);
  expect(recheck.status, recheck.stderr).toBe(0);
  expect(JSON.parse(recheck.stdout).transport.subjectHash).toBe(first.subjectHash);
  const text = spawnSync(process.execPath, [bin, ...sourceArgs(join(app, "first 'copy.mjs"))], { cwd: app, env: environment, encoding: "utf8" });
  expect(text.status, text.stderr).toBe(0);
  expect(text.stdout).toMatch(/^catalogue project: satisfied\b/u);
  expect(text.stdout).not.toContain("--json");
  expect(first.subjectPath.startsWith(temp + "/")).toBe(true);
});

it("RP2 checks exactly once and refuses substituted or application-local scratch", () => {
  const { app, temp, platform, write, call } = packedCatalogue();
  const draft = { ...contentDraft, product: { ...contentDraft.product, sharedContent: { title: "Example \uFFFD" } } };
  const args = sourceArgs(write("registration.mjs", sourceModule({ packs: [{ pack: fixturePack, drafts: [draft] }] })));
  const counter = join(temp, "entries");
  const checker = join(platform, "dist/catalog/testing/catalogExtensionConformance.js");
  const original = readFileSync(checker, "utf8");
  const signature = "async function checkSubject(jsonText, validators) {";
  expect(original).toContain(signature);
  writeFileSync(checker, 'import { appendFileSync } from "node:fs";\n' +
    original.replace(signature, signature + `\nappendFileSync(${JSON.stringify(counter)}, "entry\\n");`));
  const preload = write("swap.mjs", `
import { promises as fs } from "node:fs";
const read = fs.readFile;
fs.readFile = async (path, ...args) => {
  if (String(path).endsWith("/subject.json")) await fs.appendFile(path, " ");
  return read(path, ...args);
};
`);
  const swapEncoding = write("swap-encoding.mjs", `
import { promises as fs } from "node:fs";
const read = fs.readFile;
fs.readFile = async (path, ...args) => {
  const data = await read(path, ...args);
  if (!String(path).endsWith("/subject.json")) return data;
  const index = data.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
  return Buffer.concat([data.subarray(0, index), Buffer.from([0xff]), data.subarray(index + 3)]);
};
`);
  const before = () => readdirSync(app).sort().map(file => [file, readFileSync(join(app, file)).toString()]);
  const appBytes = before();
  try {
    const { transport } = call(args, 0);
    const observed = readFileSync(counter, "utf8").trim().split("\n");
    expect(observed).toEqual(["entry"]);
    expect(transport.checkerInvocations).toBe(observed.length);
    expect(transport.subjectPath.startsWith(temp + "/")).toBe(true);
    expect(statSync(transport.subjectPath).mode & 0o077).toBe(0);
    expect(statSync(dirname(transport.subjectPath)).mode & 0o077).toBe(0);
    call(args, 74, [], realpathSync(app));
    call(args, 74, ["--import", preload]);
    call(args, 74, ["--import", swapEncoding]);
    expect(readFileSync(counter, "utf8")).toBe("entry\n");
    expect(before()).toEqual(appBytes);
  } finally { writeFileSync(checker, original); }
});

it("RP2 uses the Core-I-bound validator and refuses executable mismatch", () => {
  const { write, call } = packedCatalogue();
  const artifact = 'module.exports = { validateContent: content => content.title === "Example" ? [] : [{code:"title_required",path:"title"}], validateProduct:()=>[], inspectDocument:()=>null, matchesDocument:()=>false, identifyDocument:()=>null, deriveSkuFacts:()=>({}), classifySkuChange:()=>"inconclusive" };';
  write("rules.cjs", artifact);
  const validatorRef = "sha256:" + createHash("sha256").update(artifact).digest("hex");
  const binding = `
import { readFileSync } from "node:fs";
import { withCatalogPublicationRules } from "@openlup/platform/catalog";
const pack = withCatalogPublicationRules(${JSON.stringify({ ...fixturePack, types: [{ ...fixturePack.types[0], validatorRef }] })},
  () => readFileSync(new URL("./rules.cjs", import.meta.url)));
`;
  function registration(name: string, title: string, replace = false, invalidSibling = false) {
    const content = { ...contentDraft, product: { ...contentDraft.product, sharedContent: { title } } };
    const types = [replace ? "{ ...pack.types[0], validateContent: () => [] }" : "pack.types[0]"];
    if (invalidSibling) types.push('{ ...pack.types[0], key: "sample:invalid", taxClass: "missing" }');
    const projectedPack = `{ ...pack, types: [${types.join(", ")}] }`;
    return sourceArgs(write(name, binding + `export const catalogueConformance = {
      packs: [{ pack: ${projectedPack}, drafts: [${JSON.stringify(content)}] }], requiredChecks: ["draft-content"] };
    `));
  }
  const good = registration("good.mjs", "Example");
  const pass = call(good, 0);
  const warnings = [
    ["/packs/0/drafts/0/schemaVersion", "advisory_draft_version_not_publishable", "warning"],
    netContentWarning,
  ];
  expect(pass.state).toBe("satisfied");
  expect(pass.findings.map(findingIdentity)).toEqual(warnings);
  const replay = call(replayArgs(pass.transport.subjectPath), 2);
  expect(replay.state).toBe("unavailable");
  expect(replay.findings.map(findingIdentity)).toEqual([
    ["/packs/0/drafts/0/product/sharedContent", "conformance_owner_unavailable", "error"],
    ...warnings,
    ["/requiredChecks/0", "conformance_owner_unavailable", "error"],
  ]);
  const refusal = call(registration("refused.mjs", ""), 1);
  expect(refusal.state).toBe("violated");
  expect(refusal.findings.map(findingIdentity)).toEqual([
    ["/packs/0/drafts/0/product/sharedContent/title", "title_required", "error"],
    ...warnings,
  ]);
  call(registration("substituted.mjs", "Example", true), 74);
  const mixed = call(registration("substituted-mixed.mjs", "Example", true, true), 1);
  expect(mixed.findings.map(findingIdentity)).toEqual([
    ["/packs/0/pack", "advisory_fixtures_skipped_definition_invalid", "warning"],
    netContentWarning,
    ["/packs/0/pack/types/1/taxClass", "definition_unknown_tax_class", "error"],
    ["/requiredChecks/0", "conformance_owner_unavailable", "error"],
  ]);
  write("rules.cjs", artifact + "\n");
  call(good, 74);
});

it("skeleton_pack_projects_clean", () => {
  const { app, consumer, write, call, environment } = packedCatalogue();
  const core = join(consumer, "node_modules/@openlup/core");
  const guide = "docs/guide/how-to/extend/catalogue-extension.md";
  const namespace = "sample";
  for (const file of ["catalogue.ts", "pack.ts", "fixtures.ts"]) {
    const original = readFileSync(join(dirname(join(core, guide)), "catalogue-pack-skeleton", file), "utf8");
    write(file, original.replaceAll("stationery", namespace));
  }
  const tsconfig = write("tsconfig.json", JSON.stringify({
    compilerOptions: { noEmit: true, skipLibCheck: true, strict: true, erasableSyntaxOnly: true,
      verbatimModuleSyntax: true, allowImportingTsExtensions: true, module: "nodenext", types: [] },
    files: ["catalogue.ts"],
  }));
  const projected = call(sourceArgs("./catalogue.ts"), 0);
  const [{ pack, drafts }] = JSON.parse(readFileSync(projected.transport.subjectPath, "utf8")).packs;
  expect(pack.types[0]).toMatchObject({ key: `${namespace}:notebook`, version: 1, taxClass: "standard",
    attributes: [{ key: "lined", scope: "variant", valueType: { kind: "boolean" } }],
    dimensions: [{ key: "lined", kind: "boolean" }], axes: [{ key: "lined", attributeKey: "lined" }],
  });
  expect(drafts[0]).toMatchObject({ schemaVersion: 3, product: { sharedContent: { presentation: { title: "Notebook" } } } });
  const lines = readFileSync(join(core, guide), "utf8").split("\n");
  for (const title of ["New vertical", "Add attribute", "Add unit", "Add axis", "Set the Platform version range", "Add tax class", "Subscription profile", "Upgrade a definition"]) {
    const result = JSON.parse(execFileSync(process.execPath, [join(core, "src/openlup-context.js"), "search", title, "--limit", "20", "--json"],
      { cwd: app, env: environment, encoding: "utf8" }));
    const index = lines.indexOf("## " + title);
    expect(index, title).toBeGreaterThan(0);
    const next = lines.findIndex((line, i) => i > index && line.startsWith("## "));
    expect(result.hits, title).toContainEqual(expect.objectContaining({ title, start: index + 1, end: next < 0 ? lines.length : next }));
  }
  const unitStart = lines.indexOf("## Add unit");
  const unitEnd = lines.findIndex((line, index) => index > unitStart && line.startsWith("## "));
  const examples = [...lines.slice(unitStart, unitEnd).join("\n").matchAll(/^```ts nocheck\n([^]*?)\n^```$/gm)];
  expect(examples).toHaveLength(2);
  const unit = examples[0]![1], quantity = examples[1]![1];
  const axisStart = lines.indexOf("## Add axis");
  const axisEnd = lines.findIndex((line, index) => index > axisStart && line.startsWith("## "));
  const axisExamples = [...lines.slice(axisStart, axisEnd).join("\n").matchAll(/^```ts nocheck\n([^]*?)\n^```$/gm)];
  expect(axisExamples).toHaveLength(3);
  const [, option] = axisExamples[0]!;
  const [, bindings] = axisExamples[1]!;
  write("pack.ts", readFileSync(join(app, "pack.ts"), "utf8")
    .replace("filterable: true, facetable: true }]),", `filterable: true, facetable: true },\n${option}\n    ]),`)
    .replace("export const pack =", `const namespace = ${JSON.stringify(namespace)};\n\nexport const pack =`)
    .replace(`namespace: "${namespace}"`, "namespace")
    .replace("\n    ],\n    netContentUnits:", `\n${unit}\n    ],\n    netContentUnits:`));
  write("fixtures.ts", readFileSync(join(app, "fixtures.ts"), "utf8")
    .replace(/^const options = .*$/m, bindings)
    .replace('dimensions: ["lined"]', "dimensions: selectedAxes")
    .replace('axes: ["lined"]', "axes: selectedAxes")
    .replaceAll("attributes: { lined: true }", "attributes: skuAttributes")
    .replace("quantities: [{ type, value: count }]", `quantities: [{ type, value: count },\n${quantity}\n  ]`));
  const compiled = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--project", tsconfig],
    { cwd: app, env: environment, encoding: "utf8" });
  expect(compiled.status, compiled.stdout || compiled.stderr).toBe(0);
  const appended = call(sourceArgs(join(app, "catalogue.ts")), 0);
  expect(appended.findings.map(({ code }: { code: string }) => code)).toEqual(["advisory_filter_flags_unused"]);
  const [updated] = JSON.parse(readFileSync(appended.transport.subjectPath, "utf8")).packs;
  expect(updated.pack.types[0].units).toEqual([...pack.types[0].units, expect.objectContaining({ code: `${namespace}:pair`, integral: true })]);
  expect(updated.pack.types[0].units).toContainEqual(expect.objectContaining({ code: "openlup:g", integral: false }));
  expect(updated.pack.types[0].netContentUnits).toEqual(["openlup:g"]);
  const finish = { kind: "choice", value: "matte" };
  expect(updated).toMatchObject({
    pack: { types: [{ axes: [{ key: "lined" }, { key: "finish", attributeKey: "finish" }] }] },
    drafts: [{ product: { dimensions: ["lined", "finish"] }, skus: [{ options: { finish }, attributes: { finish: "matte" } }] }],
    attributes: [{ input: { skus: [{ attributes: { finish: "matte" } }] } }],
    combinations: [{ input: { axes: ["lined", "finish"], incoming: [{ optionValues: { finish } }] } }],
  });
  expect(updated.quantities.at(-1)).toEqual({
    type: drafts[0].product.type,
    value: { dimension: "count", unit: `${namespace}:pair`, unscaled: "2", scale: 0 },
  });

  // Prove the application parser uses native, erasable TypeScript imports.
  call(sourceArgs(write("forward.ts", 'export { catalogueConformance } from "./catalogue.ts";')), 0);
}, 30_000);
