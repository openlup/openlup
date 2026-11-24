import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Pool } from "pg";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import { createPostgresRoleFreeTransactionLane, type PgQueryExecutor } from "@openlup/platform/data";
import { createPostgresPrivacyStore, createPrivacyOperations, createIdentityPersonalDataContributor,
  createPersonalDataContributorRegistry, createDestinationReceiptPrivacyContributor, createDestinationDocumentPrivacyContributor,
} from "@openlup/platform/identity";
import { commerceQuoteV2Schema, quoteDigest, type CommerceQuoteMoneyV2, type CommerceQuoteV2 } from "@openlup/platform/pricing";
import { composeNativePrivacy } from "../../server/runtime/auth/privacyBinding.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { captureStoreJourney, journeySelection, storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { destinationContext, destinationHash, reachDestinationCutoff, snapshot } from "./destinationDocumentFixture.js";

const resources = storeJourneyResources();
let store: JourneyInstallation;
beforeAll(async () => { store = await resources.installation("tax-calculations"); }, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

const frame = (tag: string, body: unknown) => canonicalCatalogDraftJson(["platform.tax." + tag + ".v1", body]);
const digest = (tag: string, body: unknown) => destinationHash(frame(tag, body));
const bound = "a".repeat(64);
const taxDate = "2026-06-05T10:00:00.000Z";
const guardRefusal = { code: "55000", message: "tax_evaluation_integrity_invalid", detail: "/taxEvidence" };

async function seed(state: "pending" | "terminal" = "terminal", db = store, options: {
  providerRef?: string; badQuoteDigest?: boolean; refusal?: boolean; badOutcomeDigest?: boolean;
} = {}) {
  const ctx = await destinationContext(db.owner);
  const { binding: destination, evidenceExpiresAt: validUntil } = await snapshot(db.runtime, ctx);
  const identity = { clientId: ctx.clientId, principalRef: ctx.owner.principalRef, installationRef: ctx.owner.installationRef,
    scopeRef: ctx.scopeRef, evaluationKey: randomUUID() };
  const calculationId = randomUUID(), claimToken = randomUUID();
  const kind = "tax_calculation", generation = 1;
  const invocationDigest = digest("evaluation-invocation", identity);
  const requestDigest = digest("evaluation-request", { key: identity.evaluationKey });
  const pin = { invocationDigest, requestDigest, destination, kind, validUntil, request: { key: identity.evaluationKey }, recovery: null };
  const evidence = { adapterEvidence: { calculationRef: options.providerRef ?? randomUUID(), adapterVersion: "fixture-a" } };
  const providerDigest = options.refusal || state === "pending" ? null : digest("provider-calculation", {
    installationRef: identity.installationRef, adapter: "fixture", accountRef: "fixture", mode: "test", providerRef: evidence.adapterEvidence.calculationRef,
  });
  const envelope = { calculationId, invocationDigest, requestDigest, generation, destination, kind, evidence,
    disposition: options.refusal ? "refused" : "required", validUntil };
  const money: CommerceQuoteMoneyV2 = {
    catalogueEvidenceRef: "fixture-catalogue", mode: "one_time", currency: "XXX", destination,
    paymentLimits: { profileRef: "limits", revision: "limits:v1", channelKey: "checkout", currency: "XXX", minMinor: 1, maxMinor: 1000 },
    coverageDigest: bound, deliverySelectionRef: "delivery",
    price: { priceListRef: "list-a", priceContextDigest: bound, priceEvidenceRef: "price-a", classMapRevision: "classes-a" },
    lines: [{ lineKey: "item-z", sourceOrdinal: 1, sku: "item-z", mode: "one_time", quantity: 1, unitBasisMinor: 100,
      taxClassKey: "standard", assignmentRef: "assignment-a", preDiscountMinor: 100, effectiveMinor: 100,
      netMinor: 100, taxMinor: 0, lineTotalMinor: 100, discountAllocations: [], taxPositions: [] }],
    deliveryBuckets: [], feeLines: [], netTotal: 100, taxTotal: 0, feeTotal: 0, payableMinor: 100,
    amountBasis: "exclusive", promotion: { engine: "promotion-engine.v1", rankingRuleRef: "lowest_pre_tax.v1" },
    taxEvidence: { kind, calculationId, taxDate, expiresAt: validUntil, evidenceDigest: digest("evaluation-evidence", envelope) },
  };
  const quoteBody: Omit<CommerceQuoteV2, "quoteDigest"> = { ...money, contractVersion: "commerce.v1", schemaVersion: 2,
    quoteId: randomUUID(), status: "final", moneyDigest: quoteDigest("commerce.quote-money.v2", money) };
  const verifiedQuote = { ...quoteBody, quoteDigest: quoteDigest("commerce.quote.v2", quoteBody) };
  expect(commerceQuoteV2Schema.safeParse(verifiedQuote).success).toBe(true);
  const refusal = { kind: "refused", code: "tax_provider_reference_conflict", field: "/taxEvidence", remedy: "Reconcile the original calculation." };
  const outcome = options.refusal ? { ...refusal, providerMessage: "Do not export private diagnostics" }
    : { kind: "final", quote: { ...verifiedQuote, ...(options.badQuoteDigest && { quoteDigest: bound }) } };
  const bytes = frame("evaluation-outcome", { ...envelope, outcome, submissionDigest: bound, providerDigest, contradiction: false });
  await db.owner.query(`INSERT INTO public.tax_calculations (calculation_id,state,locator,identity,snapshot_ref,pin,pin_digest,
    issued_at,lease_until,generation,claim_token,outcome_text,outcome_digest,provider_digest,contradiction)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),clock_timestamp()+interval '5 minutes',$8,$9,$10,$11,$12,false)`,
  [calculationId, state, digest("evaluation-key", identity), identity, destination.snapshotRef, pin, digest("evaluation-pin", pin), generation,
    claimToken, state === "terminal" ? bytes : null,
    state === "terminal" ? (options.badOutcomeDigest ? bound : destinationHash(bytes)) : null, providerDigest]);
  return { calculationId, ctx, identity, destination, providerDigest, outcome, refusal };
}

async function operator(owner = store.owner) {
  const principalId = randomUUID();
  await owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [principalId, principalId + "@example.invalid"]);
  await owner.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at)
    VALUES($1,'admin','active','legacy',clock_timestamp())`, [principalId]);
  return { principalId };
}
const subject = (contactId: string) => ({ kind: "contact" as const, contactId });
const request = (contactId: string) => ({ subject: subject(contactId), idempotencyKey: randomUUID() });
function privacy(db = store) {
  const unitOfWork = createPostgresRoleFreeTransactionLane<PgQueryExecutor>({ connectionString: db.runtimeUrl }, { pool: db.runtime });
  const store = createPostgresPrivacyStore();
  return { unitOfWork, store, current: composeNativePrivacy({ store, unitOfWork }).operations };
}
const storedRow = (db: Pool, calculationId: string) => db.query(`SELECT jsonb_strip_nulls(to_jsonb(row)) AS value
  FROM public.tax_calculations row WHERE calculation_id=$1`, [calculationId]).then(result => result.rows[0]!.value);

async function disableGuard(table: "tax_calculations" | "identity_privacy_erasures", run: () => Promise<void>) {
  const trigger = table === "tax_calculations" ? "tax_calculation_guard" : "tax_calculation_privacy_guard";
  await store.owner.query(`ALTER TABLE public.${table} DISABLE TRIGGER ${trigger}`);
  try { await run(); }
  finally { await store.owner.query(`ALTER TABLE public.${table} ENABLE TRIGGER ${trigger}`); }
}

it("guards evaluation identity and terminal data, and refuses invalid key, generation and storage domains", async () => {
  const { calculationId } = await seed("pending");
  const terminal = await seed();
  const remove = "DELETE FROM public.tax_calculations WHERE calculation_id=$1";
  const edit = "UPDATE public.tax_calculations SET generation=2 WHERE calculation_id=$1";
  await disableGuard("tax_calculations", async () => {
    const disposable = await seed();
    expect((await store.owner.query(edit, [disposable.calculationId])).rowCount).toBe(1);
    expect((await store.owner.query(remove, [disposable.calculationId])).rowCount).toBe(1);
  });
  await expect(store.owner.query(edit, [terminal.calculationId])).rejects.toMatchObject(guardRefusal);
  await expect(store.owner.query(remove, [terminal.calculationId])).rejects.toMatchObject(guardRefusal);
  await expect(store.owner.query("UPDATE public.tax_calculations SET locator=$2 WHERE calculation_id=$1", [calculationId, bound]))
    .rejects.toMatchObject(guardRefusal);
  await disableGuard("tax_calculations", async () => {
    for (const column of ["locator", "pin_digest", "outcome_digest", "provider_digest"]) {
      for (const invalid of ["", "a".repeat(63), "a".repeat(65), "G".repeat(64), "😀".repeat(64)]) {
        await expect(store.owner.query(`UPDATE public.tax_calculations SET ${column}=$2 WHERE calculation_id=$1`, [terminal.calculationId, invalid]))
          .rejects.toMatchObject({ code: "23514" });
      }
    }
    await expect(store.owner.query("UPDATE public.tax_calculations SET generation=0 WHERE calculation_id=$1", [calculationId]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(store.owner.query("UPDATE public.tax_calculations SET generation=2147483648 WHERE calculation_id=$1", [calculationId]))
      .rejects.toMatchObject({ code: "22003" });
    expect((await store.owner.query("UPDATE public.tax_calculations SET generation=2147483647 WHERE calculation_id=$1", [calculationId])).rowCount).toBe(1);
    await expect(store.owner.query("UPDATE public.tax_calculations SET coverage_account_ref='incomplete' WHERE calculation_id=$1", [calculationId]))
      .rejects.toMatchObject({ code: "23503" });
    await expect(store.owner.query("UPDATE public.tax_calculations SET snapshot_ref=gen_random_uuid() WHERE calculation_id=$1", [calculationId]))
      .rejects.toMatchObject({ code: "23503" });
    await expect(store.owner.query("UPDATE public.tax_calculations SET outcome_text='' WHERE calculation_id=$1", [terminal.calculationId]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(store.owner.query("UPDATE public.tax_calculations SET outcome_text=repeat('é',524288)||'x' WHERE calculation_id=$1", [terminal.calculationId]))
      .rejects.toMatchObject({ code: "23514" });
    expect((await store.owner.query("UPDATE public.tax_calculations SET outcome_text=repeat('é',524288) WHERE calculation_id=$1", [terminal.calculationId]))
      .rowCount).toBe(1);
  });
});

it("exercises the frame's depth and UTF-8 byte ceiling in PostgreSQL", async () => {
  const call = (value: unknown) => store.owner.query(`SELECT octet_length(public.tax_calculation_frame_v1('evaluation-outcome',$1::jsonb)) AS bytes`,
    [JSON.stringify(value)]);
  const room = 1048576 - Buffer.byteLength(frame("evaluation-outcome", ""));
  const edge = "é".repeat(Math.floor(room / 2)) + "x".repeat(room % 2);
  expect((await call(edge)).rows).toEqual([{ bytes: 1048576 }]);
  await expect(call(edge + "x")).rejects.toMatchObject({ code: "22023", message: "tax_invalid_input" });
  let value: unknown = null;
  for (let index = 0; index < 47; index++) value = [value];
  expect((await call(value)).rowCount).toBe(1);
  await expect(call([value])).rejects.toMatchObject({ code: "22023", message: "catalog_publication_wire_invalid" });
});

it("executes the native privacy recipe, verifies historical quote bytes and scrubs terminal and pending data", async () => {
  const actor = await operator(), { current } = privacy();
  const valid = await seed(), pending = await seed("pending"), refused = await seed("terminal", store, { refusal: true });
  const badQuote = await seed("terminal", store, { badQuoteDigest: true });
  const badOutcome = await seed("terminal", store, { badOutcomeDigest: true });
  const document = async (client: string) => (await current.export(actor, subject(client))).documents
    .find(entry => entry.contributorId === "tax-calculations");
  await reachDestinationCutoff(store.owner, valid.destination);
  await reachDestinationCutoff(store.owner, pending.destination);
  expect(await document(valid.ctx.clientId)).toMatchObject({ coverage: { complete: true }, data: [{ outcome: valid.outcome }] });
  expect(await document(pending.ctx.clientId)).toMatchObject({ coverage: { complete: true },
    data: [{ status: "pending", calculationId: pending.calculationId }] });
  expect(await document(refused.ctx.clientId)).toMatchObject({ data: [{ outcome: refused.refusal }] });
  expect(JSON.stringify(await document(refused.ctx.clientId))).not.toContain("Do not export private diagnostics");

  const definitionQuery = `SELECT pg_get_functiondef('public.tax_calculation_terminal_v1(public.tax_calculations)'::regprocedure) AS definition`;
  const definition: string = (await store.owner.query(definitionQuery)).rows[0]!.definition;
  const check = /\s+OR quote->>'quoteDigest' IS DISTINCT FROM encode\(sha256\(convert_to\(public\.catalog_publication_canonical\([\s\S]+?\),'hex'\)/u;
  expect(definition).toMatch(check);
  await store.owner.query(definition.replace(check, ""));
  try {
    expect(await document(badQuote.ctx.clientId)).toMatchObject({ coverage: { complete: true }, data: [{ outcome: badQuote.outcome }] });
  } finally { await store.owner.query(definition); }

  for (const corrupt of [badQuote, badOutcome]) {
    const withheld = await document(corrupt.ctx.clientId);
    expect(withheld).toMatchObject({ coverage: { complete: false },
      data: [{ calculationId: corrupt.calculationId, verification: "failed" }] });
    expect(JSON.stringify(withheld)).not.toContain("quote");
  }
  for (const row of [valid, pending, refused, badQuote, badOutcome]) {
    expect(await current.erase(actor, request(row.ctx.clientId))).toMatchObject({ outcome: "ERASED", obligations: expect.arrayContaining([
      expect.objectContaining({ owner: "tax-calculations", disposition: "erase" }),
      expect.objectContaining({ owner: "tax-calculations", disposition: "retain" }),
    ]) });
    expect((await document(row.ctx.clientId))?.data).toEqual([]);
    expect(await storedRow(store.owner, row.calculationId)).toEqual({ calculation_id: row.calculationId, state: "erased",
      ...(row.providerDigest && { provider_digest: row.providerDigest }) });
  }
});

it("reaches the ledger guard from a rolled-back registration and rolls back identity and destination erasure", async () => {
  const value = await seed(), red = await seed(), actor = await operator();
  const { store: privacyStore, unitOfWork } = privacy();
  // The landed ownership assessment precedes the ledger insert. Declare the same retained contact facts as the reference host.
  const retainedContactFields = Object.fromEntries(["lifecycle_stage", "acquisition_source"].map(field => [field, {
    owner: "clients", resource: `clients.${field}`, disposition: "retain" as const, reasonCode: "CONTACT_LIFECYCLE_RETENTION", remote: false,
  }]));
  const registry = createPersonalDataContributorRegistry([
    createIdentityPersonalDataContributor(privacyStore, { retainedContactFields }, randomUUID),
    createDestinationReceiptPrivacyContributor(), createDestinationDocumentPrivacyContributor(),
  ], { requiredContributorIds: ["identity", "destination-receipts", "destination-documents"] });
  const previous = createPrivacyOperations({ store: privacyStore, unitOfWork, registry, now: () => new Date(), randomId: randomUUID });
  await disableGuard("identity_privacy_erasures", async () => {
    expect(await previous.erase(actor, request(red.ctx.clientId))).toMatchObject({ outcome: "ERASED" });
    expect(await storedRow(store.owner, red.calculationId)).toMatchObject({ state: "terminal" });
  });
  await expect(previous.erase(actor, request(value.ctx.clientId))).rejects
    .toMatchObject({ message: "PRIVACY_CONTRIBUTOR_MISSING", code: "55000" });
  expect((await store.owner.query("SELECT principal_id FROM public.clients WHERE id=$1", [value.ctx.clientId])).rows)
    .toEqual([{ principal_id: value.ctx.owner.principalRef }]);
  expect((await store.owner.query("SELECT evidence_disposition FROM public.commerce_destination_v2_documents WHERE snapshot_ref=$1",
    [value.destination.snapshotRef])).rows).toEqual([{ evidence_disposition: "available" }]);
  expect(await storedRow(store.owner, value.calculationId)).toMatchObject({ state: "terminal" });
});

it("retains the provider marker after erasure and exact-current restore", async () => {
  const db = await resources.installation("provider-source");
  const actor = await operator(db.owner), { current } = privacy(db);
  const providerRef = randomUUID();
  const erased = await seed("terminal", db, { providerRef });
  const pending = await seed("pending", db);
  const historical = await seed("terminal", db);
  await reachDestinationCutoff(db.owner, historical.destination);
  await current.erase(actor, request(erased.ctx.clientId));
  const fence = { calculation_id: erased.calculationId, state: "erased", provider_digest: erased.providerDigest };
  expect(await storedRow(db.owner, erased.calculationId)).toEqual(fence);
  const { clone } = await resources.targetTemplate("provider-target");
  const packet = await captureStoreJourney(db.owner, "tax-source");
  const install = async (label: string) => {
    const target = await clone(label);
    const freshTarget = await captureStoreJourney(target.owner, label);
    expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget })).toMatchObject({ replayed: false });
    return target;
  };
  // Each restored fixture is disposable and has no dispatcher.
  const red = await install("tax-red");
  await red.owner.query("DROP INDEX public.tax_calculations_provider_key");
  expect((await seed("terminal", red, { providerRef })).providerDigest).toEqual(erased.providerDigest);
  const target = await install("tax-target");
  expect(await storedRow(target.owner, erased.calculationId)).toEqual(fence);
  for (const row of [pending, historical])
    expect(await storedRow(target.owner, row.calculationId)).toEqual(await storedRow(db.owner, row.calculationId));
  for (const installation of [db, target]) {
    await expect(seed("terminal", installation, { providerRef }))
      .rejects.toMatchObject({ code: "23505", constraint: "tax_calculations_provider_key" });
  }
});

it("refuses native privacy when its installed RPC privileges are missing", async () => {
  const value = await seed(), actor = await operator(), { current } = privacy();
  await store.owner.query("REVOKE EXECUTE ON FUNCTION public.tax_calculation_export_v1(uuid), public.tax_calculation_erase_v1(uuid) FROM service_role");
  try {
    await expect(current.export(actor, subject(value.ctx.clientId))).rejects.toMatchObject({ code: "42501" });
    await expect(current.erase(actor, request(value.ctx.clientId))).rejects.toMatchObject({ code: "42501" });
  } finally {
    await store.owner.query("GRANT EXECUTE ON FUNCTION public.tax_calculation_export_v1(uuid), public.tax_calculation_erase_v1(uuid) TO service_role");
  }
  expect(await storedRow(store.owner, value.calculationId)).toMatchObject({ state: "terminal" });
  expect((await current.export(actor, subject(value.ctx.clientId))).documents.find(entry => entry.contributorId === "tax-calculations"))
    .toMatchObject({ coverage: { complete: true }, data: [{ outcome: value.outcome }] });
});
