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

export const NON_ADAPTER_ENTRIES = ["inventory", "inventory/contracts", "http", "bff", "scheduler", "kernel", "composition", "catalog", "catalog/contracts", "pricing", "pricing/contracts", "promotions/contracts", "identity/contracts", "communications/contracts"] as const;
// identity, communications and promotions are adapter entries: their declarations reach data/pg types.
// Its cold runtime import/refusal is below; declarations compile after selecting peers.
export const ADAPTER_ENTRIES = ["blob", "data", "migrations", "job-ledger", "identity", "communications", "promotions"] as const;
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
  const segments = directory.slice(owned.length + 1).split(sep);
  const packageSegments = segments.slice(segments.lastIndexOf("node_modules") + 1);
  const isPackage = packageSegments.length === (packageSegments[0]?.startsWith("@") ? 2 : 1);
  ${peersAbsent ? 'if (isPackage && !peers.includes(packageSegments.join("/"))) assert(["@openlup/core", "@openlup/platform", "zod", "@types/node", "undici-types"].includes(packageSegments.join("/")), "Unexpected cold dependency: " + packageSegments.join("/"));' : ''}
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

// OIDC uses a host-selected implementation, separate from the historical adapter fixture inventory.
const oidcOperations = `
import assert from "node:assert/strict";
import { createOidcIdentityVerifier, createPostgresAccountLinkStore, deriveOidcPrincipalId } from "@openlup/platform/identity";
import { OIDC_FAILURE_CODES } from "@openlup/platform/identity";
assert(OIDC_FAILURE_CODES.includes("OIDC_NATIVE_SESSION_REQUIRED"));
assert.equal(deriveOidcPrincipalId("https://issuer.example.com/realm", "subject"), "262d8593-5c2f-8ce3-a5f2-de2751bbfe90");
let oidcFetches = 0, oidcLoads = 0;
const oidcIssuer = "https://issuer.example.invalid";
const oidc = createOidcIdentityVerifier({ issuer: oidcIssuer, audience: "api", algorithms: ["RS256"], maxTokenLifetimeSeconds: 3600 }, {
  fetch: async url => { oidcFetches++; return Response.json(String(url).endsWith("openid-configuration") ? { issuer: oidcIssuer, jwks_uri: oidcIssuer + "/keys" } : { keys: [{ kty: "RSA", alg: "RS256", kid: "key", use: "sig", n: "synthetic", e: "AQAB" }] }); },
  loadJwt: async () => { oidcLoads++; return import("jose"); },
});
assert.equal(oidcFetches, 0); assert.equal(oidcLoads, 0);
const oidcToken = [{ alg: "RS256", kid: "key" }, { iss: oidcIssuer }].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".") + ".c2ln";
assert.deepEqual(await oidc.verifyToken(oidcToken), { ok: false, code: "OIDC_JWT_LIBRARY_UNAVAILABLE" });
assert.equal(oidcLoads, 1);
await assert.rejects(async () => {
  const accountLinks = createPostgresAccountLinkStore({ connectionString: "postgresql://unused.invalid/consumer" });
  try { await accountLinks.findAccountByPrincipalId("11111111-1111-4111-8111-111111111111"); }
  finally { await accountLinks.close(); }
}, error => error.message.startsWith("OPENLUP_E_PEER_MISSING: pg is required by ") && Boolean(error.cause));
`;

export function proveOidcRefusals(consumer: string): void {
  consumerNode(consumer, oidcOperations);
}

