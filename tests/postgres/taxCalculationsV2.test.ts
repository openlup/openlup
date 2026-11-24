import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Pool } from "pg";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import { createPostgresRoleFreeTransactionLane, type PgQueryExecutor } from "@openlup/platform/data";
import { createPostgresPrivacyStore, createPrivacyOperations, createIdentityPersonalDataContributor,
  createPersonalDataContributorRegistry, createDestinationReceiptPrivacyContributor, createDestinationDocumentPrivacyContributor,
} from "@openlup/platform/identity";
import { commerceQuoteV2Schema, quoteDigest, type CommerceQuoteMoneyV2, type CommerceQuoteV2 } from "@openlup/platform/pricing";
import { createPlatformPostgresMigrationRunner } from "@openlup/platform/migrations";
import { composeNativePrivacy } from "../../server/runtime/auth/privacyBinding.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
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
const frameRefusal = { code: "23514", message: "tax_evaluation_frame_invalid", detail: "/taxEvidence" };
const insertStored = (owner: Pool, row: Record<string, unknown>) => owner.query(
  "INSERT INTO public.tax_calculations SELECT * FROM jsonb_populate_record(NULL::public.tax_calculations,$1)", [row]);

async function seed(state: "pending" | "terminal" = "terminal", db = store, options: {
  providerRef?: string; badQuoteDigest?: boolean; refusal?: boolean; badOutcomeDigest?: boolean;
  unsafe?: "code" | "field" | "remedy"; wrongDestination?: "destinationDigest" | "policyRevision";
  missing?: "invocationDigest" | "requestDigest"; unknownArm?: boolean; expired?: boolean;
  coverage?: { installation: string; account: string; revision: string };
  editRow?: (row: Record<string, unknown>) => void;
} = {}) {
  const ctx = await destinationContext(db.owner);
  const { binding, evidenceExpiresAt } = await snapshot(db.runtime, ctx);
  const destination = { ...binding };
  if (options.wrongDestination) destination[options.wrongDestination] = options.wrongDestination === "destinationDigest" ? bound : "other-revision";
  const validUntil = options.expired ? new Date(Date.parse(taxDate) + 86_400_000).toISOString() : evidenceExpiresAt;
  const identity = { clientId: ctx.clientId, principalRef: ctx.owner.principalRef, installationRef: ctx.owner.installationRef,
    scopeRef: ctx.scopeRef, evaluationKey: randomUUID() };
  const calculationId = randomUUID(), claimToken = randomUUID();
  const kind = "tax_calculation", generation = 1;
  const coordinates = { invocationDigest: digest("evaluation-invocation", identity),
    requestDigest: digest("evaluation-request", { key: identity.evaluationKey }) };
  const pin = { ...coordinates, destination, kind: options.unknownArm ? "unknown" : kind, validUntil, request: { key: identity.evaluationKey }, recovery: null };
  if (options.missing) delete (pin as Partial<typeof pin>)[options.missing];
  const evidence = { adapterEvidence: { calculationRef: options.providerRef ?? randomUUID(), adapterVersion: "fixture-a" } };
  const providerDigest = options.refusal || state === "pending" ? null : digest("provider-calculation", {
    installationRef: identity.installationRef, adapter: "fixture", accountRef: "fixture", mode: "test", providerRef: evidence.adapterEvidence.calculationRef,
  });
  const envelope = { calculationId, ...coordinates, generation, destination, kind: pin.kind, evidence,
    disposition: options.refusal ? "refused" : "required", validUntil };
  if (options.missing) delete (envelope as Partial<typeof envelope>)[options.missing];
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
  const exposedMoney = { ...money, taxEvidence: { ...money.taxEvidence, kind: pin.kind } };
  const exposedQuote = options.unknownArm ? { ...quoteBody, ...exposedMoney,
    moneyDigest: destinationHash(canonicalCatalogDraftJson(["commerce.quote-money.v2", exposedMoney])) } : quoteBody;
  const sealedQuote = { ...exposedQuote, quoteDigest: destinationHash(canonicalCatalogDraftJson(["commerce.quote.v2", exposedQuote])) };
  const refusal = { kind: "refused", code: "tax_provider_reference_conflict", field: "/taxEvidence",
    remedy: "Reconcile the original calculation with the tax adapter owner before further work." };
  const outcome = options.refusal ? { ...refusal, providerMessage: "Do not export private diagnostics" }
    : { kind: "final", quote: { ...sealedQuote, ...(options.badQuoteDigest && { quoteDigest: bound }) } };
  if (options.unsafe) Object.assign(outcome, { [options.unsafe]: "12 Main Street, private provider diagnostic" });
  const bytes = frame("evaluation-outcome", { ...envelope, outcome, submissionDigest: bound, providerDigest, contradiction: false });
  const issuedAt = new Date();
  const row: Record<string, unknown> = {
    calculation_id: calculationId, state, locator: digest("evaluation-key", identity), identity, snapshot_ref: binding.snapshotRef,
    pin, pin_digest: digest("evaluation-pin", pin), issued_at: issuedAt, lease_until: new Date(issuedAt.getTime() + 300_000),
    generation, claim_token: claimToken, outcome_text: state === "terminal" ? bytes : null,
    outcome_digest: state === "terminal" ? (options.badOutcomeDigest ? bound : destinationHash(bytes)) : null,
    provider_digest: providerDigest, contradiction: false, coverage_installation_ref: options.coverage?.installation,
    coverage_account_ref: options.coverage?.account, coverage_revision: options.coverage?.revision,
  };
  options.editRow?.(row);
  await insertStored(db.owner, row);
  if (options.expired) {
    await reachDestinationCutoff(db.owner, binding);
    await db.owner.query("SELECT public.commerce_destination_v2_expire(clock_timestamp(),1000)");
  }
  return { calculationId, ctx, identity, destination: binding, providerDigest, outcome, refusal, row };
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

async function disableGuard<T>(table: "tax_calculations" | "identity_privacy_erasures", run: () => Promise<T>, owner = store.owner) {
  const trigger = table === "tax_calculations" ? "tax_calculation_guard" : "tax_calculation_privacy_guard";
  await owner.query(`ALTER TABLE public.${table} DISABLE TRIGGER ${trigger}`);
  try { return await run(); }
  finally { await owner.query(`ALTER TABLE public.${table} ENABLE TRIGGER ${trigger}`); }
}

async function withFunctionMutation<T>(signature: string, patch: (value: string) => string, run: () => Promise<T>, owner = store.owner) {
  const definition: string = (await owner.query("SELECT pg_get_functiondef(to_regprocedure($1)) AS definition", [signature])).rows[0].definition;
  const mutant = patch(definition);
  expect(mutant).not.toBe(definition);
  await owner.query(mutant);
  try { return await run(); }
  finally { await owner.query(definition); }
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

it("keeps terminal bytes immutable at the same generation and makes the contradiction marker one-way", async () => {
  const terminal = await seed(), pending = await seed("pending");
  const redTerminal = await seed(), redPending = await seed("pending");
  const rewrite = (value: typeof terminal) => {
    const [, body] = JSON.parse(String(value.row.outcome_text));
    const bytes = frame("evaluation-outcome", { ...body, probe: "changed terminal bytes" });
    return store.owner.query("UPDATE public.tax_calculations SET outcome_text=$2,outcome_digest=$3 WHERE calculation_id=$1 RETURNING generation",
      [value.calculationId, bytes, destinationHash(bytes)]);
  };
  const mark = (value: typeof pending, bit: boolean) => store.owner.query(
    "UPDATE public.tax_calculations SET contradiction=$2 WHERE calculation_id=$1 RETURNING contradiction", [value.calculationId, bit]);
  await mark(pending, true);
  await mark(redPending, true);
  const insert = "IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;";
  await withFunctionMutation("public.tax_calculation_guard_v1()", sql => sql.replace(insert, insert + `
    IF TG_OP='UPDATE' AND OLD.state='terminal' AND OLD.generation=NEW.generation THEN RETURN NEW; END IF;`), async () => {
    expect((await rewrite(redTerminal)).rows).toEqual([{ generation: 1 }]);
  });
  await withFunctionMutation("public.tax_calculation_guard_v1()", sql => sql.replace("AND NOT OLD.contradiction AND NEW.contradiction", ""), async () => {
    expect((await mark(redPending, false)).rows).toEqual([{ contradiction: false }]);
  });
  await expect(rewrite(terminal)).rejects.toMatchObject(guardRefusal);
  await expect(mark(pending, false)).rejects.toMatchObject(guardRefusal);
  expect(await storedRow(store.owner, terminal.calculationId)).toMatchObject({ outcome_text: terminal.row.outcome_text, generation: 1 });
  expect(await storedRow(store.owner, pending.calculationId)).toMatchObject({ contradiction: true });
});

const storedFrames = { identity: "evaluation-key", pin: "evaluation-pin", outcome_text: "evaluation-outcome" } as const;
type StoredFrame = keyof typeof storedFrames;
const withFrame = (row: Record<string, unknown>, column: StoredFrame, dimension: "bytes" | "depth", extra: 0 | 1) => {
  const body = column === "outcome_text" ? JSON.parse(String(row[column]))[1] : row[column] as Record<string, unknown>;
  const template = frame(storedFrames[column], { ...body, probe: "fixture-padding-token" });
  const room = 1048576 - Buffer.byteLength(template.replace("fixture-padding-token", "")) + extra;
  const value = dimension === "bytes"
    ? JSON.stringify("é".repeat(Math.floor(room / 2)) + "x".repeat(room % 2))
    : "[".repeat(46 + extra) + "null" + "]".repeat(46 + extra);
  const encoded = template.replace('"fixture-padding-token"', value);
  if (dimension === "bytes") expect(Buffer.byteLength(encoded)).toBe(1048576 + extra);
  if (column === "outcome_text") return { ...row, outcome_text: encoded, outcome_digest: destinationHash(encoded) };
  return { ...row, [column]: JSON.parse(encoded)[1], [column === "pin" ? "pin_digest" : "locator"]: destinationHash(encoded) };
};

it("admits every exact frame boundary on owner insert and exact-current restore", async () => {
  const db = await resources.installation("frame-source");
  const edgeRows: { id: string; column: StoredFrame; dimension: "bytes" | "depth" }[] = [];
  for (const column of Object.keys(storedFrames) as StoredFrame[]) for (const dimension of ["bytes", "depth"] as const) {
    const atEdge = await seed("terminal", db, { editRow: row => Object.assign(row, withFrame(row, column, dimension, 0)) });
    const edge = withFrame(atEdge.row, column, dimension, 1);
    if (column !== "outcome_text" || dimension !== "bytes") await disableGuard("tax_calculations", async () => {
      const id = randomUUID();
      await insertStored(db.owner, { ...edge, calculation_id: id, locator: destinationHash(id), provider_digest: null });
      await db.owner.query("DELETE FROM public.tax_calculations WHERE calculation_id=$1", [id]);
    }, db.owner);
    await expect(insertStored(db.owner, { ...edge, calculation_id: randomUUID() })).rejects.toMatchObject(frameRefusal);
    edgeRows.push({ id: atEdge.calculationId, column, dimension });
  }
  for (const field of ["invocationDigest", "requestDigest"] as const) for (const bad of [undefined, "A".repeat(64), "a".repeat(63), "a".repeat(65), 1]) {
    await expect(seed("pending", db, { editRow: row => { row.pin = { ...(row.pin as object), [field]: bad }; } })).rejects.toMatchObject(frameRefusal);
  }
  await expect(seed("terminal", db, { editRow: row => {
    const [, body] = JSON.parse(String(row.outcome_text));
    delete body.submissionDigest;
    row.outcome_text = frame("evaluation-outcome", body);
  } })).rejects.toMatchObject(frameRefusal);
  const packet = await captureStoreJourney(db.owner, "tax-frame-source");
  const { clone } = await resources.targetTemplate("frame-target");
  const target = await clone("frame-edges");
  const freshTarget = await captureStoreJourney(target.owner, "frame-target");
  const restore = (copy: typeof packet) => restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet: copy, freshTarget });
  for (const { id, column, dimension } of edgeRows) {
    const { sha256: _old, ...payload } = structuredClone(packet);
    const relation = payload.owned.find(entry => entry.table === "tax_calculations")!;
    relation.rows = relation.rows.map(bytes => {
      const row = JSON.parse(bytes);
      return row.calculation_id === id ? JSON.stringify(withFrame(row, column, dimension, 1)) : bytes;
    });
    await expect(restore({ ...payload, sha256: destinationHash(JSON.stringify(payload)) })).rejects.toMatchObject({ code: "target_conflict" });
    expect((await target.owner.query("SELECT count(*)::int AS n FROM public.tax_calculations")).rows).toEqual([{ n: 0 }]);
  }
  expect(await restore(packet)).toMatchObject({ replayed: false });
  for (const { id } of edgeRows) expect(await storedRow(target.owner, id)).toEqual(await storedRow(db.owner, id));
}, 180_000);

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

