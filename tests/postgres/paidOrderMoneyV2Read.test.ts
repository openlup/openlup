import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { CommerceQuoteMoneyV2 } from "@openlup/platform/pricing/contracts";
import {
  createPostgresPaymentProviderReconciliationPort, createPostgresPaymentWebhookControlPort,
  createPostgresProviderPaymentControlPort, createPostgresSandboxPaymentSimulator,
} from "@openlup/platform/payments";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureStoreJourney, journeySelection, storeJourneyResources } from "../helpers/storeJourney.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { installAccountMutations, type AccountMutationsStore } from "./customerAccountMutations.fixture.js";
import { quoteDigest } from "./commerceQuoteV2StorageFixture.js";
import { issue, write } from "./orderMoneyV2Guards.fixture.js";
import { buckets, insert, itemTable, orderTable, seedSku, snapshots, storageTables, transaction } from "./orderMoneyV2Storage.fixture.js";

const reader = "public.commerce_read_paid_order_money_v2";
const at = "2026-11-13T12:00:00.123456Z";
const millisecond = "2026-11-13T12:00:00.123Z";
const currency = "XXX";
const provider = "card_rail";
const options = { dunningTemplateSlug: "example-failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "example-recovered" };
const intentTable = "commerce_settlement_intents", truthTable = "payment_truth_events", transitionTable = "commerce_settlement_transitions";
const evidenceTable = "payment_provider_attempt_evidence", attemptTable = "payment_provider_attempts";
type FixtureStore = Pick<AccountMutationsStore, "owner" | "runtime">;
type FixtureOptions = NonNullable<Parameters<typeof issue>[4]> & { restore?: boolean };
type Db = Pool | PoolClient;
type Json = Record<string, unknown>;
type Money = CommerceQuoteMoneyV2 & {
  orderId: string; moneyVersion: string; schemaVersion: number; acceptedMoneyDigest: string;
  acceptedQuoteRef: Json; intentId: string; captureEvidenceRef: string; capturedAt: string; paidMinor: number;
};
const resources = storeJourneyResources();
let store: AccountMutationsStore;
let sku: Awaited<ReturnType<typeof seedSku>>;

beforeAll(async () => {
  store = await installAccountMutations("bootstrap", false, "paid-money");
  sku = await seedSku(store.owner);
}, postgresSetupTimeoutMs);
afterAll(async () => { await Promise.all([store?.close(), resources.close()]); }, postgresTeardownTimeoutMs);

async function value<T>(db: Db, sql: string, params: unknown[] = []) {
  return (await db.query<{ value: T }>(sql, params)).rows[0]!.value;
}
const read = (db: Db, id: string) => value<{ kind: "paid"; money: Money } | { kind: "refused"; code: string; field: string } | null>(
  db, `SELECT ${reader}($1::uuid) AS value`, [id]);
const bytes = (db: Db, id: string) => value<string>(db, `SELECT ${reader}($1::uuid)::text AS value`, [id]);

async function committed(inclusive = false, edit?: (body: CommerceQuoteMoneyV2) => CommerceQuoteMoneyV2, target = store as FixtureStore,
  product = sku, { restore = false, ...issuance }: FixtureOptions = {}) {
  const accepted = await issue(target, product, inclusive, edit, issuance);
  const { id } = await transaction(target.owner, async db => {
    if (restore) await db.query(`LOCK TABLE ${[...storageTables, "identity_privacy_erasures"].map(table => "public." + table).join(",")}
      IN SHARE ROW EXCLUSIVE MODE`);
    return write(db, accepted, product);
  });
  return { id, accepted };
}

async function prepare(id: string, amount: number, runtime = store.runtime) {
  const control = createPostgresProviderPaymentControlPort(runtime, options);
  const intent = await control.createIntent({ idempotencyKey: "intent:" + id, targetKind: "one_time_order", orderId: id,
    subscriptionId: null, subscriptionCycleId: null, amountMinor: amount, currency, metadata: {}, channelKey: provider, at });
  const input = { idempotencyKey: "prepare:" + id, paymentIntentId: intent.id, provider,
    providerIdempotencyKey: "provider:" + id, providerRequestFingerprint: "a".repeat(64),
    providerFlow: "one_time_payment" as const, requestPayload: {} };
  const { paymentAttemptId: attempt } = await control.prepareProviderAttempt(input);
  const remote = "payment:" + attempt, session = "session:" + attempt;
  await control.finalizeProviderAttempt({ ...input, idempotencyKey: "finalize:" + id, paymentAttemptId: attempt,
    providerAttemptId: remote, providerSessionId: session, attemptStatus: "processing", nextActionKind: null, responsePayload: {} });
  return { id, amount, intent: intent.id, paymentId: intent.paymentId, attempt, remote, session };
}
type Payment = Awaited<ReturnType<typeof prepare>>;
async function signed(payment: Payment, runtime = store.runtime, refund = false) {
  const webhook = createPostgresPaymentWebhookControlPort(runtime, options);
  const event = await webhook.ingestPaymentEvent({
    provider, providerEventId: randomUUID(), providerPaymentId: payment.remote,
    paymentIntentId: payment.intent, paymentAttemptId: payment.attempt, eventType: refund ? "payment.refunded" : "payment.succeeded",
    amountMinor: payment.amount, currency, occurredAt: at, rawPayload: {},
    ...(refund ? {} : { capturedAmountBasis: "provider_capture_v1" as const }),
  });
  const applied = await createPostgresProviderPaymentControlPort(runtime, options).applyPaymentResult({
    idempotencyKey: randomUUID(), paymentIntentId: payment.intent, paymentEventId: event.paymentEventId,
    resultStatus: refund ? "refunded" : "succeeded", occurredAt: at, failureReason: null,
  });
  expect(applied.kind).toBe("state_changed");
  return event.paymentEventId;
}

function readback(payment: Payment, runtime = store.runtime, remote = payment.remote) {
  return createPostgresPaymentProviderReconciliationPort(runtime, options).applyTerminalResult({
    idempotencyKey: randomUUID(), expectedOrderId: payment.id, expectedPaymentIntentId: payment.intent,
    expectedPaymentAttemptId: payment.attempt, expectedPaymentId: payment.paymentId, provider, providerPaymentId: remote,
    localStatus: "processing", providerStatus: "succeeded", resultStatus: "succeeded", occurredAt: at, failureReason: null, checkedAt: at,
    payload: { normalizedStatus: "succeeded", amountMinor: payment.amount, currency, capturedAmountBasis: "provider_capture_v1" },
  });
}

async function paid(inclusive = false, edit?: (body: CommerceQuoteMoneyV2) => CommerceQuoteMoneyV2, fixture?: FixtureOptions) {
  const order = await committed(inclusive, edit, store, sku, fixture);
  const payment = await prepare(order.id, order.accepted.quote.payableMinor);
  await (inclusive ? signed(payment) : readback(payment));
  const { rows: [binding] } = await store.runtime.query<{ event: string; truth: string; transition: string }>(
    `SELECT source_evidence->>'sourceReference' AS event,id AS truth,settlement_transition_id AS transition
      FROM public.${truthTable} WHERE settlement_intent_id=$1 AND outcome='captured'`, [payment.intent]);
  return { ...order, ...payment, ...binding! };
}
type Paid = Awaited<ReturnType<typeof paid>>;

async function matchesLive(id: string, accepted: Paid["accepted"], intent: string, event: string, target = store as FixtureStore) {
  const { contractVersion: _contract, schemaVersion, quoteId, status: _status, moneyDigest, quoteDigest: acceptedQuoteDigest, ...body } = accepted.quote;
  const expected = { kind: "paid", money: { ...body, orderId: id, moneyVersion: "commerce.order-money.v2", schemaVersion,
    acceptedMoneyDigest: moneyDigest, acceptedQuoteRef: { quoteId, quoteDigest: acceptedQuoteDigest, acceptanceRef: "acceptance", tokenDigest: "a".repeat(64) },
    intentId: intent, captureEvidenceRef: event, capturedAt: millisecond, paidMinor: body.payableMinor } };
  const result = await read(target.runtime, id);
  expect(result).toStrictEqual(expected);
  const stored = await value<Json>(target.owner, "SELECT public.commerce_order_money_v2_live_body($1) AS value", [id]);
  expect(stored).toStrictEqual(body);
  expect(quoteDigest("commerce.quote-money.v2", stored)).toBe(moneyDigest);
  return expected;
}

function refuse(id: string, field = "/captureEvidenceRef") {
  return expect(read(store.runtime, id)).resolves.toStrictEqual({ kind: "refused", code: "paid_order_money_capture_mismatch", field });
}

it("legacy_and_unpaid_read_null", async () => {
  expect(await read(store.runtime, randomUUID())).toBeNull();
  const legacy = randomUUID();
  await transaction(store.owner, async db => {
    await insert(db, orderTable, { id: legacy, status: "paid", currency_code: currency, total_amount_minor: 100 });
    await insert(db, itemTable, { order_id: legacy, sku_id: sku.id, line_ordinal: 1, quantity: 1, unit_amount_minor: 100, line_amount_minor: 100 });
  });
  expect(await read(store.runtime, legacy)).toBeNull();
  const { id } = await committed();
  expect(await read(store.runtime, id)).toBeNull();
  const f = await prepare(id, 100);
  expect(await read(store.runtime, id)).toBeNull();
  for (const review of [false, true]) {
    await insert(store.owner, truthTable, { settlement_intent_id: f.intent, source_event_id: randomUUID(),
      event_fingerprint: "a".repeat(64), ingest_idempotency_key: randomUUID(), outcome: review ? "captured" : "indeterminate",
      amount_minor: f.amount, currency_code: currency, source_evidence: {}, occurred_at: at, review_required_at: review ? at : null });
    expect(await read(store.runtime, id)).toBeNull();
  }
});

it.each([["signed_capture_reads_paid_money", true], ["readback_capture_reads_paid_money", false]] as const)("%s", async (_name, inclusive) => {
  const f = await paid(inclusive);
  await matchesLive(f.id, f.accepted, f.intent, f.event);
  expect(await value(store.owner, `SELECT (source_evidence->>'observedAt')::timestamptz=occurred_at
      AND occurred_at=$2::timestamptz AS value FROM public.${truthTable} WHERE id=$1`, [f.truth, at])).toBe(true);
  if (inclusive) {
    await evidenceEdit(f, "source_evidence=jsonb_set(source_evidence,'{observedAt}','\"unbound\"')");
    await matchesLive(f.id, f.accepted, f.intent, f.event);
  } else expect(await value(store.owner, `SELECT (source_evidence->>'observedAt')::timestamptz=$2::timestamptz AS value
    FROM public.${evidenceTable} WHERE id=$1`, [f.event, at])).toBe(true);
});

it("duplicate_observation_ignored", async () => {
  const f = await paid(true);
  const before = await bytes(store.runtime, f.id);
  expect((await readback(f)).paymentResult.kind).toBe("ignored_duplicate_success");
  expect(await value(store.owner, `SELECT jsonb_build_array(
    (SELECT count(*) FROM public.${evidenceTable} WHERE settlement_intent_id=$1),
    (SELECT count(*) FROM public.${transitionTable} WHERE intent_id=$1 AND outcome='succeeded')) AS value`, [f.intent])).toEqual([2, 1]);
  expect(await bytes(store.runtime, f.id)).toBe(before);
});

it("paid_money_survives_refund", async () => {
  const f = await paid(true);
  const before = await bytes(store.runtime, f.id);
  await signed(f, store.runtime, true);
  expect(await value(store.owner, "SELECT status AS value FROM public.commerce_orders WHERE id=$1", [f.id])).toBe("refunded");
  await store.owner.query("DELETE FROM public.price_entries WHERE variant_id=$1", [sku.id]);
  expect(await bytes(store.runtime, f.id)).toBe(before);
});

it("paid_money_survives_restore", async () => {
  const source = await resources.installation("paid-source");
  const target = await resources.installation("paid-target");
  const product = await seedSku(source.owner);
  const f = await committed(false, undefined, source, product);
  const payment = await prepare(f.id, f.accepted.quote.payableMinor, source.runtime);
  const event = await signed(payment, source.runtime);
  await matchesLive(f.id, f.accepted, payment.intent, event, source);
  const before = await bytes(source.runtime, f.id);
  const packet = await captureStoreJourney(source.owner, "paid-source");
  const freshTarget = await captureStoreJourney(target.owner, "paid-target");
  await expect(restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget }))
    .resolves.toMatchObject({ replayed: false });
  expect(await bytes(target.runtime, f.id)).toBe(before);
}, postgresSetupTimeoutMs);