// A valid synthetic catalogue gets as far as the lazy driver, never a deployment's SQL.
const adapterOperations = `
import assert from "node:assert/strict";
import { bindBlobPort } from "@openlup/platform/blob";
import { createPostgresDataGateway, createPostgresRoleFreeTransactionLane } from "@openlup/platform/data";
import { createPostgresMigrationRunner } from "@openlup/platform/migrations";
import { createEnvAdvisoryLock } from "@openlup/platform/scheduler";
import { createPostgresCustomerMePort, createPostgresPrivacyStore, createPostgresCustomerChallengeStore, createDirectOperatorInvitationStore, createDirectOperatorIdentityDirectory, createSupabaseIdentityVerifier as createManagedVerifier, createSupabaseAccountLinkStore as createManagedLinkStore, createPostgresOperatorIdentityStore, createOperatorSessionService, createOperatorAdminAuth, createOperatorIdentityVerifier, createPostgresPrivacyUnitOfWork, createManagedPrivacyStore, createPersonalDataContributorRegistry } from "@openlup/platform/identity";
import { operatorChallengeRequestSchema, operatorSessionSchema, privacyExportRequestSchema } from "@openlup/platform/identity/contracts";

assert.equal(typeof createOperatorSessionService, "function");
assert.equal(createManagedPrivacyStore().erasureSupported, false);
assert.deepEqual(createPersonalDataContributorRegistry([], { requiredContributorIds: ["identity"] }).missingContributors, ["identity"]);
assert(privacyExportRequestSchema.safeParse({ subject: { kind: "contact", contactId: "11111111-1111-4111-8111-111111111111" } }).success);
assert.equal(typeof createOperatorAdminAuth, "function");
assert.equal(typeof createOperatorIdentityVerifier, "function");
assert(operatorChallengeRequestSchema.safeParse({ email: "admin@example.invalid" }).success);
assert(!operatorSessionSchema.safeParse({ accessToken: "incomplete" }).success);
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
    async () => { const store = createPostgresOperatorIdentityStore({ connectionString }); try { return await store.findMembership("11111111-1111-4111-8111-111111111111"); } finally { await store.close(); } },
    async () => { const lane = createPostgresPrivacyUnitOfWork({ connectionString }); try { return await lane.run(async () => "privacy"); } finally { await lane.close(); } },
    () => createPostgresDataGateway({ connectionString }).asActor({ role: "authenticated", sub: "11111111-1111-4111-8111-111111111111" }, db => createPostgresCustomerMePort(db).getCustomerMe("11111111-1111-4111-8111-111111111111")),
    async () => { const lane = createPostgresPrivacyUnitOfWork({ connectionString }); try { return await lane.run(db => createPostgresPrivacyStore().findReceipt(db, { kind: "contact", contactId: "11111111-1111-4111-8111-111111111111" })); } finally { await lane.close(); } },
    async () => { const store = createPostgresCustomerChallengeStore({ connectionString }); try { return await store.pruneChallenges({ limit: 1 }); } finally { await store.close(); } },
    async () => { const store = createDirectOperatorInvitationStore({ connectionString }); try { return await store.read("11111111-1111-4111-8111-111111111111"); } finally { await store.close(); } },
    async () => { const directory = createDirectOperatorIdentityDirectory({ connectionString }); try { return await directory.ensurePrincipal({ email: "operator@example.invalid", redirectTo: "https://example.invalid/admin/auth/callback" }); } finally { await directory.close(); } },
  ];
}
const structuralClient = {
  auth: { getUser: async () => ({ data: { user: { id: "11111111-1111-4111-8111-111111111111", email: "customer@example.invalid", email_confirmed_at: "2026-01-01T00:00:00Z" } }, error: null }) },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
};
assert.equal((await createManagedVerifier(structuralClient).verifyAccessToken("synthetic")).emailVerified, true);
assert.equal(await createManagedLinkStore(structuralClient).findAccountByPrincipalId("11111111-1111-4111-8111-111111111111"), null);
`;