it("withholds separately corrupted historical bindings and refusal fields", async () => {
  const actor = await operator(), { current } = privacy();
  const terminal = "public.tax_calculation_terminal_v1(public.tax_calculations)";
  const read = async (value: Awaited<ReturnType<typeof seed>>) => (await current.export(actor, subject(value.ctx.clientId))).documents
    .find(entry => entry.contributorId === "tax-calculations");
  async function withheld(value: Awaited<ReturnType<typeof seed>>) {
    const doc = await read(value);
    expect(doc).toMatchObject({ coverage: { complete: false },
      data: [{ calculationId: value.calculationId, verification: "failed" }] });
    expect(JSON.stringify(doc)).not.toMatch(/Main Street|provider diagnostic|"outcome"/u);
  }
  const acceptedByMutant = async (value: Awaited<ReturnType<typeof seed>>) => {
    expect(await read(value)).toMatchObject({ coverage: { complete: true }, data: [{ outcome: value.outcome }] });
  };
  const missing = await disableGuard("tax_calculations", async () => [
    await seed("terminal", store, { missing: "invocationDigest" }),
    await seed("terminal", store, { missing: "requestDigest" }),
  ]);
  await withFunctionMutation(terminal, sql => sql.replace(/\s+OR NOT coalesce\(jsonb_typeof\(body->'invocationDigest'\)[\s\S]*?,false\)/u, ""), async () => {
    for (const value of missing) await acceptedByMutant(value);
  });
  for (const value of missing) await withheld(value);
  const unknown = await seed("terminal", store, { unknownArm: true });
  await withFunctionMutation(terminal, sql => sql.replace(/\s+OR NOT coalesce\(body->>'kind' IN \('tax_calculation','fiscal_profile'\),false\)/u, ""),
    () => acceptedByMutant(unknown));
  await withheld(unknown);
  const destinations = [
    await seed("terminal", store, { wrongDestination: "destinationDigest", expired: true }),
    await seed("terminal", store, { wrongDestination: "policyRevision", expired: true }),
  ];
  await withFunctionMutation("public.tax_calculation_export_v1(uuid)", sql => sql.replace(/\s+OR r.pin->'destination' IS DISTINCT FROM d.binding/u, ""), async () => {
    for (const value of destinations) await acceptedByMutant(value);
  });
  for (const value of destinations) {
    expect((await store.owner.query("SELECT evidence_disposition FROM public.commerce_destination_v2_documents WHERE snapshot_ref=$1",
      [value.destination.snapshotRef])).rows).toEqual([{ evidence_disposition: "expired" }]);
    await withheld(value);
  }
  const unsafe: Awaited<ReturnType<typeof seed>>[] = [];
  for (const field of ["code", "field", "remedy"] as const) unsafe.push(await seed("terminal", store, { refusal: true, unsafe: field }));
  await withFunctionMutation(terminal, sql => sql.replace(/ {6}SELECT permitted.remedy[\s\S]*?THEN RETURN NULL; END IF;/u,
    "      approved_remedy := outcome->>'remedy';"), async () => {
    for (const value of unsafe) expect(JSON.stringify(await read(value))).toContain("12 Main Street");
  });
  for (const value of unsafe) await withheld(value);
});