const evidenceEdit = (f: Paid, edit: string, args: unknown[] = []) =>
  store.owner.query(`UPDATE public.${evidenceTable} SET ${edit} WHERE id=$1`, [f.event, ...args]);

async function truthEdit(f: Paid, edit: string, args: unknown[] = []) {
  await transaction(store.owner, async db => {
    await db.query(`UPDATE public.${truthTable} SET ${edit} WHERE id=$1`, [f.truth, ...args]);
    await db.query(`UPDATE public.${transitionTable} SET payload=jsonb_set(payload,'{sourceEvidence}',t.source_evidence)
      FROM public.${truthTable} t WHERE t.id=$2 AND ${transitionTable}.id=$1`, [f.transition, f.truth]);
  });
}

it("capture_binding_refuses", async () => {
  const other = await paid(true);
  const fault: [string, (f: Paid) => Promise<unknown>, string?][] = [
    ["missing truth", f => store.owner.query(`DELETE FROM public.${truthTable} WHERE id=$1`, [f.truth])],
    ["foreign truth", f => store.owner.query(`UPDATE public.${truthTable} SET settlement_intent_id=$2 WHERE id=$1`, [f.truth, other.intent])],
    ["foreign transition reference", f => store.owner.query(`UPDATE public.${transitionTable}
      SET payload=jsonb_set(payload,'{paymentTruthEventId}',to_jsonb($2::text)) WHERE id=$1`, [f.transition, other.truth])],
    ["different transition", f => truthEdit(f, "settlement_transition_id=$2", [other.transition])],
    ["different transition evidence", f => store.owner.query(`UPDATE public.${transitionTable}
      SET payload=payload-'sourceEvidence' WHERE id=$1`, [f.transition])],
    ["nonsettled intent", f => store.owner.query(`UPDATE public.${intentTable} SET status='created',settled_at=NULL WHERE id=$1`, [f.intent])],
    ["additional applied capture", f => store.owner.query(`INSERT INTO public.${truthTable}
      (source_event_id,event_fingerprint,ingest_idempotency_key,settlement_intent_id,state,outcome,amount_minor,currency_code,
        source_evidence,settlement_transition_id,occurred_at,settled_at)
      SELECT $2,event_fingerprint,$2,settlement_intent_id,state,outcome,amount_minor,currency_code,source_evidence,
        settlement_transition_id,occurred_at,settled_at FROM public.${truthTable} WHERE id=$1`, [f.truth, randomUUID()])],
    ["additional transition", f => insert(store.owner, transitionTable, { intent_id: f.intent, from_status: "created",
      to_status: "settled", outcome: "succeeded", idempotency_key: randomUUID() })],
    ["wrong source event", f => truthEdit(f, "source_event_id='provider:'||$2", [randomUUID()])],
    ["foreign evidence", f => evidenceEdit(f, "settlement_intent_id=$2", [other.intent])],
    ["missing attempt reference", f => evidenceEdit(f, "payment_attempt_id=NULL")],
    ["wrong evidence type", f => evidenceEdit(f, "event_type='payment.failed'")],
    ["wrong basis", f => evidenceEdit(f, "captured_amount_basis=NULL")],
    ["wrong fingerprint", f => evidenceEdit(f, "event_fingerprint=repeat('c',64)")],
    ["unsigned evidence", f => evidenceEdit(f, "signature_verified=false")],
    ["signed recorded as readback", f => evidenceEdit(f, "received_via='reconciliation_read.v1'")],
    ["wrong truth observation", f => truthEdit(f, "source_evidence=jsonb_set(source_evidence,'{observedAt}',to_jsonb($2::text))", [millisecond])],
    ["wrong amount before currency", f => evidenceEdit(f, "amount_minor=amount_minor+1,currency='YYY'"), "/paidMinor"],
    ["wrong currency", f => evidenceEdit(f, "currency='YYY'"), "/currency"],
  ];
  for (const [label, mutate, field] of fault) {
    const f = await paid(true);
    await mutate(f);
    expect(await read(store.runtime, f.id), label).toStrictEqual({
      kind: "refused", code: "paid_order_money_capture_mismatch", field: field ?? "/captureEvidenceRef",
    });
  }
  const readbackOrder = await paid();
  await evidenceEdit(readbackOrder, "signature_verified=true");
  await refuse(readbackOrder.id);
  for (const edge of [1, 2_147_483_647]) {
    const f = await paid(true, body => {
      const line = body.lines[0]!;
      return { ...body, netTotal: edge, payableMinor: edge, lines: [
        { ...line, unitBasisMinor: edge, preDiscountMinor: edge, effectiveMinor: edge, netMinor: edge, lineTotalMinor: edge,
          taxPositions: line.taxPositions.map(position => ({ ...position, taxableMinor: edge })) },
      ] };
    }, { restore: true, ...(edge === 1 ? {} : { paymentBounds: { minMinor: 1, maxMinor: edge } }) });
    expect(await read(store.runtime, f.id)).toMatchObject({ kind: "paid", money: { paidMinor: edge } });
    for (const delta of [-1, 1]) {
      await evidenceEdit(f, "amount_minor=$2", [edge + delta]);
      await refuse(f.id, "/paidMinor");
    }
  }
});