export function proveAdapterRefusals(consumer: string): void {
  consumerNode(consumer, adapterOperations + `
const blob = bindBlobPort("s3", { BLOB_S3_BUCKET: "consumer", BLOB_S3_BASE_URL: "https://example.invalid" });
const checks = [["@aws-sdk/client-s3", () => blob.upload("probe", Buffer.from("probe"))],
  ...Object.values(postgresOperations("postgresql://unused.invalid/consumer")).map(operation => ["pg", operation])];
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
for (const operation of Object.values(postgresOperations("postgresql://synthetic@localhost:invalid/consumer"))) {
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

export function provePostgresOperations(consumer: string, connectionString: string): void {
  consumerNode(consumer, adapterOperations + `
const operations = postgresOperations(process.argv[2]);
assert.equal(await operations[0](), "service");
assert.equal(await operations[1](), "transaction");
assert.deepEqual(await operations[2](), { pending: ["baseline.sql"], applied: [] });
await operations[3]();
// A selected driver alone cannot enable operator login without its migrated schema.
await assert.rejects(() => operations[4](), error => error.code === "42P01");
assert.equal(await operations[5](), "privacy");
// Default gateway and migration pools have no public shutdown API.
process.exit(0);
`, [connectionString]);
}

/** Runs from the installed artifact with optional peers physically absent. */
export function proveCommunicationsConsumer(consumer: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { createInMemoryEmailTransport, createPostgresTransactionalDeliveryStore, resolveCapturedDocumentDelivery } from "@openlup/platform/communications";
import * as contracts from "@openlup/platform/communications/contracts";
import { timingSafeStringEqual } from "@openlup/platform/http";
assert.deepEqual(Object.keys(contracts).sort(), ["accentBox","button","createAbandonedCartContentFactory","createBackInStockContentFactory","createCheckoutExpiredContentFactory","createCheckoutRecoveryContentFactory","createInquiryContentFactory","createInvoiceDocumentContentFactory","createOptOutContentFactory","createOrderCanceledContentFactory","createOrderDraftContentFactory","createOrderPaidContentFactory","createOrderRefundedContentFactory","createPaymentFailedContentFactory","createReorderReminderContentFactory","createReturnEmailsContentFactory","createReviewEffectsContentFactory","createReviewRequestContentFactory","createRoleNotificationContentFactory","createShipmentDeliveredContentFactory","createShipmentDispatchedContentFactory","createShipmentExceptionContentFactory","createSubscriptionActivationActionRequiredContentFactory","createSubscriptionAddressChangedContentFactory","createSubscriptionCancelledContentFactory","createSubscriptionCycleSkippedContentFactory","createSubscriptionDeliveryRescheduledContentFactory","createSubscriptionPackageChangedContentFactory","createSubscriptionPauseReminderContentFactory","createSubscriptionPausedContentFactory","createSubscriptionPaymentExpiredContentFactory","createSubscriptionPaymentFailedContentFactory","createSubscriptionPaymentRecoveredContentFactory","createSubscriptionRenewalAtRiskContentFactory","createSubscriptionRenewalUpcomingContentFactory","createSubscriptionResumedContentFactory","createSubscriptionWelcomeContentFactory","createSubscriptionWinbackContentFactory","dataTable","divider","featureCard","guideCardBlock","heading","linkParagraph","list","paragraph","renderEmail"]);
// Optional peers are physically absent in this phase. Rendering must be pure.
const previousFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("contracts rendering must never fetch"); };
try {
  const rendered = contracts.renderEmail({ brand: { copyBrandName: "Example", theme: { bodyBg: "#fff", cardBg: "#fff", accentBg: "#eee", hairline: "#ccc", brand: "#123", onBrand: "#fff", textHeading: "#111", textBody: "#222", textMuted: "#555", fontFamily: "Arial", logoText: "Example", cardRadiusPx: 12, buttonRadiusPx: 8, maxWidthPx: 600 }, chrome: { pl: { logoAlt: "Example", footerTagline: "Polish footer" }, en: { logoAlt: "Example", footerTagline: "EN footer" } } }, locale: "en", subject: "Synthetic", blocks: [contracts.paragraph("<probe>"), contracts.button("Open", "https://example.invalid")] });
  assert.equal(rendered.subject, "Synthetic");
  assert(rendered.html.includes("&lt;probe&gt;"));
  assert(rendered.html.includes('href="https://example.invalid"'));
  assert.equal(rendered.text, "<probe>\\n\\nOpen: https://example.invalid\\n\\nEN footer");
  for (const locale of ["pl", "en"]) {
    const invoice = contracts.createInvoiceDocumentContentFactory().invoiceDocumentEmailContent(locale, { kind: "invoice", orderRef: "ORDER-1", documentNumber: "DOC/1", accountDocumentsUrl: "https://example.test/documents" });
    assert.equal(invoice.subject, locale === "pl" ? "Faktura do zamówienia ORDER-1" : "Invoice for order ORDER-1");
    assert.equal(invoice.blocks[3].href, "https://example.test/documents");
    const role = contracts.createRoleNotificationContentFactory().roleNotificationEmailContent(locale, { role: "admin", operatorUrl: "https://example.test/admin" });
    assert.equal(role.subject, locale === "pl" ? "Uprawnienia operatora: admin" : "Operator membership: admin");
    const inquiry = contracts.createInquiryContentFactory();
    const vars = { displayName: "Alex Example", contact: "alex@example.test", details: [], operatorUrl: "https://example.test/inquiry" };
    assert.equal(inquiry.inquiryReceiptEmailContent(locale, vars, "Team").subject, locale === "pl" ? "Otrzymaliśmy Twoje zapytanie" : "We've received your inquiry");
    assert.equal(inquiry.inquiryNoticeEmailContent(locale, vars, "Team").blocks[3].href, vars.operatorUrl);
    assert.equal(contracts.createOptOutContentFactory().optOutContent(locale, "error", "support@example.test").title, locale === "pl" ? "Błąd" : "Error");
  }
} finally { globalThis.fetch = previousFetch; }
assert(timingSafeStringEqual("synthetic", "synthetic"));
globalThis.fetch = () => { throw new Error("capture must never fetch"); };
const transport = createInMemoryEmailTransport();
assert.equal((await transport.send({ from: "sender@example.invalid", to: "recipient@example.invalid", subject: "Synthetic", html: "<p>Synthetic</p>" })).outcome.resendId, "in-memory-1");
assert.equal(transport.sent.length, 1);
assert.equal(resolveCapturedDocumentDelivery({}).refused, "document_delivery_channel_undeclared");
const store = createPostgresTransactionalDeliveryStore({ connectionString: "postgresql://unused.invalid/synthetic" });
let missingPeer;
await assert.rejects(() => store.readReceipt("synthetic:1"), error => {
  missingPeer = error;
  return error.message.startsWith("OPENLUP_E_PEER_MISSING: pg is required by ") && Boolean(error.cause);
});
for (const [factory,options,operation] of [
  ["createPostgresDeliveryReconciliationPort",{binding:"synthetic"},store=>store.findFrozenSends({now:"2026-10-19T12:00:00Z",graceMinutes:10,limit:1})],
  ["createPostgresCommunicationSyncStore",{binding:"synthetic",providerKind:"synthetic",rail:()=>{throw new Error("peer must fail first");}},store=>store.claimBatch({providerKind:"synthetic",batchSize:1,visibilitySeconds:60,maxAttempts:2})],
  ["createPostgresNotificationRecipientsPort",{operatorId:"synthetic"},store=>store.listNotificationRecipients({notification_type:"new_signup"})],
  ["createPostgresConsentEvaluator",{},store=>store.evaluate({email:"cold@example.invalid",purpose:"transactional"})],
]) {
  const module=await import("@openlup/platform/communications"), native=module[factory]({connectionString:"postgresql://unused.invalid/synthetic"},options);
  await assert.rejects(()=>operation(native),error=>{const refusal=error.name==="ConsentEvaluationUnavailableError"?error.cause:error;return refusal.message.startsWith("OPENLUP_E_PEER_MISSING: pg is required by ")&&Boolean(refusal.cause);});
  await assert.rejects(()=>native.close());
}
// No pool was created; closing repeats the cached initialization refusal.
await assert.rejects(() => store.close(), error => error === missingPeer);
`);
}