async function proveRollback(db: JourneyInstallation, sameLogin: boolean) {
  const value = await seed("terminal", db), red = await seed("terminal", db), actor = await operator(db.owner);
  const { store: privacyStore, unitOfWork } = privacy(db);
  // The landed ownership assessment precedes the ledger insert. Declare the same retained contact facts as the reference host.
  const retainedContactFields = Object.fromEntries(["lifecycle_stage", "acquisition_source"].map(field => [field, {
    owner: "clients", resource: `clients.${field}`, disposition: "retain" as const, reasonCode: "CONTACT_LIFECYCLE_RETENTION", remote: false,
  }]));
  const registry = createPersonalDataContributorRegistry([
    createIdentityPersonalDataContributor(privacyStore, { retainedContactFields }, randomUUID),
    createDestinationReceiptPrivacyContributor(), createDestinationDocumentPrivacyContributor(),
  ], { requiredContributorIds: ["identity", "destination-receipts", "destination-documents"] });
  const previous = createPrivacyOperations({ store: privacyStore, unitOfWork, registry, now: () => new Date(), randomId: randomUUID });
  const acceptedByMutant = async () => {
    expect(await previous.erase(actor, request(red.ctx.clientId))).toMatchObject({ outcome: "ERASED" });
    expect(await storedRow(db.owner, red.calculationId)).toMatchObject({ state: "terminal" });
  };
  if (sameLogin) await withFunctionMutation("public.tax_calculation_guard_v1()", sql => sql.replace(
    /\n {6}AND current_setting\('app.tax_historical_receipt_restore'[\s\S]*?mode='ShareRowExclusiveLock'\)/u, ""),
  acceptedByMutant, db.owner);
  else await disableGuard("identity_privacy_erasures", acceptedByMutant, db.owner);
  await expect(previous.erase(actor, request(value.ctx.clientId))).rejects
    .toMatchObject({ message: "PRIVACY_CONTRIBUTOR_MISSING", code: "55000" });
  expect((await db.owner.query("SELECT principal_id FROM public.clients WHERE id=$1", [value.ctx.clientId])).rows)
    .toEqual([{ principal_id: value.ctx.owner.principalRef }]);
  expect((await db.owner.query("SELECT evidence_disposition FROM public.commerce_destination_v2_documents WHERE snapshot_ref=$1",
    [value.destination.snapshotRef])).rows).toEqual([{ evidence_disposition: "available" }]);
  expect(await storedRow(db.owner, value.calculationId)).toMatchObject({ state: "terminal" });
}

