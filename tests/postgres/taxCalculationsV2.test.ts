import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import { createPostgresRoleFreeTransactionLane, type PgQueryExecutor, type PostgresRoleFreeTransactionLane } from "@openlup/platform/data";
import { createPostgresPrivacyStore, createPrivacyOperations, createIdentityPersonalDataContributor,
  createPersonalDataContributorRegistry, createDestinationReceiptPrivacyContributor, createDestinationDocumentPrivacyContributor,
} from "@openlup/platform/identity";
import { commerceQuoteV2Schema, quoteDigest, type CommerceQuoteMoneyV2, type CommerceQuoteV2 } from "@openlup/platform/pricing";
import { applyTaxCoverageRevision, beginTaxCalculation, completeTaxCalculation, evaluationDigest, localRateTable,
  makeTaxQuoteRequest, verifyTaxQuoteResult } from "@openlup/platform/tax";
import type { TaxQuoteInputV1, TaxQuoteRequestV1 } from "@openlup/platform/tax/contracts";
import { createPlatformPostgresMigrationRunner } from "@openlup/platform/migrations";
import { composeNativePrivacy } from "../../server/runtime/auth/privacyBinding.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { captureStoreJourney, journeySelection, storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { destinationContext, destinationHash, reachDestinationCutoff, snapshot, snapshotCommand, snapshotPreimage } from "./destinationDocumentFixture.js";

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
const frameDigests = { identity: "locator", pin: "pin_digest", outcome_text: "outcome_digest" } as const;
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
  return { ...row, [column]: JSON.parse(encoded)[1], [frameDigests[column]]: destinationHash(encoded) };
};
const withCoordinate = (row: Record<string, unknown>, field: "invocationDigest" | "requestDigest", value: unknown) => {
  const pin: Record<string, unknown> = { ...row.pin as Record<string, unknown>, [field]: value };
  if (value === undefined) delete pin[field];
  return { ...row, pin, pin_digest: digest("evaluation-pin", pin) };
};

