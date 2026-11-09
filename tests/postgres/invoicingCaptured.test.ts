import { createInvoiceAccess } from "@openlup/platform/account-support";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { env as processEnvironment } from "node:process";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresInvoiceStore, runNativeInvoiceIssueJob, invoicePdfFilename as pdfFilename } from "@openlup/platform/invoicing";
import type { InvoiceFacts, InvoiceHostPorts } from "@openlup/platform/invoicing/contracts";
import type * as Native from "@openlup/platform/invoicing/postgres";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer | undefined;
let admin: Pool, runtime: Pool, migration: Pool;
let native: typeof Native;
let scratch: string;
const selection: QualifiedPostgresInstallation = { generation: "qualified-v2", roleMode: "installer-managed",
  bootstrapLogin: "postgres", migrationLogin: "postgres", runtimeLogin: "g9_runtime", restoreLogin: "g9_restore" };
const providerRef = "captured-sandbox";
const seller = { name: "Synthetic seller", address: { line1: "1 Example Street", postalCode: "12345", city: "Example" },
  taxIdentifier: { scheme: "synthetic", value: "seller" }, bankAccount: null, routingRef: null };
const proof = { evidenceRef: "synthetic-money", fingerprint: "a".repeat(64), observedAt: "2026-11-01T12:00:00Z" };
const money: InvoiceHostPorts["money"] = { read: async () => ({ kind: "observed", status: "succeeded", amountMinor: 900, currency: "XXX", proof }) };