it("rolls back erasure from an older registry on the restricted-login profile", async () => {
  await proveRollback(store, false);
});

it("rolls back erasure from an older registry on the legacy same-login profile", async () => {
  const instance = await runPostgresContainer({ name: `tax-legacy-privacy-${process.pid}`, password: "synthetic-tax-legacy" });
  const pool = new Pool({ connectionString: instance.connectionString });
  try {
    expect(await waitForPostgresTcpReady(instance.connectionString)).toBe(true);
    // As in identityPrivacy.conformance.ts, migration and privacy use the same login.
    const runner = createPlatformPostgresMigrationRunner({ connectionString: instance.connectionString }, {
      installation: { generation: "legacy" }, poolFactory: () => pool,
    });
    await runner.apply();
    await proveRollback({ owner: pool, runtime: pool, runtimeUrl: instance.connectionString }, true);
  } finally { await closePostgres(instance, pool); }
}, postgresSetupTimeoutMs);

it("retains the provider marker after erasure and exact-current restore", async () => {
  const db = await resources.installation("provider-source");
  const actor = await operator(db.owner), { current } = privacy(db);
  const providerRef = randomUUID();
  const erased = await seed("terminal", db, { providerRef });
  const pending = await seed("pending", db);
  const terminal = await seed("terminal", db);
  const coverage = { installation: "fixture-installation", account: "fixture-account", revision: "fixture-r1" };
  const coverageBody = { schemaVersion: 1, accountRef: coverage.account, revision: coverage.revision, declarations: [] };
  await db.owner.query("SELECT public.tax_coverage_append_v1($1)", [{
    installationRef: coverage.installation, accountRef: coverage.account, expectedRevision: null,
    actorRef: "coverage-owner", coverage: coverageBody,
  }]);
  const historical = await seed("terminal", db, { expired: true, coverage });
  const history = { erasureId: randomUUID(), key: randomUUID(), principal: randomUUID() };
  await disableGuard("identity_privacy_erasures", async () => {
    // Simulate a receipt present before the evaluation migration.
    await db.owner.query(`INSERT INTO public.identity_privacy_erasures
      (erasure_id,idempotency_key,principal_id,actor_principal_id,contract_version,contributor_versions,dispositions,retained_obligations,completed_at)
      VALUES($1,$2,$3,$4,'identity.erasure.v1','{}','[]','[]',clock_timestamp())`,
    [history.erasureId, history.key, history.principal, actor.principalId]);
  }, db.owner);
  await current.erase(actor, request(erased.ctx.clientId));
  const fence = { calculation_id: erased.calculationId, state: "erased", provider_digest: erased.providerDigest };
  expect(await storedRow(db.owner, erased.calculationId)).toEqual(fence);
  const { clone } = await resources.targetTemplate("provider-target");
  const packet = await captureStoreJourney(db.owner, "tax-source");
  const install = async (label: string, capture = packet) => {
    const target = await clone(label);
    const freshTarget = await captureStoreJourney(target.owner, label);
    expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet: capture, freshTarget })).toMatchObject({ replayed: false });
    return target;
  };
  // Each restored fixture is disposable and has no dispatcher.
  const { sha256: _unsigned, ...unqualifiedHistory } = structuredClone(packet);
  const evaluations = unqualifiedHistory.owned.find(entry => entry.table === "tax_calculations")!;
  evaluations.rows = await Promise.all(evaluations.rows.map(async bytes => {
    const row = JSON.parse(bytes);
    if (row.calculation_id !== historical.calculationId) return bytes;
    const pin = { ...row.pin, validUntil: new Date(Date.now() + 86_400_000).toISOString() };
    const changed = { ...row, pin, pin_digest: digest("evaluation-pin", pin),
      coverage_installation_ref: null, coverage_account_ref: null, coverage_revision: null };
    return (await db.owner.query<{ value: string }>(`SELECT to_jsonb(r)::text AS value
      FROM jsonb_populate_record(NULL::public.tax_calculations,$1::jsonb) r`, [changed])).rows[0]!.value;
  }));
  const red = await install("tax-red", { ...unqualifiedHistory, sha256: destinationHash(JSON.stringify(unqualifiedHistory)) });
  const expiredCoverage = async (owner: Pool) => (await owner.query(`SELECT
      (r.pin->>'validUntil')::timestamptz < clock_timestamp() AS elapsed, c.revision AS coverage_revision, d.evidence_disposition
    FROM public.tax_calculations r LEFT JOIN public.tax_coverage_revisions c
      ON (r.coverage_installation_ref,r.coverage_account_ref,r.coverage_revision)=(c.installation_ref,c.account_ref,c.revision)
    JOIN public.commerce_destination_v2_documents d ON d.snapshot_ref=r.snapshot_ref WHERE r.calculation_id=$1`, [historical.calculationId])).rows;
  expect(await expiredCoverage(red.owner)).toEqual([{ elapsed: false, coverage_revision: null, evidence_disposition: "expired" }]);
  await red.owner.query("DROP INDEX public.tax_calculations_provider_key");
  expect((await seed("terminal", red, { providerRef })).providerDigest).toEqual(erased.providerDigest);
  const target = await install("tax-target");
  expect(await storedRow(target.owner, erased.calculationId)).toEqual(fence);
  for (const row of [pending, terminal, historical])
    expect(await storedRow(target.owner, row.calculationId)).toEqual(await storedRow(db.owner, row.calculationId));
  expect(await expiredCoverage(target.owner)).toEqual([{ elapsed: true, coverage_revision: coverage.revision, evidence_disposition: "expired" }]);
  expect((await target.owner.query("SELECT contributor_versions FROM public.identity_privacy_erasures WHERE erasure_id=$1",
    [history.erasureId])).rows).toEqual([{ contributor_versions: {} }]);
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