it("admits every exact frame boundary and refuses each breach through the guard on owner insert and exact-current restore", async () => {
  const db = await resources.installation("frame-source");
  const breaches: { id: string; label: string; fields: string[]; change: (row: Record<string, unknown>) => Record<string, unknown> }[] = [];
  for (const column of Object.keys(storedFrames) as StoredFrame[]) for (const dimension of ["bytes", "depth"] as const) {
    const atEdge = await seed("terminal", db, { editRow: row => Object.assign(row, withFrame(row, column, dimension, 0)) });
    const edge = withFrame(atEdge.row, column, dimension, 1);
    if (column !== "outcome_text" || dimension !== "bytes") await disableGuard("tax_calculations", async () => {
      const id = randomUUID();
      await insertStored(db.owner, { ...edge, calculation_id: id, locator: destinationHash(id), provider_digest: null });
      await db.owner.query("DELETE FROM public.tax_calculations WHERE calculation_id=$1", [id]);
    }, db.owner);
    await expect(insertStored(db.owner, { ...edge, calculation_id: randomUUID() })).rejects.toMatchObject(frameRefusal);
    breaches.push({ id: atEdge.calculationId, label: `${column} ${dimension}`, fields: [column, frameDigests[column]],
      change: row => withFrame(row, column, dimension, 1) });
  }
  for (const field of ["invocationDigest", "requestDigest"] as const) for (const bad of [undefined, "A".repeat(64), "a".repeat(63), "a".repeat(65), 1]) {
    await expect(seed("pending", db, { editRow: row => Object.assign(row, withCoordinate(row, field, bad)) })).rejects.toMatchObject(frameRefusal);
  }
  await expect(seed("terminal", db, { editRow: row => {
    const [, body] = JSON.parse(String(row.outcome_text));
    delete body.submissionDigest;
    row.outcome_text = frame("evaluation-outcome", body);
  } })).rejects.toMatchObject(frameRefusal);
  // A pending row isolates the coordinate refusal from the outcome body comparison.
  const pending = await seed("pending", db);
  for (const field of ["invocationDigest", "requestDigest"] as const) for (const [defect, bad] of [["missing", undefined], ["malformed", "A".repeat(64)]] as const) {
    breaches.push({ id: pending.calculationId, label: `${field} ${defect}`, fields: ["pin", "pin_digest"], change: row => withCoordinate(row, field, bad) });
  }
  const packet = await captureStoreJourney(db.owner, "tax-frame-source");
  const { clone } = await resources.targetTemplate("frame-target");
  const target = await clone("frame-edges");
  const freshTarget = await captureStoreJourney(target.owner, "frame-target");
  // Record every PostgreSQL error raised during restore. A census mismatch raises none.
  const raised: { sql: string; code?: string; message?: string; detail?: string }[] = [];
  const connect = target.owner.connect.bind(target.owner);
  const observed = { async connect() {
    const client = await connect();
    return { async query(sql: string, values?: unknown[]) {
      try { return await client.query(sql, values); } catch (error) {
        const { code, message, detail } = error as { code?: string; message?: string; detail?: string };
        raised.push({ sql, code, message, detail });
        throw error;
      }
    }, release: (destroy?: boolean) => client.release(destroy) };
  } } as unknown as Pool;
  const restore = (copy: typeof packet) => restoreConnectedNativeStore({ owner: observed, installation: journeySelection, packet: copy, freshTarget });
  // The restore census compares this PostgreSQL row text, so a breach differs from its valid row only in its own fields.
  const render = async (row: Record<string, unknown>) => (await db.owner.query<{ value: string }>(`SELECT
    pg_catalog.set_config('TimeZone','UTC',true) AS zone,pg_catalog.to_jsonb(r)::pg_catalog.text AS value
    FROM pg_catalog.jsonb_populate_record(NULL::public.tax_calculations,$1::jsonb) r`, [JSON.stringify(row)])).rows[0]!.value;
  for (const { id, label, fields, change } of breaches) {
    const { sha256: _old, ...payload } = structuredClone(packet);
    const relation = payload.owned.find(entry => entry.table === "tax_calculations")!;
    const index = relation.rows.findIndex(bytes => JSON.parse(bytes).calculation_id === id);
    const valid = JSON.parse(relation.rows[index]!) as Record<string, unknown>;
    expect(await render(valid), label).toBe(relation.rows[index]);
    relation.rows[index] = await render(change(valid));
    const breach = JSON.parse(relation.rows[index]!) as Record<string, unknown>;
    expect(Object.keys(breach).filter(key => !isDeepStrictEqual(breach[key], valid[key])).sort(), label).toEqual([...fields].sort());
    raised.length = 0;
    await expect(restore({ ...payload, sha256: destinationHash(JSON.stringify(payload)) }), label)
      .rejects.toMatchObject({ code: "target_conflict", message: "postgres_transfer_target_conflict" });
    expect(raised, label).toEqual([{ sql: expect.stringMatching(/^INSERT INTO public\."tax_calculations" /u), ...frameRefusal }]);
    expect((await target.owner.query("SELECT count(*)::int AS n FROM public.tax_calculations")).rows).toEqual([{ n: 0 }]);
  }
  raised.length = 0;
  expect(await restore(packet)).toMatchObject({ replayed: false });
  expect(raised).toEqual([]);
  for (const id of new Set(breaches.map(breach => breach.id))) expect(await storedRow(target.owner, id)).toEqual(await storedRow(db.owner, id));
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

describe("native evaluation claim and seal", () => {
  let store: JourneyInstallation;
  beforeAll(async () => { store = await resources.installation("tax-claim-seal"); }, postgresSetupTimeoutMs);

  const lane = (db = store) => createPostgresRoleFreeTransactionLane<PgQueryExecutor>({ connectionString: db.runtimeUrl }, { pool: db.runtime });
  const defaultInvocation = { purpose: "final", mode: "one_time", lines: [{ sku: "item-a", quantity: 1 }],
    deliverySelector: "delivery-a", paymentSelector: "rail-a" } as const;

  type ClaimInput = Extract<Parameters<typeof beginTaxCalculation>[1], { operation: "claim" }>;
  type SealInput = Exclude<Parameters<typeof completeTaxCalculation>[1], Uint8Array>;
  type Claim = Extract<Awaited<ReturnType<typeof beginTaxCalculation>>, { kind: "claimed" }>;
  type Lane = PostgresRoleFreeTransactionLane<PgQueryExecutor>;
  const recovery = "ab".repeat(32);
  const blocked = { kind: "refused", code: "commerce_destination_owner_mismatch", field: "/destination/snapshotRef",
    remedy: "Re-obtain evidence through the authenticated owner." } as const;
  const invalid = (field: string) => ({ kind: "refused", code: "tax_invalid_input", field, remedy: "Supply the documented input." });

  async function fixture(db = store, purpose: "final" | "estimate" = "final", evaluationKey: string = randomUUID()) {
    const ctx = await destinationContext(db.owner);
    const issued = await snapshot(db.runtime, ctx);
    const identity = { clientId: ctx.clientId, principalRef: ctx.owner.principalRef, installationRef: ctx.owner.installationRef,
      scopeRef: ctx.scopeRef, evaluationKey };
    const invocation = { ...defaultInvocation, purpose, lines: [...defaultInvocation.lines] };
    const claim = { operation: "claim", identity, invocation, recovery: null, pin: {
      kind: "fiscal_profile", destination: issued.binding, request: { basis: "inclusive", taxDate: "2026-01-01T00:00:00.000Z" },
      coverage: null, validUntil: issued.evidenceExpiresAt, recovery: null,
    } } satisfies ClaimInput;
    return { ctx, claim, lookup: { identity, invocation, operation: "lookup" as const }, issued };
  }

  const boundDigest = "a".repeat(64);
  const effectiveDate = "2026-06-05T10:00:00.000Z";
  function moneyFixture() {
    return {
      catalogueEvidenceRef: "catalogue:v1", mode: "one_time" as const, currency: "XXX",
      paymentLimits: { profileRef: "limits", revision: "limits:v1", channelKey: "checkout", currency: "XXX", minMinor: 1, maxMinor: 1000 },
      coverageDigest: boundDigest, deliverySelectionRef: "delivery-a",
      price: { priceListRef: "list-a", priceContextDigest: boundDigest, priceEvidenceRef: "price-a", classMapRevision: "classes-a" },
      lines: [{ lineKey: "item-z", sourceOrdinal: 1, sku: "item-z", mode: "one_time" as const, quantity: 1, unitBasisMinor: 100,
        taxClassKey: "standard", assignmentRef: "assignment-a", preDiscountMinor: 100, effectiveMinor: 100,
        netMinor: 100, taxMinor: 0, lineTotalMinor: 100, discountAllocations: [], taxPositions: [] }],
      deliveryBuckets: [], feeLines: [], netTotal: 100, taxTotal: 0, feeTotal: 0, payableMinor: 100,
    };
  }
  function sealQuote(money: CommerceQuoteMoneyV2, status: CommerceQuoteV2["status"] = "final"): CommerceQuoteV2 {
    const quote = { ...money, contractVersion: "commerce.v1", schemaVersion: 2, quoteId: randomUUID(), status,
      moneyDigest: quoteDigest("commerce.quote-money.v2", money) } as const;
    return { ...quote, quoteDigest: quoteDigest("commerce.quote.v2", quote) };
  }

  function fiscalSeal(input: ClaimInput, claim: Claim, cutoff = claim.pin.validUntil): SealInput {
    const { identity, invocation } = input, { calculationId, claimToken, generation, pin } = claim;
    const { requestDigest, invocationDigest, destination, kind } = pin;
    const validUntil = cutoff;
    const evidence = { policyRevision: "fiscal-a", posting: "no_provider_posting" };
    const envelope = { calculationId, invocationDigest, requestDigest, generation, destination, kind, evidence,
      disposition: "no_provider_posting", validUntil };
    if (kind !== "fiscal_profile") throw new Error("Expected fiscal fixture");
    const money = moneyFixture();
    const lines = money.lines.map(line => ({ ...line, taxPositions: [{
      positionRef: "fixture-fiscal", jurisdictionRef: "fixture-jurisdiction", level: "district", taxKind: "consumption",
      taxabilityReason: "fixture", ruleRef: "policy", resolution: { assignmentRef: "assignment-a", policyRevision: "fiscal-a",
        sourceRef: "fiscal-profile", effective: { from: effectiveDate } }, resolutionDigest: boundDigest,
      rateDecimal: "0", taxableMinor: line.netMinor, taxMinor: 0,
    }] }));
    const quote = sealQuote({ ...money, lines, destination, amountBasis: "inclusive",
      promotion: { engine: "promotion-engine.v1", rankingRuleRef: "lowest_payable_gross" },
      taxEvidence: { kind, taxDate: effectiveDate, calculationId,
        expiresAt: validUntil, evidenceDigest: evaluationDigest("evaluation-evidence", envelope) },
    }, invocation.purpose);
    return { identity, invocation, calculationId, claimToken, generation, seal: { requestDigest, destination, validUntil, kind,
      contradiction: false, outcome: { kind: invocation.purpose, quote }, evidence } };
  }

  async function exclusiveFixture(db = store) {
    const value = await fixture(db);
    const { binding } = value.issued;
    const address = snapshotCommand(value.ctx).command.validated.address;
    const effective = { from: taxDate };
    const scope = { adapter: "adapter-a", adapterVersion: "1", accountRef: "account-a", mode: "test" } as const;
    const source = { lineKey: "item-z", sourceOrdinal: 1, quantity: 1, unitBasisMinor: 100 };
    const original: TaxQuoteInputV1 = {
      scope, market: "market-a", currency: "XXX", purpose: "final", taxDate,
      destination: { snapshotRef: binding.snapshotRef, digest: binding.destinationDigest, policyRevision: binding.policyRevision, address },
      shipFromRef: "origin-a", policyRevision: "policy-a", classMapRevision: "classes-a",
      money: { amountBasis: "exclusive", sources: [source], delivery: [], adjustments: [], fees: [] },
      lines: [{ lineKey: source.lineKey, sku: "item-z", mode: "one_time", taxClass: "standard", assignmentRef: "assignment-a" }],
      delivery: [], required: [{ target: { kind: "line", key: source.lineKey }, jurisdiction: "district-a",
        level: "district", taxKind: "sale", sourcing: "destination" }],
      coverage: { schemaVersion: 1, accountRef: scope.accountRef, revision: "coverage-a",
        declarations: [{ jurisdiction: "district-a", taxKind: "sale", status: "registered",
          actorRef: "actor-a", recordedAt: taxDate, effective }] },
    };
    const request = makeTaxQuoteRequest("original-key", original);
    const installationRef = value.ctx.owner.installationRef;
    const row = (await db.owner.query("SELECT * FROM public.tax_coverage_read_v1($1,$2)",
      [installationRef, original.scope.accountRef])).rows[0];
    const result = row ?? await applyTaxCoverageRevision(db.owner, { expectedHead: null,
      document: { installationRef, accountRef: original.scope.accountRef, coverage: original.coverage, actorRef: "fixture" } });
    const digest = "coverageDigest" in result ? result.coverageDigest : result.coverage_digest;
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    const claim: ClaimInput = { ...value.claim, recovery, pin: { ...value.claim.pin, kind: "tax_calculation",
      request, recovery, coverage: { accountRef: original.scope.accountRef, revision: original.coverage.revision, digest } } };
    return { ...value, claim, request };
  }

  async function claimFresh(input: ClaimInput, active = lane()): Promise<Claim> {
    const result = await beginTaxCalculation(active, input);
    expect(result).toMatchObject({ kind: "claimed", generation: 1 });
    if (result.kind !== "claimed") throw new Error("Expected first claim");
    return result;
  }

  async function forceClaimTransition(owner: Pool, id: string, generation: number) {
    await owner.query(`BEGIN; ALTER TABLE public.tax_calculations DISABLE TRIGGER tax_calculation_guard;
      UPDATE public.tax_calculations SET generation=${generation},lease_until=clock_timestamp()-interval '1 second'
      WHERE calculation_id='${id}'; ALTER TABLE public.tax_calculations ENABLE TRIGGER tax_calculation_guard; COMMIT;`);
  }

  async function mutateTransition(search: string, replacement: string, witness: () => Promise<void>) {
    const sql = "SELECT pg_get_functiondef('public.tax_calculation_transition_v1(jsonb,boolean)'::regprocedure) AS definition";
    const definition: string = (await store.owner.query(sql)).rows[0]!.definition;
    expect(definition).toContain(search);
    await store.owner.query(definition.replace(search, replacement));
    try { await witness(); }
    finally { await store.owner.query(definition); }
  }

  it.each(["wrapper", "SQL"] as const)("refuses an address-bearing fiscal request through %s without writing a claim", async entry => {
    const { claim } = await fixture();
    const request = { ...claim.pin.request, line1: "1 Example Lane", line2: "Unit A", city: "Example", postalCode: "00000",
      contactEmail: "synthetic@example.invalid" };
    const input = { ...claim, pin: { ...claim.pin, request } };
    if (entry === "wrapper") {
      expect(await beginTaxCalculation(lane(), input)).toStrictEqual(invalid("/pin/request"));
    } else {
      const pins = [{ ...input.pin, requestDigest: evaluationDigest("evaluation-request", request) },
        { ...claim.pin, line1: request.line1, requestDigest: evaluationDigest("evaluation-request", claim.pin.request) }];
      for (const pin of pins) {
        await expect(store.runtime.query("SELECT public.tax_calculation_begin_v1($1::jsonb)", [{ ...input, pin }]))
          .rejects.toMatchObject({ code: "22023", message: "tax_invalid_input" });
      }
    }
    expect((await store.owner.query("SELECT state FROM public.tax_calculations WHERE identity=$1::jsonb", [claim.identity])).rows).toEqual([]);
  });

  it("withholds the token when claim commit acknowledgment crosses cutoff", async () => {
    const { claim } = await fixture();
    const validUntil = future(3), active = lane(), committed = deferred<void>(), release = deferred<void>();
    const delayed: Lane = { close: active.close, run: async work => {
      const reply = await active.run(work);
      committed.resolve();
      await release.promise;
      return reply;
    } };
    const pending = beginTaxCalculation(delayed, { ...claim, pin: { ...claim.pin, validUntil } });
    try {
      await Promise.race([committed.promise, pending.then(() => { throw new Error("Expected the claim to reach commit"); })]);
      await store.owner.query("SELECT pg_sleep_until($1::timestamptz)", [validUntil]);
    } finally { release.resolve(); }
    const result = await pending;
    expect(result).toStrictEqual({ kind: "refused", code: "tax_calculation_expired", field: "/taxEvidence/expiresAt",
      remedy: "Select the destination again and obtain a fresh quote." });
    expect(result).not.toHaveProperty("claimToken");
    expect((await store.owner.query(`SELECT state,lease_until>clock_timestamp() AS leased
      FROM public.tax_calculations WHERE identity=$1::jsonb`, [claim.identity])).rows).toEqual([{ state: "pending", leased: true }]);
  });

  it.each([blocked, { kind: "refused", code: "destination_digest_mismatch", field: "/destination/destinationDigest",
    remedy: "Replay the original document and its digest." }] as const)("seals and exactly replays $code through the wrapper", async outcome => {
    const { claim } = await fixture();
    const original = fiscalSeal(claim, await claimFresh(claim));
    const seal = { ...original, seal: { ...original.seal, outcome } };
    const reply = await completeTaxCalculation(lane(), seal);
    expect(reply).toStrictEqual({ kind: "terminal", validUntil: seal.seal.validUntil, freshness: "current", outcome });
    expect(await completeTaxCalculation(lane(), seal)).toStrictEqual(reply);
  });

  it("admits a shared policy revision at 256 code points and refuses 257 before a claim", async () => {
    const { claim, ctx } = await fixture();
    const revision = "😀".repeat(100) + "a".repeat(156);
    const claimWithRevision = async (policyRevision: string) => {
      const initial = snapshotCommand(ctx).command;
      const command = { ...initial, requestKey: randomUUID(), validated: { ...initial.validated, policyRevision } };
      const issued = await snapshot(store.runtime, ctx, { ...command,
        requestDigest: destinationHash(canonicalCatalogDraftJson(snapshotPreimage(ctx, command))) });
      return { ...claim, identity: { ...claim.identity, evaluationKey: randomUUID() },
        pin: { ...claim.pin, destination: issued.binding, validUntil: issued.evidenceExpiresAt } };
    };
    expect(await beginTaxCalculation(lane(), await claimWithRevision(revision))).toMatchObject({ kind: "claimed" });
    const excess = await claimWithRevision(revision + "a");
    expect(await beginTaxCalculation(lane(), excess)).toStrictEqual({ kind: "refused", code: "tax_invalid_input", field: "/pin/destination/policyRevision",
      remedy: "Obtain a supported revision from the destination owner." });
    expect((await store.owner.query("SELECT state FROM public.tax_calculations WHERE identity=$1::jsonb", [excess.identity])).rows).toEqual([]);
  });

  it("binds invocation order, serializes first claims and grants no dispatch on lookup or takeover before the lease", async () => {
    const { claim, lookup } = await fixture();
    expect(await beginTaxCalculation(lane(), lookup)).toStrictEqual({ kind: "missing" });
    const results = await Promise.all([beginTaxCalculation(lane(), claim), beginTaxCalculation(lane(), claim)]);
    expect(results.map(result => result.kind).sort()).toStrictEqual(["claimed", "refused"]);
    expect(results).toContainEqual({ kind: "refused", code: "tax_claim_pending", field: "/claim", remedy: "Read the original evaluation outcome." });
    expect(await beginTaxCalculation(lane(), lookup)).toStrictEqual({ kind: "pending" });
    const changed = { ...lookup, invocation: { ...lookup.invocation, lines: [{ sku: "item-b", quantity: 1 }] } };
    const expectConflict = async () => expect(await beginTaxCalculation(lane(), changed))
      .toMatchObject({ kind: "refused", code: "tax_reference_conflict", field: "/requestKey" });
    await mutateTransition("OR r.pin->>'invocationDigest' IS DISTINCT FROM invocation", "", async () => {
      await expect(expectConflict()).rejects.toThrow(/expected/u);
    });
    await expectConflict();
  });

  it("pins the address-free request and fences changed qualification, stale tokens and exhausted takeover", async () => {
    const { claim, issued } = await exclusiveFixture();
    const first = await claimFresh(claim);
    expect(first.pin.request).toMatchObject({ key: "original-key", input: { destination: { snapshotRef: issued.binding.snapshotRef } } });
    expect(JSON.stringify(first.pin.request)).not.toContain("Zélvórë");
    expect(JSON.stringify(first.pin.request)).not.toContain('"address"');
    await forceClaimTransition(store.owner, first.calculationId, 1);
    const retry = { operation: "claim", identity: claim.identity, invocation: claim.invocation, recovery } as const;
    expect(await beginTaxCalculation(lane(), { ...retry, recovery: null })).toMatchObject({ code: "tax_adapter_unavailable" });
    const second = await beginTaxCalculation(lane(), retry);
    expect(second).toMatchObject({ kind: "claimed", generation: 2, pin: first.pin });
    if (second.kind !== "claimed") throw new Error("Expected takeover");
    expect(second.claimToken).not.toBe(first.claimToken);
    const refusal = { identity: claim.identity, invocation: claim.invocation, claimToken: first.claimToken,
      calculationId: first.calculationId, generation: first.generation, seal: { kind: "tax_calculation", validUntil: first.pin.validUntil, requestDigest: first.pin.requestDigest,
        destination: first.pin.destination, contradiction: false, evidence: null, outcome: { kind: "indeterminate" } } } satisfies SealInput;
    expect(await completeTaxCalculation(lane(), refusal)).toMatchObject({ code: "tax_claim_stale", field: "/claim" });
    await forceClaimTransition(store.owner, first.calculationId, 2147483647);
    expect(await beginTaxCalculation(lane(), retry)).toMatchObject({ code: "tax_claim_generation_exhausted" });
  });

  it("maps missing or foreign destination evidence to the same refusal without writing a claim", async () => {
    const foreign = await fixture(), owned = await fixture();
    const { claim } = owned;
    const candidates = [
      ["foreign snapshot", { ...claim, pin: { ...claim.pin, destination: foreign.issued.binding } }],
      ["foreign owner", { ...claim, identity: { ...claim.identity, installationRef: "foreign-installation" } }],
      ["foreign checkout scope", { ...claim, identity: { ...claim.identity, scopeRef: randomUUID() } }],
      ["missing snapshot", { ...claim, pin: { ...claim.pin, destination: { ...owned.issued.binding, snapshotRef: randomUUID() } } }],
    ] as const;
    for (const [name, candidate] of candidates) {
      expect(await beginTaxCalculation(lane(), candidate), name).toStrictEqual(blocked);
      expect((await store.owner.query("SELECT state FROM public.tax_calculations WHERE identity=$1::jsonb", [candidate.identity])).rows, name)
        .toEqual([]);
    }
  });

  it("maps typed destination digest and revision refusals without writing a claim", async () => {
    const { claim } = await fixture();
    const binding = claim.pin.destination;
    const candidates = [
      [{ ...binding, destinationDigest: "0".repeat(64) }, { code: "destination_digest_mismatch",
        field: "/destination/destinationDigest", remedy: "Replay the original document and its digest." }],
      [{ ...binding, policyRevision: "other-revision" }, { code: "destination_version_changed",
        field: "/destination/policyRevision", remedy: "Select the destination again and obtain a fresh quote." }],
    ] as const;
    for (const [destination, outcome] of candidates) {
      expect(await beginTaxCalculation(lane(), { ...claim, pin: { ...claim.pin, destination } })).toStrictEqual({ kind: "refused", ...outcome });
      expect((await store.owner.query("SELECT state FROM public.tax_calculations WHERE identity=$1::jsonb", [claim.identity])).rows).toEqual([]);
    }
  });

  it("maps canonicalization failures in stored coverage to a closed refusal", async () => {
    const exclusive = await exclusiveFixture(), c = exclusive.claim.pin!.coverage!;
    const corrupt = `WITH RECURSIVE nested(depth,value) AS (
      VALUES (0,'null'::jsonb) UNION ALL SELECT depth+1,jsonb_build_array(value) FROM nested WHERE depth<49
    ) INSERT INTO public.tax_coverage_revisions
      (installation_ref,account_ref,revision,sequence_no,coverage,coverage_digest,actor_ref,recorded_at)
      SELECT $1,$2,'corrupt-history',2,jsonb_build_object('schemaVersion',1,'accountRef',$2::text,'revision','corrupt-history','declarations',value),
        repeat('0',64),'fixture',clock_timestamp() FROM nested WHERE depth=49`;
    try {
      await store.owner.query(corrupt, [exclusive.claim.identity.installationRef, c.accountRef]);
      await mutateTransition("'catalog_publication_wire_invalid',", "", async () => {
        const error = await beginTaxCalculation(lane(), exclusive.claim).catch((error: unknown) => error);
        expect(error).toMatchObject({ code: "commerce_quote_v2_unavailable", cause: { message: "catalog_publication_wire_invalid" } });
        expect(Object.getOwnPropertyDescriptor(error, "cause")?.enumerable).toBe(false);
      });
      expect(await beginTaxCalculation(lane(), exclusive.claim)).toStrictEqual({ kind: "refused", code: "tax_reference_conflict",
        field: "/coverage", remedy: "Recover the verified original history through its owner." });
    } finally {
      const client = await store.owner.connect();
      let committed = false;
      try {
        await client.query("BEGIN");
        await client.query("ALTER TABLE public.tax_coverage_revisions DISABLE TRIGGER tax_coverage_revision_immutable");
        await client.query("DELETE FROM public.tax_coverage_revisions WHERE revision='corrupt-history'");
        await client.query("ALTER TABLE public.tax_coverage_revisions ENABLE TRIGGER tax_coverage_revision_immutable");
        await client.query("COMMIT");
        committed = true;
      } finally {
        if (!committed) await client.query("ROLLBACK").finally(() => client.release());
        else client.release();
      }
    }
  });

  function lostAcknowledgment(active: Lane, rollback = false): Lane {
    let first = true;
    return {
      close: active.close,
      async run<T>(work: (executor: PgQueryExecutor) => Promise<T>) {
        const result = await active.run(async executor => {
          const reply = await work(executor);
          if (first && rollback) { first = false; throw new Error("Synthetic lost seal with rollback"); }
          return reply;
        });
        if (first) { first = false; throw new Error("Synthetic lost commit reply"); }
        return result;
      },
    };
  }

  it.each(["final", "estimate"] as const)("seals %s once, gives no authority on claim acknowledgement loss and recovers a lost seal", async purpose => {
    const dropped = await fixture(store, purpose);
    expect(await beginTaxCalculation(lostAcknowledgment(lane()), dropped.claim)).toStrictEqual({ kind: "pending" });
    const { claim, lookup, issued } = await fixture(store, purpose);
    const held = await claimFresh(claim);
    const seal = fiscalSeal(claim, held);
    expect(await completeTaxCalculation(lostAcknowledgment(lane(), true), seal)).toStrictEqual({ kind: "pending" });
    const success = seal.seal.outcome;
    if (!("quote" in success)) throw new Error("Expected the success fixture to contain a quote");
    const badDigest = { ...seal, seal: { ...seal.seal, outcome: {
      ...success, quote: { ...(success.quote as CommerceQuoteV2), quoteDigest: boundDigest },
    } } };
    expect(await completeTaxCalculation(lane(), badDigest)).toMatchObject({ kind: "refused", code: "tax_reference_conflict" });
    expect(await beginTaxCalculation(lane(), lookup)).toStrictEqual({ kind: "pending" });
    const result = await completeTaxCalculation(lostAcknowledgment(lane()), seal);
    expect(result).toStrictEqual({ kind: "terminal", validUntil: held.pin.validUntil, freshness: "current", outcome: seal.seal.outcome });
    await reachDestinationCutoff(store.owner, issued.binding);
    expect(await completeTaxCalculation(lane(), seal)).toEqual(result);
    expect(await beginTaxCalculation(lane(), lookup)).toEqual(result);
    expect(await completeTaxCalculation(lane(), { ...seal, seal: { ...seal.seal, evidence: { policyRevision: "changed" } } }))
      .toMatchObject({ code: "tax_reference_conflict", field: "/taxEvidence" });
    expect(await completeTaxCalculation(lane(), { ...seal, claimToken: randomUUID() })).toMatchObject({ code: "tax_claim_stale" });
    const row = (await store.owner.query("SELECT outcome_text FROM public.tax_calculations WHERE calculation_id=$1", [held.calculationId])).rows[0]!;
    expect(row.outcome_text.match(/"quoteDigest"/gu)).toHaveLength(1);
  });

  it.each(["tax_adapter_unavailable", "tax_coverage_evidence_unavailable"] as const)(
    "keeps uncertain work pending and verifies the definitive %s remedy through subject export",
    async code => {
      const { claim, ctx, lookup } = await fixture();
      const held = await claimFresh(claim), original = fiscalSeal(claim, held);
      const pending = { ...original, seal: { ...original.seal, contradiction: true, outcome: { kind: "indeterminate" as const } } };
      expect(await completeTaxCalculation(lane(), pending)).toStrictEqual({ kind: "pending" });
      expect(await completeTaxCalculation(lane(), pending)).toStrictEqual({ kind: "pending" });
      expect(await beginTaxCalculation(lane(), lookup)).toStrictEqual({ kind: "pending" });
      expect(await storedRow(store.owner, held.calculationId)).toMatchObject({ state: "pending", contradiction: true });
      expect(await storedRow(store.owner, held.calculationId)).not.toHaveProperty("outcome_text");

      const action = "Request a new quote when the tax service is available.";
      const oldAction = "Recover the original evidence through the adapter owner.";
      const outcome = { kind: "unavailable", code } as const;
      const seal = { ...original, seal: { ...original.seal, outcome } };
      const definitive = { ...outcome, effect: "none", field: "/taxEvidence", remedy: action };
      const { current } = privacy(store), actor = await operator(store.owner);
      const exportEvaluation = async () => (await current.export(actor, subject(ctx.clientId))).documents
        .find(entry => entry.contributorId === "tax-calculations");
      const signature = "public.tax_calculation_terminal_v1(public.tax_calculations)";
      await withFunctionMutation(signature, sql => sql.replaceAll(action, oldAction), async () => {
        expect(await completeTaxCalculation(lane(), seal)).toMatchObject({ kind: "refused", code: "tax_reference_conflict" });
        expect(await beginTaxCalculation(lane(), lookup)).toStrictEqual({ kind: "pending" });
      }, store.owner);
      expect(await completeTaxCalculation(lane(), seal)).toMatchObject({ kind: "terminal", outcome: definitive });
      expect(await completeTaxCalculation(lane(), seal)).toMatchObject({ kind: "terminal", outcome: definitive });
      expect(await exportEvaluation()).toMatchObject({ coverage: { complete: true }, data: [{ outcome: definitive }] });

      const saved = await storedRow(store.owner, held.calculationId);
      try {
        for (const remedy of [oldAction, "Private adapter diagnostic for 12 Main Street"]) {
          const expected = JSON.parse(saved.outcome_text)[1];
          const corrupt = frame("evaluation-outcome", { ...expected, outcome: { ...definitive, remedy } });
          await disableGuard("tax_calculations", () => store.owner.query(
            "UPDATE public.tax_calculations SET outcome_text=$2,outcome_digest=$3 WHERE calculation_id=$1",
            [held.calculationId, corrupt, destinationHash(corrupt)]), store.owner);
        const rejected = await exportEvaluation();
        expect(rejected).toMatchObject({ coverage: { complete: false },
            data: [{ calculationId: held.calculationId, verification: "failed" }] });
        expect(JSON.stringify(rejected?.data)).not.toContain('"outcome"');
          expect(await beginTaxCalculation(lane(), lookup)).toMatchObject({ kind: "refused", code: "tax_evaluation_integrity_invalid" });
        }
      } finally {
        await disableGuard("tax_calculations", () => store.owner.query(
          "UPDATE public.tax_calculations SET outcome_text=$2,outcome_digest=$3 WHERE calculation_id=$1",
          [held.calculationId, saved.outcome_text, saved.outcome_digest]), store.owner);
      }
    },
  );

  it("executes native key, request-byte, depth, Unicode and clock edge validation through the wrapper", async () => {
    const { claim, lookup } = await fixture(store, "final", "😀".repeat(128));
    const accept = await claimFresh(claim);
    expect(accept.pin.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(await beginTaxCalculation(lane(), { ...claim, identity: { ...claim.identity, evaluationKey: "😀".repeat(129) } }))
      .toStrictEqual(invalid("/identity/evaluationKey"));
    expect(await beginTaxCalculation(lane(), Uint8Array.of(0xc0, 0x80))).toStrictEqual(invalid("/"));
    expect(await beginTaxCalculation(lane(), { ...claim, identity: { ...claim.identity, evaluationKey: "\u0000" } })).toStrictEqual(invalid("/"));
    expect(await beginTaxCalculation(lane(), { ...claim, identity: { ...claim.identity, evaluationKey: "\ud800" } })).toStrictEqual(invalid("/"));
    expect(await beginTaxCalculation(lane(), { ...claim, identity: { ...claim.identity, evaluationKey: "" } }))
      .toStrictEqual(invalid("/identity/evaluationKey"));
    const lookupText = canonicalCatalogDraftJson(lookup), byteCap = 1_048_576;
    const boundary = (extra: number) => new TextEncoder().encode(lookupText + " ".repeat(byteCap - Buffer.byteLength(lookupText) + extra));
    expect(await beginTaxCalculation(lane(), boundary(0))).toStrictEqual({ kind: "pending" });
    expect(await beginTaxCalculation(lane(), boundary(1))).toStrictEqual(invalid("/"));
    let reads = 0;
    const accessor = { ...lookup, get identity() { reads++; return lookup.identity; } };
    expect(await beginTaxCalculation(lane(), accessor)).toStrictEqual(invalid("/"));
    expect(reads).toBe(0);
    expect(await beginTaxCalculation(lane(), { ...claim, pin: { ...claim.pin, validUntil: "0000-01-01T00:00:00.000Z" } }))
      .toStrictEqual(invalid("/pin/validUntil"));
    for (const validUntil of ["0001-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"]) {
      const request = { ...claim, identity: { ...claim.identity, evaluationKey: validUntil }, pin: { ...claim.pin!, validUntil } };
      expect(await beginTaxCalculation(lane(), request)).toMatchObject({ code: "tax_calculation_expired" });
    }
    const complete = fiscalSeal(claim, accept);
    for (const generation of [0, 2_147_483_648, 1.5])
      expect(await completeTaxCalculation(lane(), { ...complete, generation })).toStrictEqual(invalid("/generation"));
    expect(await beginTaxCalculation(lane(), { ...claim, invocation: { ...claim.invocation, paymentSelector: "😀".repeat(61) } }))
      .toStrictEqual(invalid("/invocation/paymentSelector"));
    expect(await beginTaxCalculation(lane(), { ...lookup, identity: { ...lookup.identity, evaluationKey: "selector-boundary" },
      invocation: { ...lookup.invocation, paymentSelector: "😀".repeat(60) } })).toStrictEqual({ kind: "missing" });
    expect(await beginTaxCalculation(lane(), { ...claim, pin: { ...claim.pin, request: "é".repeat(524289) } }))
      .toStrictEqual(invalid("/"));
    let nested: unknown = {};
    for (let depth = 0; depth < 49; depth++) nested = [nested];
    expect(await beginTaxCalculation(lane(), { ...claim, pin: { ...claim.pin, request: nested } })).toStrictEqual(invalid("/"));
  });

  it("round-trips pending, expired and terminal rows through an exact-current pristine target", async () => {
    const { clone } = await resources.targetTemplate("tax-transfer");
    const target = await clone("copy");
    const expired = await exclusiveFixture();
    const validUntil = future(3);
    const original = await claimFresh({ ...expired.claim, pin: { ...expired.claim.pin!, validUntil } });
    await forceClaimTransition(store.owner, original.calculationId, original.generation);
    await store.owner.query("SELECT pg_sleep_until($1::timestamptz)", [validUntil]);
    const final = await fixture(), held = await claimFresh(final.claim);
    await completeTaxCalculation(lane(), fiscalSeal(final.claim, held));
    // No live dispatcher is attached to either captured store.
    const packet = await captureStoreJourney(store.owner, "tax-source");
    const freshTarget = await captureStoreJourney(target.owner, "tax-target");
    expect((await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget })).replayed).toBe(false);
    expect(await beginTaxCalculation(lane(target), expired.lookup)).toStrictEqual({ kind: "pending" });
    const { pin: _pin, ...takeover } = expired.claim;
    expect(await beginTaxCalculation(lane(target), takeover)).toMatchObject({ code: "tax_calculation_expired", field: "/taxEvidence/expiresAt" });
    expect(await storedRow(target.owner, original.calculationId)).toMatchObject({ state: "pending",
      generation: original.generation, claim_token: original.claimToken });
    expect(await beginTaxCalculation(lane(target), final.lookup)).toMatchObject({ kind: "terminal" });
    expect((await target.owner.query("SELECT state FROM public.tax_calculations GROUP BY state ORDER BY state")).rows.map(row => row.state))
      .toEqual(["pending", "terminal"]);
  });

  async function providerSeal(input: ClaimInput, request: TaxQuoteRequestV1, claim: Claim, providerRef: string, validUntil: string): Promise<SealInput> {
    const { scope, market, currency, taxDate } = request.input;
    const effective = { from: taxDate };
    const reply = await localRateTable({ scope, market, currency, now: () => new Date().toISOString(), calculationLifetimeMs: 120_000,
      validityWindowMs: 2_000, rounding: "half_up_largest_remainder",
      rules: [{ kind: "rate", jurisdiction: "district-a", taxClass: "standard", taxKind: "sale",
        ruleRef: "rule-a", legalBasisRef: "rulebook-a", effective, ratePercent: "0" }],
      registrations: [{ state: "active", jurisdiction: "district-a", taxKind: "sale", evidenceRef: "registration-a", effective }],
    }).quote(request);
    if (reply.kind !== "final") throw new Error(JSON.stringify(reply));
    const adapterEvidence = { ...reply.evidence, calculationRef: providerRef };
    const result = { ...reply, evidence: adapterEvidence, evidenceDigest: digest("evidence", adapterEvidence) };
    expect(verifyTaxQuoteResult(request, result)).toBeUndefined();
    const { identity, invocation } = input, { calculationId, claimToken, generation, pin } = claim;
    const { requestDigest, invocationDigest, destination } = pin;
    const kind = "tax_calculation";
    const evidence = { adapterEvidence, adapterDigest: result.evidenceDigest };
    const envelope = { calculationId, invocationDigest, requestDigest, generation, destination, kind, evidence, disposition: "required", validUntil };
    const quote = sealQuote({ ...moneyFixture(), destination,
      amountBasis: "exclusive", promotion: { engine: "promotion-engine.v1", rankingRuleRef: "lowest_pre_tax.v1" },
      taxEvidence: { kind, calculationId, taxDate: request.input.taxDate, expiresAt: validUntil, evidenceDigest: evaluationDigest("evaluation-evidence", envelope) },
    });
    return { identity, invocation, calculationId, claimToken, generation, adapter: { request, result }, seal: {
      requestDigest, destination, validUntil, kind, contradiction: false, outcome: { kind: "final", quote }, evidence: null,
    } };
  }

  async function createPrivacy(db = store, unitOfWork = lane(db)) {
    const actor = { principalId: randomUUID() };
    await db.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [actor.principalId, actor.principalId + "@example.invalid"]);
    await db.owner.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at)
      VALUES($1,'admin','active','legacy',clock_timestamp())`, [actor.principalId]);
    const operations = composeNativePrivacy({ store: createPostgresPrivacyStore(), unitOfWork }).operations;
    return (contactId: string) => operations.erase(actor, { subject: { kind: "contact", contactId }, idempotencyKey: randomUUID() });
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(accept => { resolve = accept; });
    return { promise, resolve };
  }
  function holdBeforeCommit(active: Lane) {
    const reached = deferred<void>(), release = deferred<void>();
    const held: Lane = { close: active.close, run: work => active.run(async executor => {
      const reply = await work(executor);
      reached.resolve();
      await release.promise;
      return reply;
    }) };
    return { held, reached: reached.promise, release: () => release.resolve() };
  }
  function observeBackend(active: Lane) {
    const ready = deferred<number>();
    const observed: Lane = { close: active.close, run: work => active.run(executor => work({ async query(sql, params) {
      const result = await executor.query(sql, params);
      if (sql.startsWith("SET TRANSACTION")) ready.resolve(Number((await executor.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid));
      return result;
    } })) };
    return { observed, pid: ready.promise };
  }
  async function waitForTransactionLock(owner: Pool, pid: number) {
    await expect.poll(async () => (await owner.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.wait_event_type,
      { interval: 10, timeout: 3500 }).toBe("Lock");
  }
  const future = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

  async function providerCutoffRace() {
    const first = await exclusiveFixture(), second = await exclusiveFixture();
    const one = await claimFresh(first.claim), two = await claimFresh(second.claim);
    const providerRef = randomUUID();
    const [sealOne, sealTwo] = await Promise.all([
      providerSeal(first.claim, first.request, one, providerRef, future(60)),
      providerSeal(second.claim, second.request, two, providerRef, future(3)),
    ]);
    const firstGate = holdBeforeCommit(lane()), secondBackend = observeBackend(lane());
    const a = completeTaxCalculation(firstGate.held, sealOne);
    await Promise.race([firstGate.reached, a.then(() => { throw new Error("Winner failed to reach commit"); })]);
    const b = completeTaxCalculation(secondBackend.observed, sealTwo);
    try {
      await waitForTransactionLock(store.owner, await secondBackend.pid);
      await store.owner.query("SELECT pg_sleep_until($1::timestamptz)", [sealTwo.seal.validUntil]);
    } finally {
      firstGate.release();
      await expect(a).resolves.toMatchObject({ kind: "terminal", outcome: { kind: "final" } });
    }
    return { reply: await b, lookup: await beginTaxCalculation(lane(), second.lookup) };
  }

  it("rolls back a seal that crossed cutoff in a provider uniqueness wait", async () => {
    const check = "IF clock_timestamp() >= cutoff THEN RAISE EXCEPTION 'tax_calculation_expired' USING ERRCODE='55000', DETAIL='/taxEvidence/expiresAt'; END IF;";
    await mutateTransition("END LOOP;\n  " + check, "END LOOP;", async () => {
      expect(await providerCutoffRace()).toMatchObject({ reply: { kind: "terminal", outcome: { code: "tax_provider_reference_conflict" } },
        lookup: { kind: "terminal" } });
    });
    expect(await providerCutoffRace()).toMatchObject({ reply: { code: "tax_calculation_expired", field: "/taxEvidence/expiresAt" },
      lookup: { kind: "pending" } });
  });

  it("refuses a competing seal after erasure and exact-current restore", async () => {
    const providerRef = randomUUID();
    const winner = await exclusiveFixture(), claimed = await claimFresh(winner.claim);
    const winnerSeal = await providerSeal(winner.claim, winner.request, claimed, providerRef, future(60));
    expect(await completeTaxCalculation(lane(), winnerSeal)).toMatchObject({ kind: "terminal", outcome: { kind: "final" } });
    await (await createPrivacy())(winner.ctx.clientId);
    const { body } = (await store.owner.query(`SELECT jsonb_strip_nulls(to_jsonb(c)) AS body FROM public.tax_calculations c WHERE calculation_id=$1`,
      [claimed.calculationId])).rows[0]!;
    expect(body).toStrictEqual({ calculation_id: claimed.calculationId, state: "erased", provider_digest: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    const { clone } = await resources.targetTemplate("tax-provider-fence");
    const target = await clone("provider-fence");
    const packet = await captureStoreJourney(store.owner, "fenced-source"), freshTarget = await captureStoreJourney(target.owner, "fenced-target");
    await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget });
    for (const installation of [store, target]) {
      const other = await exclusiveFixture(installation), ownLane = lane(installation);
      const held = await claimFresh(other.claim, ownLane);
      const seal = await providerSeal(other.claim, other.request, held, providerRef, future(60));
      const reply = await completeTaxCalculation(ownLane, seal);
      expect(reply).toMatchObject({ kind: "terminal", outcome: { kind: "refused", code: "tax_provider_reference_conflict", field: "/taxEvidence" } });
      expect(JSON.stringify(reply)).not.toContain(claimed.calculationId);
      expect(JSON.stringify(reply)).not.toContain(providerRef);
      expect(await completeTaxCalculation(ownLane, seal)).toEqual(reply);
    }
  });

  it("fences writes when privacy owns the ledger first", async () => {
    const value = await fixture();
    const held = holdBeforeCommit(lane()), erase = await createPrivacy(store, held.held);
    const erased = erase(value.ctx.clientId);
    await Promise.race([held.reached, erased.then(() => { throw new Error("Erasure failed to reach commit"); })]);
    const { observed, pid } = observeBackend(lane());
    const attempt = beginTaxCalculation(observed, value.claim);
    try { await waitForTransactionLock(store.owner, await pid); }
    finally { held.release(); await erased; }
    await expect(attempt).resolves.toMatchObject({ code: "destination_evidence_erased" });
  });

  it("lets an acknowledged claim finish before concurrent privacy scrubs it", async () => {
    const value = await fixture();
    const held = holdBeforeCommit(lane()), erase = await createPrivacy();
    const pending = beginTaxCalculation(held.held, value.claim);
    await Promise.race([held.reached, pending.then(() => { throw new Error("Claim failed to reach commit"); })]);
    const erasure = erase(value.ctx.clientId);
    try {
      await expect.poll(async () => (await store.owner.query(`SELECT EXISTS(SELECT FROM pg_locks
        WHERE relation='public.identity_privacy_erasures'::regclass AND mode='ShareRowExclusiveLock' AND NOT granted) AS waiting`)).rows[0]?.waiting,
      { interval: 10, timeout: 3500 }).toBe(true);
    } finally { held.release(); await erasure; }
    const claimed = await pending;
    if (claimed.kind !== "claimed") throw new Error("Expected acknowledged original claim");
    await expect(completeTaxCalculation(lane(), fiscalSeal(value.claim, claimed))).resolves.toMatchObject({ code: "destination_evidence_erased" });
  });

  it("probes all inherited field byte limits on the actual B1 issuance path", async () => {
    const { ctx } = await fixture();
    const ranges = {
      address: { line1: 200, line2: 200, city: 120, postalCode: 32, countryCode: 2, subdivisionCode: 16 },
      contact: { recipientName: 200, contactEmail: 254, contactPhone: 64, companyName: 200, label: 200, taxId: 64, deliveryNotes: 500, courierInstructions: 500 },
      policy: { policyRef: 720, policyRevision: 720 },
    };
    for (const [section, limits] of Object.entries(ranges)) for (const [field, limit] of Object.entries(limits)) {
      const initial = snapshotCommand(ctx).command;
      const value = field === "countryCode" || field === "subdivisionCode" ? "A".repeat(limit) : "é".repeat(Math.floor(limit / 2));
      const command = (fieldValue: string) => {
        const requestKey = randomUUID();
        const patched = section === "policy" ? { [field]: fieldValue }
          : { [section]: { ...initial.validated[section as "address" | "contact"], [field]: fieldValue } };
        const next = { ...initial, requestKey, validated: { ...initial.validated, ...patched } };
        return { ...next, requestDigest: destinationHash(canonicalCatalogDraftJson(snapshotPreimage(ctx, next))) };
      };
      expect((await snapshot(store.runtime, ctx, command(value))).binding).toBeDefined();
      const bad = { outcome: "refused", code: "address_invalid_input", field };
      await expect(snapshot(store.runtime, ctx, command(value + "A"))).resolves.toMatchObject(bad);
      await expect(snapshot(store.runtime, ctx, command("A\u0085"))).resolves.toMatchObject(bad);
      if (section === "address" && field !== "countryCode" && field !== "subdivisionCode") {
        await expect(snapshot(store.runtime, ctx, command(" X"))).resolves.toMatchObject(bad);
        await expect(snapshot(store.runtime, ctx, command("e\u0301"))).resolves.toMatchObject(bad);
      }
    }
  });

  it("returns historical authority when acknowledgment arrives after a timely seal's cutoff", async () => {
    const value = await fixture();
    const claim = await claimFresh(value.claim);
    const seal = fiscalSeal(value.claim, claim, future(2));
    const waiting = holdBeforeCommit(lane());
    const completion = completeTaxCalculation(waiting.held, seal);
    try {
      await Promise.race([waiting.reached, completion.then(() => { throw new Error("Expected the seal to reach commit"); })]);
      await store.owner.query("SELECT pg_sleep_until($1::timestamptz)", [seal.seal.validUntil]);
    } finally { waiting.release(); }
    await expect(completion).resolves.toMatchObject({ kind: "terminal", freshness: "historical", outcome: seal.seal.outcome });
  });
});