it("foreign_attempt_refuses", async () => {
  const foreign = await paid(true);
  for (const inclusive of [true, false]) {
    const f = await paid(inclusive);
    await evidenceEdit(f, "provider_payment_id=$2", [f.session]);
    if (inclusive) await refuse(f.id);
    else expect(await read(store.runtime, f.id)).toMatchObject({ kind: "paid" });
    await evidenceEdit(f, "provider_payment_id=$2", ["different:" + f.id]);
    await refuse(f.id);
    await evidenceEdit(f, "provider_payment_id=NULL");
    await refuse(f.id);
    await evidenceEdit(f, "provider_payment_id=$2,provider='other'", [f.remote]);
    await refuse(f.id);
    await truthEdit(f, "source_evidence=jsonb_set(source_evidence,'{attemptRef}',to_jsonb($2::text))", [foreign.attempt]);
    await evidenceEdit(f, "payment_attempt_id=$2,provider=$3,provider_payment_id=$4", [foreign.attempt, provider, foreign.remote]);
    await refuse(f.id);
  }
});

it("route_precedes_evidence", async () => {
  const providerOrder = await paid(true);
  await truthEdit(providerOrder, `source_event_id='provider:'||$2,
    source_evidence=jsonb_set(source_evidence,'{sourceReference}',to_jsonb($2::text))`, [randomUUID()]);
  await refuse(providerOrder.id);
  const { id } = await committed();
  const opened = await value<{ settlement: { id: string } }>(store.runtime,
    "SELECT public.commerce_open_settlement_intent($1,$2,'sandbox',100,'XXX','{}',$3) AS value", [randomUUID(), id, at]);
  const intent = opened.settlement.id;
  const simulator = createPostgresSandboxPaymentSimulator(store.runtime, options);
  const attempt = await simulator.beginAttempt({ settlementIntentId: intent, idempotencyKey: randomUUID(), requestFingerprint: "b".repeat(64), at });
  for (const outcome of ["indeterminate", "captured"] as const) {
    const observation = await simulator.recordObservation({ attemptId: attempt.id, idempotencyKey: randomUUID(), outcome, occurredAt: at });
    expect((await simulator.ingress.receive({ headers: {}, receivedAt: at, rawBody: new TextEncoder().encode(JSON.stringify({
      settlementIntentId: intent, attemptId: attempt.id, observationId: observation.id,
    })) })).status).toBe(200);
  }
  expect(await value(store.runtime, `SELECT jsonb_build_array(count(*), count(DISTINCT settlement_transition_id)) AS value
    FROM public.${truthTable} WHERE settlement_intent_id=$1 AND state='settled' AND outcome='captured'`, [intent])).toEqual([2, 1]);
  await refuse(id, "/captureRoute");
});