/** Sparse projected units are exercised in an owned disposable database only. */
export function proveCommunicationsPostgres(consumer: string, connectionString: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { COMMUNICATIONS_MIGRATIONS, createPostgresTransactionalDeliveryStore, createCapturedTransactionalDelivery, createTransactionalDelivery } from "@openlup/platform/communications";
const connectionString = process.argv[2], client = new pg.Client({ connectionString });
await client.connect();
try {
  for (const unit of COMMUNICATIONS_MIGRATIONS) await client.query(readFileSync(unit.url, "utf8"));
  const store = createPostgresTransactionalDeliveryStore({ connectionString });
  let deliveries = 0;
  const delivery = createCapturedTransactionalDelivery({ outcome: () => { deliveries++; return { state: "accepted" }; } });
  const action = createTransactionalDelivery({ store, delivery });
  const command = { idempotencyKey: "synthetic:receipt", recipientReference: "contact:1", templateReference: "template:1" };
  try {
    const first = await action.send(command);
    assert.equal(first.state, "accepted");
    assert.deepEqual(await action.send(command), first);
    assert.equal(deliveries, 1);
    await assert.rejects(() => action.send({ ...command, templateReference: "template:2" }), error => error.message === "transactional_delivery_command_conflict");
    await assert.rejects(() => client.query("SELECT * FROM public.communications_delivery_readiness($1)", ["11111111-1111-4111-8111-111111111111"]), error => error.message.includes("operator"));
    await client.query("SET ROLE anon");
    await assert.rejects(() => client.query("SELECT * FROM public.transactional_delivery_receipts"), error => error.code === "42501");
    await client.query("RESET ROLE");
  } finally { await store.close(); }
} finally { await client.end(); }
`, [connectionString]);
}

/** Useful installed native operations against a complete canonical catalogue installed by the reference runner. */
export function proveNativeCommunicationsOperations(consumer: string, connectionString: string): void {
  consumerNode(consumer, `
import assert from "node:assert/strict";
import { createPostgresDeliveryReconciliationPort,createPostgresCommunicationSyncStore,createPostgresNotificationRecipientsPort,createPostgresConsentEvaluator,createGuardedEmailTransport,guardEmailTransport,createInMemoryEmailTransport,runCommunicationSyncDispatch } from "@openlup/platform/communications";
const env={connectionString:process.argv[2]},binding="cold-native";
const rail=db=>({
  claimBatch: async input=>(await db.query("SELECT * FROM public.outbox_claim_batch($1,$2,$3,$4,$5)",[input.eventTypes,input.knownEventTypes,input.batchSize,input.visibilitySeconds,input.maxAttempts])).rows,
  markProcessed: async input=>({applied:(await db.query("SELECT public.outbox_mark_processed($1,$2,'{}') AS value",[input.eventId,input.claimToken])).rows[0].value}),
  markFailed: async input=>({status:(await db.query("SELECT public.outbox_mark_failed($1,$2,$3,$4,$5,$6,$7,$8) AS value",[input.eventId,input.claimToken,input.error,input.outcome,input.baseDelaySeconds,input.maxDelaySeconds,input.maxAttempts,input.snoozeSeconds])).rows[0].value}),
});
const delivery=createPostgresDeliveryReconciliationPort(env,{binding}),sync=createPostgresCommunicationSyncStore(env,{binding,providerKind:"synthetic",rail});
const consent=createPostgresConsentEvaluator(env),directory=createPostgresNotificationRecipientsPort(env,{operatorId:"b3000000-0000-4000-8000-000000000001"});
try {
  const target={sourceKey:"cold:send",messageId:"network:cold",recipientEmail:"cold@example.invalid",templateReference:"synthetic",acceptedAt:"2026-10-19T10:00:00Z",evidence:"network_accepted"};
  const registered=await delivery.registerNetworkTarget(target);
  assert.equal(typeof registered.id,"string");
  assert.equal((await delivery.findFrozenSends({now:"2026-10-19T12:00:00Z",graceMinutes:10,limit:10}))[0]?.id,registered.id,"no-op store must refuse proof");
  assert.equal((await delivery.readEvidence(registered.id)).observedState,null,"acceptance is not delivery");
  assert.deepEqual(await delivery.findByMessageId(target.messageId),{id:registered.id},"selected message lookup must reach stored evidence");
  assert.equal((await delivery.listEvidence({limit:10})).some(row=>row.id===registered.id),true,"bounded evidence must include the actual target");
  await assert.rejects(()=>delivery.registerNetworkTarget({...target,sourceKey:"capture",messageId:"captured:1",evidence:"capture"}));
  await delivery.applyPolledEvent({sendId:registered.id,messageId:target.messageId,eventType:"delivered",eventAt:"2026-10-19T12:00:00Z",recipientEmail:target.recipientEmail});
  assert.equal((await delivery.readEvidence(registered.id)).observedState,"delivered");
  const work=await sync.registerWork({sourceKey:"cold:sync",contactId:"synthetic",normalizedEmail:target.recipientEmail,eventType:"subscribe",purpose:"marketing_newsletter"});
  const [claimed]=await sync.claimBatch({providerKind:"synthetic",batchSize:10,visibilitySeconds:60,maxAttempts:2});
  assert.equal(claimed?.id,work.id);
  assert.equal(await sync.markSent({eventId:work.id,claimToken:"wrong",providerKind:"synthetic"}),false,"wrong token must not settle");
  assert.equal(await sync.markSent({eventId:work.id,claimToken:claimed.claimToken,providerKind:"synthetic"}),true);
  assert.equal(await sync.markSent({eventId:work.id,claimToken:claimed.claimToken,providerKind:"synthetic"}),false);
  assert.deepEqual(await sync.claimBatch({providerKind:"synthetic",batchSize:10,visibilitySeconds:60,maxAttempts:2}),[],"second executor must see no settled work");
  await directory.createNotificationRecipient({email:"operator-recipient@example.invalid",name:"Synthetic",notification_type:"new_signup",active:true});
  const [recipient]=(await directory.listNotificationRecipients({notification_type:"new_signup"})).recipients;
  assert.equal(recipient.email,"operator-recipient@example.invalid");
  await directory.updateNotificationRecipient({recipientId:recipient.id,active:false});
  assert.equal((await directory.listNotificationRecipients({notification_type:"new_signup"})).recipients[0].active,false);
  await directory.deleteNotificationRecipient({recipientId:recipient.id});
  assert.deepEqual((await directory.listNotificationRecipients({notification_type:"new_signup"})).recipients,[]);
  const decision=await consent.evaluate({email:target.recipientEmail,purpose:"marketing_newsletter"});
  assert.equal(decision.allowed,false);assert.equal(typeof decision.decisionId,"string");
  assert.deepEqual(consent.guarantees,{managedFrequencyCaps:false,legacyContactTouching:false,sendTimeFence:false});
  const message={from:"sender@example.invalid",to:"intended@example.invalid",subject:"Synthetic",html:"<p>Synthetic</p>"};
  let effects=0;
  const raw={providerKind:"synthetic-raw",send:async()=>{effects++;throw Error("raw adapter must refuse before effect");}};
  assert.equal((await guardEmailTransport(raw).send(message)).outcome.ok,false);assert.equal(effects,0);
  for(const providerKind of ["synthetic-a","synthetic-b"]){
    const transport=createGuardedEmailTransport({providerKind,policy:intendedRecipient=>({mode:"sandbox_sink",reason:"synthetic_sink",intendedRecipient,recipient:"sink@example.invalid",credential:"synthetic",environmentTag:"non_production"}),send:async(selected,context)=>{
      assert.equal(selected.to,"sink@example.invalid");assert.equal(context.intendedRecipient,message.to);assert.equal(context.environmentTag,"non_production");effects++;
      return {outcome:{ok:true,resendId:"network:"+providerKind,httpStatus:202,providerError:null,aborted:false},providerResponse:{accepted:true}};
    }});
    const result=await guardEmailTransport(transport).send(message);
    assert.equal(result.outcome.ok,true);assert.equal(result.outcome.egressMode,"sandbox_sink");
    const acceptance=await delivery.registerNetworkTarget({...target,sourceKey:providerKind,messageId:result.outcome.resendId});
    assert.equal((await delivery.readEvidence(acceptance.id)).observedState,null);
  }
  await createInMemoryEmailTransport().send(message);assert.equal(effects,2,"capture must not call the network sender");
  let membershipEffects=0;
  const selectedProvider={providerKind:"synthetic",capabilities:{subscribe:true,unsubscribe:true,suppress:true,unsuppress:false,doubleOptIn:false,emailChange:false,listMembership:false,webhookIdempotency:false,retryAfter:false},sync:async event=>{assert.equal(event.normalizedEmail,target.recipientEmail);membershipEffects++;return {status:"sent"};}};
  await sync.registerWork({sourceKey:"cold:substitute",contactId:"synthetic-substitute",normalizedEmail:target.recipientEmail,eventType:"unsubscribe",purpose:"marketing_newsletter"});
  assert.equal((await runCommunicationSyncDispatch({store:sync,provider:selectedProvider})).sent,1);
  assert.equal((await runCommunicationSyncDispatch({store:sync,provider:selectedProvider})).checked,0);
  assert.equal(membershipEffects,1);assert.equal((await consent.evaluate({email:target.recipientEmail,purpose:"marketing_newsletter"})).allowed,false,"provider settlement must not grant permission");
} finally {await Promise.all([delivery.close(),sync.close(),consent.close(),directory.close()]);}
`, [connectionString]);
}

/** Setup uses the existing canonical runner; subjects resolve only from installed artifacts. */
function proveNativeCommunicationsPostgres(consumer: string): void {
  const started = performance.now();
  const name = `openlup-native-proof-${randomUUID()}`;
  const docker = (args: string[]) => command("docker", args, root, isolatedConsumerEnv()).trim();
  try {
    // Complete catalogue fingerprints use the repository harness's PostgreSQL 16 profile.
    docker(["run","--detach","--rm","--name",name,"--cpus=1","--memory=512m","--pids-limit=128","--tmpfs","/var/lib/postgresql/data","--publish","127.0.0.1::5432","--env","POSTGRES_HOST_AUTH_METHOD=trust","postgres:16"]);
    const port = docker(["port",name,"5432/tcp"]).split(":").at(-1)!;
    const connectionString = `postgresql://postgres@127.0.0.1:${port}/postgres`;
    // Host TCP readiness, through the same repository harness as the real-PG witness.
    command(process.execPath,["--import",import.meta.resolve("tsx"),"--input-type=module","-e",`
      import { waitForPostgresTcpReady } from ${JSON.stringify(pathToFileURL(join(root,"tests/helpers/postgresContainer.ts")).href)};
      import { createPostgresMigrationRunner } from ${JSON.stringify(pathToFileURL(join(root,"server/adapters/postgres/migrationRunner.ts")).href)};
      import pg from "pg";
      const connectionString=process.argv[1];
      if(!await waitForPostgresTcpReady(connectionString))throw new Error("Native cold PG unavailable");
      const runner=createPostgresMigrationRunner({connectionString});await runner.apply();
      const client=new pg.Client({connectionString});await client.connect();
      try {
        await client.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES ('b3000000-0000-4000-8000-000000000001','admin@example.invalid')");
        await client.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES ('b3000000-0000-4000-8000-000000000001','admin','active','legacy',now())");
        await client.query("INSERT INTO public.platform_communication_operators(principal_id) VALUES ('b3000000-0000-4000-8000-000000000001')");
      } finally {await client.end();}
      process.exit(0);
    `,connectionString],root,isolatedConsumerEnv());
    proveNativeCommunicationsOperations(consumer,connectionString);
  } finally {docker(["rm","--force",name]);}
  console.log(`Native communications installed proof PASS (PostgreSQL 16, complete canonical catalogue; ${Math.round(performance.now()-started)} ms including setup/cleanup)`);
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
    provePostgresOperations(consumer, `postgresql://postgres@127.0.0.1:${port}/${database}`);
    proveCommunicationsPostgres(consumer, `postgresql://postgres@127.0.0.1:${port}/${database}`);
    consumerNode(consumer, adapterOperations + `
const operations = postgresOperations(process.argv[2]);
// The appended identity adapters also require their migrated schema.
for (const index of [6, 7, 8, 9, 10]) {
  await assert.rejects(operations[index], error => error.code === "42P01");
}
process.exit(0);
`, [`postgresql://postgres@127.0.0.1:${port}/${database}`]);
    proveNativeCommunicationsPostgres(consumer);
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
    // The offline phase installs only local tarballs: npm ci caches the lockfile's tarballs but not their
    // registry metadata, so a cold runner cannot resolve version specs offline. Pack the locked runtime and
    // type inputs from the root's installed directories, as the Outbox proof does.
    const packInstalled = (name: string): string => {
      const directory = join(checkout, "node_modules", name);
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error(`Consumer input ${name} must be an ordinary installed directory`);
      const version = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
      if (`${name}@${version}` !== locked(name)) throw new Error(`Consumer input ${name} differs from the lockfile`);
      const [info] = JSON.parse(command("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", artifacts], directory, isolatedConsumerEnv()));
      return join(artifacts, info.filename);
    };
    install([...tarballs, ...["zod", "@types/node", "undici-types"].map(packInstalled)]);
    assertConsumerIsolation(consumer, checkout);
    assertExportInventory(consumer);
    for (const entry of NON_ADAPTER_ENTRIES) consumerNode(consumer, `await import("@openlup/platform/${entry}");`);
    consumerNode(consumer, `
import assert from "node:assert/strict";
import * as catalog from "@openlup/platform/catalog";
import * as contracts from "@openlup/platform/catalog/contracts";
assert.equal(catalog.CatalogSkuAuthorityError, contracts.CatalogSkuAuthorityError);
assert.equal(catalog.canonicalCatalogDraftJson, contracts.canonicalCatalogDraftJson);
assert.equal(contracts.canonicalCatalogDraftJson({z:2,a:1}), '{"a":1,"z":2}');
assert.throws(() => contracts.canonicalCatalogDraftJson({value:NaN}), /draft_json_invalid/);
assert.throws(() => contracts.requireCurrentCatalogDocumentAuthority("product", null, null), contracts.CatalogSkuAuthorityError);
assert.deepEqual(catalog.parseCatalogActiveSkuSelection([" ITEM-1 "]), ["ITEM-1"]);
assert.throws(() => catalog.parseCatalogActiveSkuSelection(["ITEM-1", " ITEM-1 "]), /catalog_active_sku_selection_invalid/);
const handler = catalog.createCatalogDraftHandler({ store: {}, registry: {}, authorizeOperator: async () => null });
assert.deepEqual(await handler.execute({}, {}), { outcome: "unauthorized", reason: "draft_operator_required" });
`);
    consumerNode(consumer, `
import assert from "node:assert/strict";
import * as pricing from "@openlup/platform/pricing";
import * as contracts from "@openlup/platform/pricing/contracts";
assert.equal(pricing.OFFER_POLICY_V2, contracts.OFFER_POLICY_V2);
assert.equal(contracts.ACQUISITION_TERMS_CAPABILITY, "subscription-acquisition.v1");
assert.equal(contracts.COMMERCE_OFFER_PRICING_V3_CONTRACT_VERSION, "commerce.offer-pricing.v3");
assert.equal("selectAcquisitionTerms" in contracts, false);
assert.throws(() => pricing.selectAcquisitionTerms([], "2026-10-01T00:00:00Z", "ZZ", undefined),
  error => error instanceof pricing.AcquisitionTermsError && error.reason === "acquisition_terms_policy_unconfigured");
assert.equal(pricing.acquisitionExpectationChanged(undefined, undefined), false);
assert.equal(pricing.acquisitionExpectationChanged({ revision: "example-a", delivery2DiscountBps: 1700 }, undefined), true);
assert.deepEqual(pricing.acquisitionQuoteBinding(), {});
assert.equal(contracts.COMMERCE_CONTRACT_VERSION, "commerce.v0");
assert.equal("createCommerceQuoteSchemas" in contracts, false);
assert.equal("catalogFactsProvenanceSchema" in contracts, false);
assert.deepEqual(pricing.splitIncludedVat(12300, 2300), { netMinor: 10000, vatMinor: 2300 });
assert.deepEqual(pricing.calculateIncludedVat(12300, 2300), { netMinor: 10000, vatMinor: 2300 });
assert.equal(contracts.COMMERCE_OFFER_PRICING_CONTRACT_VERSION, "commerce.offer-pricing.v1");
assert.equal("createCommerceOfferPricingHandler" in contracts, false);
const readiness = pricing.createOfferPolicyReadinessCache({ now: () => 0 });
assert.equal((await readiness.read({ readOfferPolicyV2Readiness: async () => ({ ready: true }) })).ready, false);
const cache = pricing.createCommerceOfferPricingCache({ ttlMs: 10, now: () => 0 });
const value = { contractVersion: contracts.COMMERCE_OFFER_PRICING_CONTRACT_VERSION };
assert.equal(await cache.read("v1", async () => value), value);
assert.equal(await cache.read("v1", async () => { throw new Error("cached"); }), value);
const { z } = await import("zod");
const schemas = pricing.createCommerceQuoteSchemas({ currencySchema: z.string().regex(/^[A-Z]{3}$/),
  productSlugSchema: z.string().min(1), contextSchema: z.object({ mode: z.enum(["one_time", "subscription"]), promoCodes: z.array(z.string()) }) });
assert(schemas.createQuoteRequestSchema.safeParse({ lines: [{ sku: "ITEM", quantity: 1 }] }).success);
assert(!schemas.createQuoteRequestSchema.safeParse({ mode: "subscription", lines: [{ sku: "ITEM", quantity: 1 }] }).success);
assert(!pricing.quoteDiscountSchema.safeParse({ promotionEngineVersion: "promotion-engine.v2" }).success);
const profile = { included: true, country: "AA", category: "standard", vatRateBps: 2300, legalBasis: "Example" };
assert.throws(() => pricing.assertSupportedCommerceTaxProfile(profile, []), error => error instanceof pricing.CommerceQuoteError && error.code === "UNSUPPORTED_TAX_PROFILE");
assert.equal(pricing.deriveSubscriptionUnitPrice(1490, { discountBps: 1000, roundingQuantumMinor: 10, roundingRule: "FLOOR_TO_QUANTUM" }), 1340);
assert.equal("createPricingPolicyToken" in contracts, false);
assert.equal("subscriptionPricePolicyRevisionSchema" in contracts, false);
assert.throws(() => pricing.pricingPolicySnapshotSchema.parse({ offerPolicyVersion: contracts.OFFER_POLICY_V1, promotionEngineVersion: contracts.PROMOTION_ENGINE_V2 }));
const authority = pricing.createCommercePriceAuthorityPort({ listPriceLists: async () => [] });
await assert.rejects(authority.resolvePrice({ variantId: "item", mode: "one_time", regionCode: "AA", currency: "XXX", channel: "test", atTime: "2026-09-09T00:00:00.000Z" }), error => error instanceof pricing.CommercePriceAuthorityError && error.code === "active_price_list_not_found");
`);
    consumerNode(consumer, `
import assert from "node:assert/strict";
import * as promotions from "@openlup/platform/promotions";
import * as contracts from "@openlup/platform/promotions/contracts";
assert.deepEqual(Object.keys(contracts), []);
// Promotions imports without pg: its store uses only the host executor. The selected
// data gateway retains the existing named missing-pg refusal (proveAdapterRefusals).
assert.equal(typeof promotions.createPostgresCommercePromoDataPort, "function");
let sqlCalls = 0;
const executor = { query: async sql => { sqlCalls++; assert(sql.includes("active_definitions")); return { rows: [{ result: [] }] }; } };
assert.deepEqual(await promotions.createPostgresCommercePromoDataPort(executor).listActivePromotions(), []);
assert.equal(sqlCalls, 1);
assert.deepEqual(promotions.PROMOTIONS_MIGRATIONS.map(unit => unit.position), [47, 48]);
const { applyPromotionCodesV2 } = promotions.createQuotePromotionCodeAdjustments({ minimumProductPayableMinor: 100 });
let reads = 0;
const input = { clientId: null, mode: "one_time", promoCodes: ["save"], referenceProductMinor: 10000,
  subtotalGrossMinor: 10000, shippingGrossMinor: 0, discounts: [], codeRejections: [], atTime: "2026-10-01T00:00:00.000Z" };
const result = await applyPromotionCodesV2({ ...input, port: { async resolve(facts) {
  reads++; assert.equal(facts.purchaseScope, "one_time");
  return { candidates: [{ promotionId: "promotion", codeId: "code", source: "code", name: "Example", code: "SAVE",
    lane: "product", kind: "target_percentage", valueBps: 8000, scopes: ["one_time"], codeRevision: 1,
    definitionFingerprint: "a".repeat(64), minimumReferenceMinor: 0, validTo: null }], codeRejections: [], codeRejectionDetails: [] };
} } });
assert.equal(reads, 1);
assert.equal(result.discounts[0].amountOffMinor, 8000);
const money = amountMinor => ({ amountMinor, currency: "XXX" });
const quote = { currency: "XXX", taxIncluded: true, lines: [], discounts: result.discounts,
  totalGross: money(2000), netTotal: money(2000), taxTotal: money(0), subtotalGross: money(10000), discountTotalGross: money(8000) };
const request = { promoCodes: ["save"] }, keyring = { current: "synthetic-acceptance-key-000000000000000000" }, now = new Date(input.atTime);
const acceptance = promotions.createPromotionQuoteAcceptance({ projectRequest: value => value });
const token = acceptance.issuePromotionQuoteAcceptance({ request, quote, keyring, now });
assert(token);
assert(acceptance.verifyPromotionQuoteAcceptance({ token, request, quote, keyring, now, expectedTotal: quote.totalGross }));
assert(!acceptance.verifyPromotionQuoteAcceptance({ token, request, quote: { ...quote, totalGross: money(2001) }, keyring, now, expectedTotal: quote.totalGross }));
await assert.rejects(applyPromotionCodesV2({ ...input, port: { resolve: async () => { throw new Error("read unavailable"); } } }), /read unavailable/);
assert.throws(() => promotions.resolvePromotionBenefitDefinition({ discount_type: "unknown", discount_value: 0 }), /promotion_v1_benefit_invalid/);
`);
    const compiler = join(checkout, "node_modules/typescript/bin/tsc");
    compileConsumer(consumer, NON_ADAPTER_ENTRIES, compiler);
    assertConsumerIsolation(consumer, checkout); // Compilation must not have supplied a peer.
    proveAdapterRefusals(consumer);
    proveOidcRefusals(consumer);
    proveCommunicationsConsumer(consumer);
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
