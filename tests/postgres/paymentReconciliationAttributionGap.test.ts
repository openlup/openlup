import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresProviderPaymentControlPort, createPostgresPaymentWebhookControlPort,
  createPostgresPaymentProviderReconciliationPort } from "@openlup/platform/payments";
import { lifecycleInstallation, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";
import { AT as preparedAt, call, renewal } from "./subscriptionNativeFixture.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const AT = "2032-01-01T12:00:00.000Z";
let env: LifecycleInstallation;
const options = { dunningTemplateSlug: "dunning", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" };
beforeAll(async () => { env = await lifecycleInstallation("qualified-v2"); }, postgresSetupTimeoutMs);
afterAll(async () => { await env?.close(); }, postgresTeardownTimeoutMs);
const control = () => createPostgresProviderPaymentControlPort(env.runtime, options);
const reconciliation = () => createPostgresPaymentProviderReconciliationPort(env.runtime, options);

async function fixture() {
  const f = await renewal(env.owner, 10, 1, randomUUID(), true);
  await call(env.owner, "fulfillment_reserve_subscription_renewal", [f.operation, f.token, 900, preparedAt]);
  const original = await call(env.owner, "commerce_prepare_subscription_renewal", [f.operation, f.token, preparedAt]);
  const cycle = (await env.owner.query("SELECT subscription_cycle_id FROM public.commerce_orders WHERE id=$1", [original.orderId])).rows[0].subscription_cycle_id as string;
  const intent = await control().createIntent({ idempotencyKey: `intent:${f.operation}`, targetKind: "subscription_cycle",
    orderId: original.orderId, subscriptionId: f.subscription, subscriptionCycleId: cycle,
    amountMinor: 200, currency: "XXX", metadata: {}, channelKey: "fixture", at: AT });
  const prepare = { idempotencyKey: `prepare:${f.operation}`, paymentIntentId: intent.id, provider: "card_rail",
    providerIdempotencyKey: `provider:${f.operation}`, providerRequestFingerprint: "f".repeat(64),
    providerFlow: "off_session_payment", paymentMethodRef: "method-primary", requestPayload: {} };
  const a = await attempt(prepare);
  await call(env.owner, "commerce_acknowledge_subscription_renewal_attempt", [f.operation, f.fingerprint, `pi_${a.paymentAttemptId}`, preparedAt]);
  return { ...f, intent: intent.id, payment: intent.paymentId, order: original.orderId as string, cycle, prepare, a };
}
async function attempt(prepare: Parameters<ReturnType<typeof control>["prepareProviderAttempt"]>[0]) {
  const a = await control().prepareProviderAttempt(prepare);
  await control().finalizeProviderAttempt({ idempotencyKey: `finalize:${a.paymentAttemptId}`, paymentIntentId: prepare.paymentIntentId,
    paymentAttemptId: a.paymentAttemptId, providerIdempotencyKey: prepare.providerIdempotencyKey,
    providerRequestFingerprint: prepare.providerRequestFingerprint, providerAttemptId: `pi_${a.paymentAttemptId}`, providerSessionId: null,
    attemptStatus: "processing", nextActionKind: null, requestPayload: {}, responsePayload: {} });
  return a;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function input(f: Fixture, key = `reconcile:${f.operation}`) {
  return { idempotencyKey: key, expectedOrderId: f.order, expectedPaymentIntentId: f.intent,
    expectedPaymentAttemptId: f.a.paymentAttemptId, expectedPaymentId: f.payment, provider: "card_rail",
    providerPaymentId: `pi_${f.a.paymentAttemptId}`, localStatus: "processing", providerStatus: "failed", resultStatus: "failed" as const,
    occurredAt: AT, failureReason: "declined", failureClassification: { failureClass: "soft_retryable", decidedBy: "fixture" },
    checkedAt: AT, payload: {} };
}
async function snapshot(f: Fixture) {
  return (await env.owner.query(`SELECT jsonb_build_array(
   (SELECT to_jsonb(o) FROM public.subscription_retry_obligations o WHERE cycle_id=$1),
   (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.subscription_retry_receipts r JOIN public.subscription_retry_obligations o ON o.id=r.obligation_id WHERE o.cycle_id=$1),
   (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM public.subscription_dunning_cases c WHERE cycle_id=$1),
   (SELECT jsonb_agg(to_jsonb(n) ORDER BY n.id) FROM public.subscription_dunning_notifications n WHERE case_id IN (SELECT id FROM public.subscription_dunning_cases WHERE cycle_id=$1)),
   (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.commerce_checkout_recovery_tokens t WHERE order_id=$2),
   (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.commerce_settlement_transitions t WHERE intent_id=$3),
   (SELECT to_jsonb(s) FROM public.payment_provider_states s WHERE id=$3),
   (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.payment_provider_attempts a WHERE settlement_intent_id=$3),
   (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.idempotency_key) FROM public.payment_provider_receipts r WHERE metadata->>'paymentIntentId'=$3::text),
   (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.payment_truth_events e WHERE settlement_intent_id=$3)
  ) state`, [f.cycle, f.order, f.intent])).rows[0].state;
}
async function observe(f: Fixture, key: string, attemptId = f.a.paymentAttemptId, at = AT) {
  return call(env.runtime, "payment_reconciliation_open_dunning_from_failed_result", [key, f.intent, null, "declined", at,
    "soft_retryable", attemptId, options.dunningTemplateSlug, options.recoveryUrlPath]);
}

it("links exactly one retry case and replays the former duplicate-key collision without authority changes", async () => {
  const f = await fixture(), applied = await reconciliation().applyTerminalResult(input(f));
  expect(applied).toMatchObject({ replayed: false, correctionStatus: "corrected", subscriptionWebhookDunning: { opened: true, replayed: false } });
  const caseId = applied.subscriptionWebhookDunning!.caseId;
  expect((await env.owner.query("SELECT case_id,retry_attempt FROM public.subscription_retry_obligations WHERE cycle_id=$1", [f.cycle])).rows)
    .toEqual([{ case_id: caseId, retry_attempt: 1 }]);
  expect((await env.owner.query("SELECT count(*)::integer n FROM public.subscription_dunning_cases WHERE cycle_id=$1", [f.cycle])).rows[0].n).toBe(1);
  expect((await env.owner.query("SELECT count(*)::integer n FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='failed'", [f.intent])).rows[0].n).toBe(1);
  const before = await snapshot(f);
  expect(await reconciliation().applyTerminalResult(input(f))).toMatchObject({ replayed: true, subscriptionWebhookDunning: { caseId, replayed: true } });
  expect(await snapshot(f)).toEqual(before);
  expect(await observe(f, `second-observer:${f.operation}`)).toMatchObject({ subscriptionWebhookDunning: { caseId, replayed: true } });
  expect(await snapshot(f)).toEqual(before);
  expect(await call(env.owner, "subscription_retry_open_case", [f.operation, "dunning", "/recover"])).toMatchObject({ caseId });
});

it("advances for a genuine next failure and preserves newer authority on stale and duplicate observations", async () => {
  const f = await fixture(); const first = await reconciliation().applyTerminalResult(input(f));
  expect((await env.owner.query("SELECT count(*)::integer n FROM public.commerce_checkout_recovery_tokens WHERE order_id=$1", [f.order])).rows[0].n).toBe(1);
  await env.owner.query("UPDATE public.payment_dunning_case_attribution SET failure_observation_result=NULL WHERE case_id=$1", [first.subscriptionWebhookDunning!.caseId]);
  await env.owner.query("UPDATE public.fulfillment_stock_current SET stale_after='2033-01-01T00:00Z' WHERE source_key=$1", [f.source]);
  const nextAt = "2032-01-02T12:00:00.000Z", prepare = { ...f.prepare, idempotencyKey: `next:${f.intent}`, providerIdempotencyKey: `next-provider:${f.intent}` };
  await call(env.owner, "subscription_retry_prepare", [f.operation, `retry:${f.intent}`, { ...prepare, orderRef: f.order, amountMinor: 200, currency: "XXX" }, nextAt]);
  const a = await attempt(prepare);
  await control().applyPaymentResult({ idempotencyKey: `next-failure:${a.paymentAttemptId}`, paymentIntentId: f.intent, paymentEventId: null,
    resultStatus: "failed", occurredAt: nextAt, failureReason: "declined", failureClass: "soft_retryable" });
  expect(await observe(f, `next-observation:${f.intent}`, a.paymentAttemptId, nextAt)).toMatchObject({ subscriptionWebhookDunning: { caseId: first.subscriptionWebhookDunning!.caseId, retryAttempt: 2, replayed: false } });
  expect((await env.owner.query("SELECT count(*)::integer n,count(*) FILTER(WHERE revoked_at IS NULL)::integer active FROM public.commerce_checkout_recovery_tokens WHERE order_id=$1", [f.order])).rows[0]).toEqual({ n: 2, active: 1 });
  const before = await snapshot(f);
  expect(await observe(f, `old-observation:${f.intent}`)).toMatchObject({ subscriptionWebhookDunning: { retryAttempt: 2, replayed: true } });
  expect(await observe(f, `repeat-next:${f.intent}`, a.paymentAttemptId, nextAt)).toMatchObject({ subscriptionWebhookDunning: { retryAttempt: 2, replayed: true } });
  expect(await snapshot(f)).toEqual(before);
  await env.owner.query("UPDATE public.payment_dunning_case_attribution SET failure_observation_result=NULL WHERE case_id=$1", [first.subscriptionWebhookDunning!.caseId]);
  await expect(observe(f, `cache-absent:${f.intent}`)).rejects.toMatchObject({ code: "55000", message: "subscription_dunning_replay_unavailable" });
});

const refusals = ["failed_attempt_unattributed", "case_unattributed", "replay_unavailable", "failed_attempt_ambiguous", "failed_attempt_rung_mismatch"];
it.each(refusals)("isolates the named attribution refusal %s and replays its evidence after eligibility changes", async refusal => {
  const f = await fixture(), message = `subscription_dunning_${refusal}`;
  const definition = (await env.owner.query("SELECT pg_get_functiondef('public.payment_reconciliation_open_dunning_from_failed_result(text,uuid,text,text,timestamptz,text,uuid,text,text)'::regprocedure) body")).rows[0].body;
  try {
    await env.owner.query(`CREATE OR REPLACE FUNCTION public.payment_reconciliation_open_dunning_from_failed_result(
      p_idempotency_key text,p_payment_intent_id uuid,p_provider_event_id text,p_failure_reason text,p_occurred_at timestamptz,
      p_failure_class text,p_failed_payment_attempt_id uuid,p_template text,p_recovery_path text)
      RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN RAISE EXCEPTION '${message}' USING ERRCODE='55000'; END; $$`);
    const applied = await reconciliation().applyTerminalResult(input(f));
    expect(applied).toMatchObject({ correctionStatus: "corrected", subscriptionWebhookDunning: { opened: false } });
    expect((await env.owner.query("SELECT payload FROM public.payment_provider_reconciliation_runs WHERE idempotency_key=$1", [`reconcile:${f.operation}:evidence`])).rows[0].payload).toMatchObject({ applied: true, dunningObservationRefusal: message });
    expect((await env.owner.query("SELECT payment_status FROM public.payment_provider_states WHERE id=$1", [f.intent])).rows[0].payment_status).toBe("failed");
    await env.owner.query(definition);
    await env.owner.query("UPDATE public.subscription_cycles SET status='paid' WHERE id=$1", [f.cycle]);
    const before = await snapshot(f);
    expect(await reconciliation().applyTerminalResult(input(f))).toMatchObject({ replayed: true });
    expect(await snapshot(f)).toEqual(before);
  } finally { await env.owner.query(definition); }
});

it.each([{ message: "unrelated_handoff_failure", code: "55000" }, { message: "subscription_dunning_case_unattributed", code: "22023" }])(
  "rolls back every financial and retry effect on $message/$code", async ({ message, code }) => {
    const f = await fixture(), before = await snapshot(f);
    const definition = (await env.owner.query("SELECT pg_get_functiondef('public.payment_reconciliation_open_dunning_from_failed_result(text,uuid,text,text,timestamptz,text,uuid,text,text)'::regprocedure) body")).rows[0].body;
    try {
      await env.owner.query(`CREATE OR REPLACE FUNCTION public.payment_reconciliation_open_dunning_from_failed_result(
        p_idempotency_key text,p_payment_intent_id uuid,p_provider_event_id text,p_failure_reason text,p_occurred_at timestamptz,
        p_failure_class text,p_failed_payment_attempt_id uuid,p_template text,p_recovery_path text)
        RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN RAISE EXCEPTION '${message}' USING ERRCODE='${code}'; END; $$`);
      await expect(reconciliation().applyTerminalResult(input(f))).rejects.toMatchObject({ message, code });
      expect(await snapshot(f)).toEqual(before);
    } finally { await env.owner.query(definition); }
  });

it("rolls back application on all four claim-identity mismatches and evidence failure", async () => {
  const f = await fixture(), before = await snapshot(f);
  for (const field of ["expectedOrderId", "expectedPaymentIntentId", "expectedPaymentAttemptId", "expectedPaymentId"]) {
    await expect(reconciliation().applyTerminalResult({ ...input(f), [field]: randomUUID() })).rejects.toBeInstanceOf(Error);
    expect(await snapshot(f)).toEqual(before);
  }
  const q = await env.owner.connect();
  try {
    await q.query("BEGIN");
    await q.query(`CREATE FUNCTION pg_temp.refuse_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_evidence_failure'; END; $$;
      CREATE TRIGGER r3_evidence_failure BEFORE INSERT ON public.payment_provider_reconciliation_runs FOR EACH ROW EXECUTE FUNCTION pg_temp.refuse_evidence()`);
    await expect(createPostgresPaymentProviderReconciliationPort(q, options).applyTerminalResult(input(f))).rejects.toBeInstanceOf(Error);
    await q.query("ROLLBACK");
    expect(await snapshot(f)).toEqual(before);
  } finally { await q.query("ROLLBACK"); q.release(); }
});

it("uses the webhook's durable applied attempt, preserving a single financial transition and replay", async () => {
  const f = await fixture(), hook = createPostgresPaymentWebhookControlPort(env.runtime, options), eventId = `event:${f.intent}`;
  const e = await hook.ingestPaymentEvent({ provider: "card_rail", providerEventId: eventId, providerPaymentId: `pi_${f.a.paymentAttemptId}`,
    eventType: "payment.failed", paymentIntentId: f.intent, amountMinor: 0, currency: "XXX", occurredAt: AT, rawPayload: {} });
  const key = `provider-webhook:card_rail:${eventId}:apply`, request = { idempotencyKey: key, paymentIntentId: f.intent,
    paymentEventId: e.paymentEventId, resultStatus: "failed" as const, occurredAt: AT, failureReason: "declined" };
  await hook.applyPaymentResult!(request);
  expect((await env.owner.query("SELECT a.failed_payment_attempt_id FROM public.payment_dunning_case_attribution a JOIN public.subscription_dunning_cases c ON c.id=a.case_id WHERE c.cycle_id=$1", [f.cycle])).rows)
    .toEqual([{ failed_payment_attempt_id: f.a.paymentAttemptId }]);
  const before = await snapshot(f);
  expect(await hook.applyPaymentResult!(request)).toEqual({ replayed: true });
  expect(await snapshot(f)).toEqual(before);
});

it("preserves financial failure on a real historical unattributed case and refuses automatic adoption", async () => {
  const f = await fixture(), request = input(f);
  await control().applyPaymentResult({ idempotencyKey: request.idempotencyKey, paymentIntentId: f.intent, paymentEventId: null,
    resultStatus: "failed", occurredAt: AT, failureReason: "declined", failureClass: "soft_retryable", failureClassDecidedBy: "fixture" });
  await call(env.owner, "subscription_retry_open_case", [f.operation, "dunning", "/recover"]);
  const before = await snapshot(f), applied = await reconciliation().applyTerminalResult(request);
  expect(applied).toMatchObject({ subscriptionWebhookDunning: { opened: false } });
  expect((await env.owner.query("SELECT payload->>'dunningObservationRefusal' reason FROM public.payment_provider_reconciliation_runs WHERE idempotency_key=$1", [request.idempotencyKey+":evidence"])).rows[0].reason).toBe("subscription_dunning_case_unattributed");
  expect(await snapshot(f)).toEqual(before);
  expect(await reconciliation().applyTerminalResult(request)).toMatchObject({ replayed: true });
});

it("serializes webhook and reconciliation observations without another rung, financial transition or case", async () => {
  const f = await fixture(), hook = createPostgresPaymentWebhookControlPort(env.runtime, options), eventId = `race:${f.intent}`;
  const event = await hook.ingestPaymentEvent({ provider: "card_rail", providerEventId: eventId, providerPaymentId: `pi_${f.a.paymentAttemptId}`,
    eventType: "payment.failed", paymentIntentId: f.intent, amountMinor: 0, currency: "XXX", occurredAt: AT, rawPayload: {} });
  await Promise.all([reconciliation().applyTerminalResult(input(f)), hook.applyPaymentResult!({ idempotencyKey: `provider-webhook:card_rail:${eventId}:apply`,
    paymentIntentId: f.intent, paymentEventId: event.paymentEventId, resultStatus: "failed", occurredAt: AT, failureReason: "declined" })]);
  expect((await env.owner.query("SELECT count(*)::integer n FROM public.subscription_retry_receipts WHERE kind='failure' AND obligation_id IN (SELECT id FROM public.subscription_retry_obligations WHERE cycle_id=$1)", [f.cycle])).rows[0].n).toBe(1);
  expect((await env.owner.query("SELECT count(*)::integer n FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='failed'", [f.intent])).rows[0].n).toBe(1);
  expect((await env.owner.query("SELECT count(*)::integer n FROM public.subscription_dunning_cases WHERE cycle_id=$1", [f.cycle])).rows[0].n).toBe(1);
});