it("malformed_observation_refuses", async () => {
  const signedOrder = await paid(true);
  const readbackOrder = await paid();
  for (const malformed of ["not a date", "2026-02-30T12:00:00Z", millisecond]) {
    await truthEdit(signedOrder, "source_evidence=jsonb_set(source_evidence,'{observedAt}',to_jsonb($2::text))", [malformed]);
    await refuse(signedOrder.id);
    await evidenceEdit(readbackOrder, "source_evidence=jsonb_set(source_evidence,'{observedAt}',to_jsonb($2::text))", [malformed]);
    await refuse(readbackOrder.id);
  }
  await truthEdit(signedOrder, "source_evidence=source_evidence-'observedAt'");
  await refuse(signedOrder.id);
  await evidenceEdit(readbackOrder, "source_evidence=source_evidence-'observedAt'");
  await refuse(readbackOrder.id);
});

it("fresh_readback_does_not_repair", async () => {
  const f = await paid(true);
  await evidenceEdit(f, "signature_verified=false");
  await refuse(f.id);
  const before = await bytes(store.runtime, f.id);
  expect((await readback(f)).paymentResult.kind).toBe("ignored_duplicate_success");
  expect(await bytes(store.runtime, f.id)).toBe(before);
});

it.each(["qualified-v2", "qualified-admin"] as const)("runtime_acl %s", async generation => {
  const target = generation === "qualified-v2" ? store : await installAccountMutations("admin-managed", false, "paid-money-admin");
  try {
    if (target.installation.generation !== generation) throw new Error("Expected qualified installation");
    expect(await value(target.runtime, `SELECT jsonb_build_array(session_user,current_user,
      pg_has_role(session_user,'service_role','USAGE')) AS value`)).toEqual(
      [target.installation.runtimeLogin, target.installation.runtimeLogin, true]);
    expect(await read(target.runtime, randomUUID())).toBeNull();
    for (const table of [...storageTables, evidenceTable]) {
      await expect(target.runtime.query(`SELECT * FROM public.${table} LIMIT 1`)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(target.runtime.query("SELECT public.commerce_order_money_v2_live_body($1)", [randomUUID()]))
      .rejects.toMatchObject({ code: "42501" });
    for (const table of [intentTable, truthTable, transitionTable]) {
      expect(await value(target.owner, "SELECT has_table_privilege('service_role',$1,'SELECT') AS value", ["public." + table])).toBe(true);
      await expect(target.runtime.query(`SELECT * FROM public.${table} LIMIT 1`)).resolves.toBeDefined();
    }
  } finally { if (target !== store) await target.close(); }
}, postgresSetupTimeoutMs);

function richMoney(cadence: boolean, linePromotion: string, shippingPromotion: string) {
  return (body: CommerceQuoteMoneyV2): CommerceQuoteMoneyV2 => {
    const { cadence: fixed, ...facts } = body;
    const line = facts.lines[0]!, initial = line.taxPositions[0]!;
    const mode = cadence ? "subscription" : "one_time";
    const { sourceDigest: _sourceDigest, effective: _effective, ...resolution } = initial.resolution;
    const state = (basisMinor: number, shipping: boolean) => ({
      basisMinor, netMinor: basisMinor, taxMinor: 0,
      taxPositions: [{
        ...initial, positionRef: shipping ? "shipping-position" : "line-position", taxableMinor: basisMinor,
        resolution: { ...resolution, ...(shipping ? { sourceDigest: "c".repeat(64) } : {}),
          effective: { from: initial.resolution.effective.from, ...(shipping ? { until: facts.taxEvidence.expiresAt } : {}) } },
      }],
    });
    const component = (preDiscountMinor: number, shipping: boolean) => {
      const before = state(preDiscountMinor, shipping), after = state(preDiscountMinor - 1, shipping);
      return { preDiscountMinor, effectiveMinor: after.basisMinor, netMinor: after.netMinor, taxMinor: 0,
        lineTotalMinor: after.netMinor, taxPositions: after.taxPositions, discountAllocations: [{
          allocationId: randomUUID(), adjustmentRef: shipping ? shippingPromotion : linePromotion, sequence: shipping ? 2 : 1,
          source: "legacy_promotion" as const, basisReductionMinor: 1, netReductionMinor: 1, taxReductionMinor: 0,
          evidenceRef: "b".repeat(64), before, after,
        }] };
    };
    const routing = { carrierRef: "carrier", serviceRef: "service", taxClassKey: "class-a", assignmentRef: "assignment-a",
      separatelyStated: true, cost: { ref: "cost", currency, amountMinor: 2 } };
    const fee = { jurisdictionRef: "district", feeKind: "fee", amountMinor: 1, refundRule: { ref: "refund", revision: "1" } };
    return { ...facts, mode, ...(cadence ? { cadence: fixed! } : {}),
      lines: [{ ...line, ...component(100, false), mode }],
      deliveryBuckets: [
        { ...routing, bucketKey: "shipping", kind: "shipping", parts: [{ ...component(2, true), ...(body.amountBasis === "inclusive" ? { sourceOrdinal: 1 } : {}) }] },
        { ...routing, cost: { ...routing.cost, amountMinor: 0 }, bucketKey: "handling", kind: "handling",
          parts: [{ preDiscountMinor: 0, effectiveMinor: 0, netMinor: 0, taxMinor: 0, lineTotalMinor: 0,
            discountAllocations: [], taxPositions: [] }] },
      ],
      feeLines: [
        { ...fee, feeKey: "order-fee", scope: { kind: "order" } },
        { ...fee, feeKey: "delivery-fee", scope: { kind: "delivery", bucketKey: "shipping" }, providerPositionRef: "provider-position" },
      ],
      netTotal: 100, feeTotal: 2, payableMinor: 102,
    };
  };
}

function keySets(actual: unknown, expected: unknown, path = "") {
  if (Array.isArray(expected)) {
    expect(actual, path).toHaveLength(expected.length);
    expected.forEach((item, index) => keySets((actual as unknown[])[index], item, path + "/" + index));
  } else if (expected !== null && typeof expected === "object") {
    expect(actual, path).toBeTypeOf("object");
    const keys = Object.keys(expected).sort();
    expect(Object.keys(actual as Json).sort(), path).toEqual(keys);
    for (const key of keys) keySets((actual as Json)[key], (expected as Json)[key], path + "/" + key);
  }
}

// The pre-guard fixture uses the already installed destination and tax erasers plus
// the receipt and retained row images required by the order assertion.
async function eraseFixture(f: Paid) {
  await transaction(store.owner, async db => {
    await db.query(`LOCK TABLE ${[...storageTables, "identity_privacy_erasures"].map(table => "public." + table).join(",")}
      IN SHARE ROW EXCLUSIVE MODE`);
    const actor = randomUUID(), client = f.accepted.clientId;
    await insert(db, "platform_human_principals", { principal_id: actor, email: actor + "@example.invalid" });
    await db.query("SELECT public.commerce_destination_v2_erase($1)", [client]);
    await db.query("SELECT public.tax_calculation_erase_v1($1)", [client]);
    await insert(db, "identity_privacy_erasures", { erasure_id: randomUUID(), idempotency_key: randomUUID(), client_id: client,
      actor_principal_id: actor, contract_version: "identity.erasure.v1", completed_at: at,
      contributor_versions: { "destination-documents": "commerce.destination-documents.v1", "tax-calculations": "platform.tax-calculations.v1" },
      dispositions: JSON.stringify([{ contributorId: "destination-documents", version: "commerce.destination-documents.v1", obligations: [
        { owner: "destination-documents", resource: "commerce.order-money-destination-pins", disposition: "erase", remote: false },
        { owner: "destination-documents", resource: "commerce.order-money-retained-facts", disposition: "retain", remote: false },
      ] }]), retained_obligations: "[]" });
    await db.query(`UPDATE public.${snapshots} SET destination_erased=true,destination_digest=NULL,
      destination_policy_revision=NULL,delivery_selection_ref=NULL WHERE order_id=$1`, [f.id]);
    await db.query(`UPDATE public.${buckets} SET destination_erased=true,carrier_ref=NULL,service_ref=NULL
      WHERE order_id=$1 AND part_no=0`, [f.id]);
    await db.query("UPDATE public.commerce_orders SET updated_at=updated_at WHERE id=$1", [f.id]);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  });
}

it.each([true, false])("reader_key_sets_closed, erased_order_reads_retained_money and erased_reader_key_sets_closed with cadence=%s", async cadence => {
  const linePromotion = "offer-" + randomUUID(), shippingPromotion = "offer-" + randomUUID();
  const f = await paid(cadence, richMoney(cadence, linePromotion, shippingPromotion), {
    restore: true, promotions: [{ id: linePromotion, lineKey: "item-a" }, { id: shippingPromotion, bucketKey: "shipping" }],
  });
  const expectedLive = await matchesLive(f.id, f.accepted, f.intent, f.event);
  keySets(await read(store.runtime, f.id), JSON.parse(JSON.stringify(expectedLive)));
  const before = await bytes(store.runtime, f.id);
  await eraseFixture(f);
  expect(await value(store.owner, `SELECT jsonb_agg(jsonb_build_array(s.destination_erased,s.destination_digest,
    s.destination_policy_revision,s.delivery_selection_ref,b.destination_erased,b.carrier_ref,b.service_ref,
    d.evidence_disposition,s.destination_snapshot_ref,s.accepted_money_digest) ORDER BY b.bucket_rank) AS value
    FROM public.${snapshots} s JOIN public.${buckets} b USING(order_id)
    JOIN public.commerce_destination_v2_documents d ON d.snapshot_ref=s.destination_snapshot_ref
    WHERE s.order_id=$1 AND b.part_no=0`, [f.id])).toEqual(Array.from({ length: 2 }, () => [
    true, null, null, null, true, null, null, "erased", f.accepted.quote.destination.snapshotRef, f.accepted.quote.moneyDigest,
  ]));
  const expectedErased = await value<string>(store.runtime, `SELECT jsonb_set(source,'{money}',
    ((source->'money') - 'deliverySelectionRef') || jsonb_build_object(
      'destination',((source#>'{money,destination}') - ARRAY['destinationDigest','policyRevision']) || '{"erased":true}'::jsonb,
      'deliveryBuckets',(SELECT jsonb_agg(bucket - ARRAY['carrierRef','serviceRef'] ORDER BY rank)
       FROM jsonb_array_elements(source#>'{money,deliveryBuckets}') WITH ORDINALITY AS b(bucket,rank))))::text AS value
    FROM (SELECT $1::jsonb AS source) live`, [before]);
  expect(await bytes(store.runtime, f.id)).toBe(expectedErased);
  keySets(await read(store.runtime, f.id), JSON.parse(expectedErased));
});