beforeAll(async () => {
  if (!await dockerAvailable()) throw Error("G9 requires real PostgreSQL; missing Docker is missing proof");
  container = await runPostgresContainer({ name: `m19-invoice-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw Error("G9 PostgreSQL unavailable");
  admin = new Pool({ connectionString: container.connectionString });
  for (const name of [selection.runtimeLogin, selection.restoreLogin!]) await admin.query(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-only'`);
  const migrationUrl = new URL(container.connectionString);
  migrationUrl.searchParams.set("options", qualifiedPostgresStartupOptions(selection));
  migration = new Pool({ connectionString: migrationUrl.toString() });
  const runner = createPostgresMigrationRunner({ connectionString: container.connectionString }, { installation: selection, poolFactory: () => migration });
  await runner.apply();
  expect(await runner.apply()).toEqual({ applied: [] });
  expect((await runner.status()).pending).toEqual([]);
  const runtimeUrl = new URL(container.connectionString); runtimeUrl.username = selection.runtimeLogin; runtimeUrl.password = "synthetic-only";
  runtime = new Pool({ connectionString: runtimeUrl.toString() });
  expect((await runtime.query("SELECT session_user AS login,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
    .toEqual([{ login: selection.runtimeLogin, rolsuper: false, rolbypassrls: false }]);
  await expect(runtime.query("UPDATE public.invoicing_document_observations SET observation='{}'")).rejects.toMatchObject({ code: "42501" });
  await expect(runtime.query("DELETE FROM public.invoicing_document_observations")).rejects.toMatchObject({ code: "42501" });

  // Provisional installed-artifact proof on the read candidate; final canonical
  // clean-commit packing remains mandatory. No workspace symlink supplies code.
  mkdirSync(".context/scratch", { recursive: true });
  scratch = mkdtempSync(resolve(".context/scratch/invoice-consumer-"));
  const packs = join(scratch, "packs"); mkdirSync(packs);
  const npm = (args: string[], cwd: string) => execFileSync("npm", args, { cwd, encoding: "utf8", timeout: 120_000, env: { ...processEnvironment, NODE_PATH: "" } });
  const pack = (directory: string) => {
    const [info] = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", packs], directory));
    return join(packs, info.filename);
  };
  const artifacts = [pack(resolve("packages/core")), pack(resolve("packages/platform")), pack(resolve("node_modules/zod"))];
  const consumer = join(scratch, "consumer"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "invoice-installed-consumer", private: true, type: "module" }));
  npm(["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", "--package-lock=false", ...artifacts], consumer);
  const require = createRequire(join(consumer, "package.json"));
  const entry = require.resolve("@openlup/platform/invoicing/postgres");
  expect(realpathSync(entry).startsWith(join(consumer, "node_modules", "@openlup", "platform"))).toBe(true);
  const installedManifest = JSON.parse(readFileSync(join(consumer, "node_modules/@openlup/platform/package.json"), "utf8"));
  expect(installedManifest.exports["./invoicing/postgres"].import).toBe("./dist/invoicing/postgres/index.js");
  native = await import(/* @vite-ignore */ pathToFileURL(entry).href);
}, postgresSetupTimeoutMs);

afterAll(async () => {
  await closePostgres(container, [admin, runtime, migration]);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}, postgresTeardownTimeoutMs);

async function fixture(clearanceRequired = false) {
  const principal = randomUUID(), client = randomUUID(), orderId = randomUUID(), intent = randomUUID();
  await admin.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)", [client, `${client}@example.invalid`, principal]);
  const db = await admin.connect();
  try {
    await db.query("BEGIN");
    await db.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',900)", [orderId, client]);
    await db.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,900,900)", [orderId]);
    await db.query("INSERT INTO public.commerce_settlement_intents(id,order_id,channel_key,amount_minor,currency_code,open_idempotency_key) VALUES($1,$2,'sandbox',900,'XXX',$3)", [intent, orderId, `open:${intent}`]);
    await db.query("SELECT public.commerce_record_settlement($1,$2,'succeeded',NULL,'{}',now())", [`paid:${intent}`, intent]);
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  const store = createPostgresInvoiceStore(runtime, { seller: { read: async () => ({ kind: "found", seller, revisionRef: "seller-v1" }) } });
  const capture = { requestKey: `invoice:${orderId}`, sourceKind: "paid" as const, sourceId: randomUUID(), orderId,
    occurredAt: "2026-11-01T12:00:00Z", evidence: { settlementIntentId: intent, amountMinor: 900, currency: "XXX" } };
  const duty = await store.captureDuty(capture);
  expect(await store.captureDuty(capture)).toEqual(duty);
  if ("kind" in duty) throw Error("capture refused");
  const facts: InvoiceFacts = { factRevision: `facts:${orderId}`, policyVersion: "sandbox-v1", refs: { orderId, orderRef: `ORDER/${orderId}`, invoiceRef: `INVOICE/${orderId}` },
    dates: { issueDate: "2026-11-01", sellDate: "2026-11-01", handedOverAt: null, paymentCompletedAt: "2026-11-01T12:00:00Z" },
    documentKind: "sandbox-document", clearanceRequired, currency: "XXX", buyer: { name: "Synthetic buyer", email: null, taxIdentifier: null, companyName: null, address: null },
    payment: { intentRef: intent, providerRef: "sandbox-money", providerPaymentRef: null, amountMinor: 900, currency: "XXX", localSettlementState: "matched" }, orderMoney: null,
    lines: [{ description: "Synthetic item", quantity: 1, unitNetMinor: 750, unitGrossMinor: 900, totalNetMinor: 750, totalTaxMinor: 150, totalGrossMinor: 900, taxRateBps: 2000, positionKind: "item", catalogTotalGrossMinor: null, discountAllocatedMinor: null, shippingGrossMinor: null, shippingDiscountMinor: null }],
    totalNetMinor: 750, totalTaxMinor: 150, totalGrossMinor: 900, chargedTotalGrossMinor: 900 };
  await store.installFacts({ dutyId: duty.dutyId, facts });
  const sweep = await store.sweep(100);
  if ("kind" in sweep) throw Error("sweep refused");
  const lease = sweep.claims.find(row => row.dutyId === duty.dutyId)!;
  const prepared = await store.prepareFacts(lease);
  if ("kind" in prepared || prepared.status !== "ready") throw Error("prepare refused");
  await store.finishFacts({ ...lease, result: { ...prepared, status: "ready" } });
  return { principal, client, orderId, intent, store, facts, dutyId: duty.dutyId };
}

it("runs packed provider issue, replay, owned history/PDF and full reversal through the qualified restricted runtime", async () => {
  const f = await fixture(), foreign = await fixture(true);
  const captured = native.createCapturedPostgresInvoiceProvider(runtime, { enabled: true, providerRef });
  const access = createInvoiceAccess({ accountHistory: native.createPostgresInvoiceAccountHistory(runtime), artifacts: captured.artifacts });
  const ports = native.createPostgresInvoiceAccountHistory(runtime);
  const fiscalBatch = await foreign.store.claim({ providerRef, orderId: foreign.orderId, limit: 1, visibilitySeconds: 300 });
  if ("kind" in fiscalBatch) throw Error("fiscal claim refused");
  const fiscalClaim = fiscalBatch[0]!;
  expect(fiscalClaim.facts.clearanceRequired).toBe(true);
  expect(await foreign.store.preflight({ claim: fiscalClaim, status: "succeeded", amountMinor: 900, currency: "XXX", proof })).toEqual({ kind: "ready" });
  const observationsBefore = (await runtime.query("SELECT count(*)::int AS count FROM public.invoicing_document_observations")).rows;
  expect(await captured.provider.issue({ identity: fiscalClaim.identity as Parameters<typeof captured.provider.issue>[0]["identity"], facts: fiscalClaim.facts, recoveryLookupRequired: false }))
    .toMatchObject({ kind: "refused", code: "blocked", effectMayHaveSucceeded: false });
  expect((await runtime.query("SELECT count(*)::int AS count FROM public.invoicing_document_observations")).rows).toEqual(observationsBefore);
  expect(observationsBefore).toEqual([{ count: 0 }]);
  expect(await access.history({ accountRef: f.principal, orderId: foreign.orderId })).toEqual({ kind: "denied" });
  expect(await access.history({ accountRef: f.client, orderId: f.orderId })).toEqual({ kind: "denied" });
  const batch = await f.store.claim({ providerRef, orderId: f.orderId, limit: 1, visibilitySeconds: 300 });
  if ("kind" in batch) throw Error("claim refused");
  const claim = batch[0]!;
  expect(await captured.provider.read(claim.identity)).toMatchObject({ kind: "absent", evidence: { exact: true, complete: true, scope: claim.identity } });
  expect(await captured.provider.issue({ identity: claim.identity as Parameters<typeof captured.provider.issue>[0]["identity"], facts: claim.facts, recoveryLookupRequired: false }))
    .toMatchObject({ kind: "unknown" });
  expect((await runtime.query("SELECT count(*)::int AS count FROM public.invoicing_document_observations")).rows).toEqual([{ count: 0 }]);
  expect(await f.store.preflight({ claim, status: "succeeded", amountMinor: 900, currency: "XXX", proof })).toEqual({ kind: "ready" });
  const issueInput = { identity: claim.identity as Parameters<typeof captured.provider.issue>[0]["identity"], facts: claim.facts, recoveryLookupRequired: false };
  const [first, raced] = await Promise.all([captured.provider.issue(issueInput), captured.provider.issue(issueInput)]);
  expect([first.kind, raced.kind]).toEqual(["issued", "issued"]);
  if (first.kind !== "issued") throw Error("issue refused");
  expect(await captured.provider.issue({ ...issueInput, recoveryLookupRequired: true })).toMatchObject({ kind: "issued", replayed: true, providerDocumentRef: first.providerDocumentRef });
  expect(await captured.provider.issue({ ...issueInput, facts: { ...claim.facts, totalGrossMinor: 901 } })).toMatchObject({ kind: "refused", code: "identity_mismatch" });
  expect(await captured.provider.read({ ...claim.identity, requestKey: "foreign-key" })).toMatchObject({ kind: "unknown" });
  await f.store.finish({ claim, result: first });
  const restarted = native.createCapturedPostgresInvoiceProvider(runtime, { enabled: true, providerRef });
  expect(await restarted.provider.read(claim.identity)).toMatchObject({ kind: "found", providerDocumentRef: first.providerDocumentRef });
  const original = await access.history({ accountRef: f.principal, orderId: f.orderId });
  expect(original).toMatchObject({ kind: "found", documents: [{ totalGrossMinor: 900, currency: "XXX", role: "original", downloadAvailable: true, isCurrent: true }] });
  if (original.kind !== "found") throw Error("history unavailable");
  const documentRef = original.documents[0]!.documentRef;
  expect(documentRef).toMatch(/[a-f]/);
  for (const spell of [(id: string) => id.toUpperCase(), (id: string) => id.replace(/[ace]/g, letter => letter.toUpperCase())]) {
    const input = { accountRef: spell(f.principal), orderId: spell(f.orderId), documentRef: spell(documentRef) };
    expect(await access.history(input)).toMatchObject({ kind: "found", accountRef: input.accountRef, orderId: input.orderId,
      documents: [{ documentRef }] });
    expect(await ports.resolveDownload(input)).toMatchObject({ kind: "authorized", identity: { documentRef } });
    expect(await access.download(input)).toMatchObject({ kind: "downloaded", fileName: pdfFilename(original.documents[0]!.invoiceRef) });
    expect(await access.download({ ...input, accountRef: spell(foreign.principal) })).toEqual({ kind: "denied" });
    expect(await access.download({ ...input, orderId: spell(foreign.orderId) })).toEqual({ kind: "denied" });
  }
  expect(await access.download({ accountRef: foreign.principal, orderId: f.orderId, documentRef })).toEqual({ kind: "denied" });
  expect(await ports.resolveDownload({ accountRef: f.principal, orderId: foreign.orderId, documentRef })).toEqual({ kind: "denied" });
  expect(await access.download({ accountRef: f.principal, orderId: f.orderId, documentRef: randomUUID() })).toEqual({ kind: "denied" });
  const pdf = await access.download({ accountRef: f.principal, orderId: f.orderId, documentRef });
  expect(pdf.kind).toBe("downloaded");
  if (pdf.kind === "downloaded") expect(Buffer.from(pdf.content).toString()).toContain("NON-FISCAL TEST DOCUMENT");
  const reversal = { requestKey: `reverse:${f.orderId}`, orderId: f.orderId, reason: "order_refunded" as const, proof };
  expect(await f.store.requestReversal(reversal)).toMatchObject({ kind: "correction_requested" });
  expect(await f.store.requestReversal(reversal)).toMatchObject({ kind: "correction_requested", replayed: true });
  expect(await runNativeInvoiceIssueJob({ store: f.store, provider: captured.provider, money,
    readLocalPayment: () => money.read({ intentRef: f.intent, providerRef: "sandbox-money", providerPaymentRef: null, expectedMoney: { amountMinor: 900, currency: "XXX" } }), providerRef, orderId: f.orderId }))
    .toMatchObject({ updated: 1, failures: 0 });
  const corrected = await access.history({ accountRef: f.principal, orderId: f.orderId });
  expect(corrected).toMatchObject({ kind: "found", documents: [{ documentRef, status: "corrected", downloadAvailable: true },
    { parentDocumentRef: documentRef, role: "correction", artifact: "correction", totalGrossMinor: -900, currency: "XXX", downloadAvailable: true }] });
  if (corrected.kind !== "found") throw Error("correction history unavailable");
  expect(await access.download({ accountRef: f.principal, orderId: f.orderId, documentRef: corrected.documents[1]!.documentRef.toUpperCase() })).toMatchObject({ kind: "downloaded", parentDocumentRef: documentRef });
  expect((await runtime.query("SELECT count(*)::int AS count FROM public.invoicing_document_observations WHERE observation->>'format'='openlup.captured-invoice.v1'")).rows).toEqual([{ count: 2 }]);
  expect(await captured.provider.void({ ...claim.identity, operation: "remote_void" })).toMatchObject({ kind: "unsupported" });
// Local restricted integration measured 9.14 s including setup; allow runner headroom.
}, 60_000);
