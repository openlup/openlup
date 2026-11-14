import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresProviderPaymentControlPort, createPostgresPaymentWebhookControlPort,
  createPostgresPaymentProviderReconciliationPort } from "@openlup/platform/payments";
import { lifecycleInstallation, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";
import { AT as preparedAt, call, recordRenewalMethod, renewal } from "./subscriptionNativeFixture.js";
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
  await recordRenewalMethod(env.owner, f, "method-primary");
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

it.each([
  { label: "prompt", firstAt: AT, nextAt: "2032-01-02T12:00:00.000Z" },
  { label: "late", firstAt: preparedAt, nextAt: "2026-09-02T12:00:00.000Z" },
])("retains $label handoff token, revocation, rung and notice identities on fresh advancement and replay", async ({ firstAt, nextAt }) => {
  const f = await fixture();
  const prior = (await env.owner.query(`INSERT INTO public.commerce_checkout_recovery_tokens(order_id,client_id,token_hash,expires_at)
    VALUES($1,$2,$3,now()+interval '30 days') RETURNING id`, [f.order, f.client, createHash("sha256").update(randomUUID()).digest("hex")])).rows[0].id;
  const first = await reconciliation().applyTerminalResult({ ...input(f), occurredAt: firstAt, checkedAt: firstAt });
  const caseId = first.subscriptionWebhookDunning!.caseId;
  expect((await env.owner.query("SELECT revoked_at IS NOT NULL revoked FROM public.commerce_checkout_recovery_tokens WHERE id=$1", [prior])).rows[0].revoked).toBe(true);
  const firstPath = (await env.owner.query("SELECT recovery_url_path FROM public.subscription_dunning_notifications WHERE case_id=$1 AND recipient_kind='customer' AND retry_attempt=1", [caseId])).rows[0].recovery_url_path as string;
  expect(firstPath).toEqual(expect.stringMatching(/^\/recover\?token=rcv_/u));
  const firstHash = createHash("sha256").update(new URL(firstPath, "https://example.invalid").searchParams.get("token")!).digest("hex");
  const firstToken = (await env.owner.query("SELECT id FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1", [firstHash])).rows[0].id;
  await env.owner.query("UPDATE public.fulfillment_stock_current SET stale_after='2033-01-01T00:00Z' WHERE source_key=$1", [f.source]);
  const prepare = { ...f.prepare, idempotencyKey: `window-next:${f.intent}`, providerIdempotencyKey: `window-provider:${f.intent}` };
  await call(env.owner, "subscription_retry_prepare", [f.operation, `window-retry:${f.intent}`, { ...prepare, orderRef: f.order, amountMinor: 200, currency: "XXX" }, nextAt]);
  const a = await attempt(prepare);
  await control().applyPaymentResult({ idempotencyKey: `window-failure:${f.intent}`, paymentIntentId: f.intent, paymentEventId: null,
    resultStatus: "failed", occurredAt: nextAt, failureReason: "declined", failureClass: "soft_retryable" });
  expect(await observe(f, `window-observation:${f.intent}`, a.paymentAttemptId, nextAt)).toMatchObject({ subscriptionWebhookDunning: { caseId, retryAttempt: 2, replayed: false } });
  const tokens = (await env.owner.query(`SELECT count(*)::integer total,count(*) FILTER(WHERE revoked_at IS NULL)::integer active,
    bool_and(expires_at>created_at) valid FROM public.commerce_checkout_recovery_tokens WHERE order_id=$1`, [f.order])).rows[0];
  expect(tokens).toEqual({ total: 3, active: 1, valid: true });
  expect((await env.owner.query(`SELECT t.expires_at=t.created_at+interval '14 days' correct
    FROM public.commerce_checkout_recovery_tokens t JOIN public.subscription_retry_obligations o ON o.order_id=t.order_id
    WHERE t.order_id=$1 AND t.revoked_at IS NULL`, [f.order])).rows[0].correct).toBe(true);
  const notices = (await env.owner.query("SELECT id,retry_attempt,recovery_url_path FROM public.subscription_dunning_notifications WHERE case_id=$1 AND recipient_kind='customer' ORDER BY retry_attempt", [caseId])).rows;
  expect(notices.map(n => n.retry_attempt)).toEqual([1, 2]);
  expect((await env.owner.query("SELECT retry_attempt,recovery_url_path FROM public.subscription_dunning_notifications WHERE case_id=$1 AND recipient_kind='operator' ORDER BY retry_attempt", [caseId])).rows)
    .toEqual([{ retry_attempt: 1, recovery_url_path: null }, { retry_attempt: 2, recovery_url_path: null }]);
  expect(notices[1].recovery_url_path).toEqual(expect.stringMatching(/^\/recover\?token=rcv_/u));
  const before = await snapshot(f);
  expect(await observe(f, `window-duplicate:${f.intent}`, a.paymentAttemptId, nextAt)).toMatchObject({ subscriptionWebhookDunning: { retryAttempt: 2, replayed: true } });
  expect(await observe(f, `window-stale:${f.intent}`, f.a.paymentAttemptId, firstAt)).toMatchObject({ subscriptionWebhookDunning: { retryAttempt: 2, replayed: true } });
  expect(await snapshot(f)).toEqual(before);
  expect((await env.owner.query("SELECT id,retry_attempt,recovery_url_path FROM public.subscription_dunning_notifications WHERE case_id=$1 AND recipient_kind='customer' ORDER BY retry_attempt", [caseId])).rows).toEqual(notices);
  await env.owner.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [f.subscription]);
  const current = (await env.owner.query("SELECT id,created_at+interval '1 second' redeem_at FROM public.commerce_checkout_recovery_tokens WHERE order_id=$1 AND revoked_at IS NULL", [f.order])).rows[0];
  expect((await env.owner.query("SELECT revoked_at IS NOT NULL revoked FROM public.commerce_checkout_recovery_tokens WHERE id=$1", [firstToken])).rows[0].revoked).toBe(true);
  await expect(call(env.runtime, "subscription_retry_authorize_recovery", [f.operation, firstToken, "method-primary", "usable-method-evidence", current.redeem_at]))
    .rejects.toMatchObject({ code: "22023", message: "subscription_retry_recovery_not_authorized" });
  expect(await call(env.runtime, "subscription_retry_authorize_recovery", [f.operation, current.id, "method-primary", "usable-method-evidence", current.redeem_at]))
    .toMatchObject({ token_id: current.id, retry_attempt: 2 });
});

it.each(["recovered", "cancelled", "paused", "expired"])("refuses late-link redemption when its case is %s despite live token and usable method", async status => {
  const f = await fixture();
  const first = await reconciliation().applyTerminalResult({ ...input(f), occurredAt: preparedAt, checkedAt: preparedAt });
  const caseId = first.subscriptionWebhookDunning!.caseId;
  await env.owner.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [f.subscription]);
  const token = (await env.owner.query("SELECT id,created_at+interval '1 second' redeem_at,expires_at>created_at+interval '1 second' live FROM public.commerce_checkout_recovery_tokens WHERE order_id=$1 AND revoked_at IS NULL", [f.order])).rows[0];
  expect(token.live).toBe(true);
  await env.owner.query(`UPDATE public.subscription_dunning_cases SET status=$2,
    recovered_at=CASE WHEN $2='recovered' THEN $3::timestamptz END,
    expired_at=CASE WHEN $2='expired' THEN $3::timestamptz END WHERE id=$1`, [caseId, status, token.redeem_at]);
  const before = await snapshot(f);
  await expect(call(env.runtime, "subscription_retry_authorize_recovery", [f.operation, token.id, "method-primary", "usable-method-evidence", token.redeem_at]))
    .rejects.toMatchObject({ code: "22023", message: "subscription_retry_recovery_not_authorized" });
  expect(await snapshot(f)).toEqual(before);
  expect((await env.owner.query("SELECT count(*)::integer n FROM public.subscription_retry_recovery_authorizations WHERE token_id=$1", [token.id])).rows[0].n).toBe(0);
  await env.owner.query("UPDATE public.subscription_dunning_cases SET status='open',recovered_at=NULL,expired_at=NULL WHERE id=$1", [caseId]);
  expect(await call(env.runtime, "subscription_retry_authorize_recovery", [f.operation, token.id, "method-primary", "usable-method-evidence", token.redeem_at]))
    .toMatchObject({ token_id: token.id, retry_attempt: 1 });
});

const handoffOrders = ["direct-result-first", "webhook-first", "already-handed-off"] as const;
type HandoffOrder = typeof handoffOrders[number] | "unattributed-case";
const handoffFixtures = new Map<HandoffOrder, { f: Fixture; eventId: string; request: Parameters<NonNullable<ReturnType<typeof createPostgresPaymentWebhookControlPort>["applyPaymentResult"]>>[0] }>();
beforeAll(async () => {
  const hook = createPostgresPaymentWebhookControlPort(env.runtime, options);
  for (const order of [...handoffOrders, "unattributed-case"] as const) {
    const f = await fixture(), eventId = `separate-handoff:${f.intent}`;
    const event = await hook.ingestPaymentEvent({ provider: "card_rail", providerEventId: eventId,
      providerPaymentId: `pi_${f.a.paymentAttemptId}`, eventType: "payment.failed", paymentIntentId: f.intent,
      amountMinor: 0, currency: "XXX", occurredAt: AT, rawPayload: {} });
    handoffFixtures.set(order, { f, eventId, request: { idempotencyKey: `provider-webhook:card_rail:${eventId}:apply`,
      paymentIntentId: f.intent, paymentEventId: event.paymentEventId, resultStatus: "failed", occurredAt: AT, failureReason: "declined" } });
  }
}, postgresSetupTimeoutMs);
function directFailure(f: Fixture) {
  return { idempotencyKey: `direct-failure:${f.intent}`, paymentIntentId: f.intent, paymentEventId: null,
    resultStatus: "failed" as const, occurredAt: AT, failureReason: "declined", failureClass: "soft_retryable" };
}
async function handoffRows(f: Fixture) {
  return (await env.owner.query(`SELECT jsonb_build_object('business',jsonb_build_array(
    (SELECT to_jsonb(o) FROM public.subscription_retry_obligations o WHERE cycle_id=$1),
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.subscription_retry_receipts r JOIN public.subscription_retry_obligations o ON o.id=r.obligation_id WHERE o.cycle_id=$1),
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM public.subscription_dunning_cases c WHERE cycle_id=$1),
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.case_id) FROM public.payment_dunning_case_attribution a JOIN public.subscription_dunning_cases c ON c.id=a.case_id WHERE c.cycle_id=$1),
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.payment_method_recovery_authorities a WHERE cycle_id=$1),
    (SELECT jsonb_agg(to_jsonb(n) ORDER BY n.id) FROM public.subscription_dunning_notifications n WHERE case_id IN (SELECT id FROM public.subscription_dunning_cases WHERE cycle_id=$1)),
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.commerce_checkout_recovery_tokens t WHERE order_id=$2)),
    'audit',jsonb_build_array(
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.payment_provider_transitions t WHERE settlement_intent_id=$3),
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.payment_provider_attempt_evidence e WHERE settlement_intent_id=$3),
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.scope,r.idempotency_key) FROM public.payment_provider_receipts r WHERE metadata->>'paymentIntentId'=$3::text OR metadata->>'failedPaymentAttemptId'=$4::text),
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.subscription_events e WHERE subscription_id=$5))) state`,
  [f.cycle, f.order, f.intent, f.a.paymentAttemptId, f.subscription])).rows[0].state;
}
async function webhookReceipt(key: string) {
  return (await env.owner.query("SELECT response_payload FROM public.payment_provider_receipts WHERE scope='commerce.payment_result.apply' AND idempotency_key=$1", [key])).rows[0].response_payload;
}
it.each(handoffOrders)("preserves separate failure/handoff ordering: %s", async order => {
  const { f, request } = handoffFixtures.get(order)!, direct = directFailure(f);
  const hook = createPostgresPaymentWebhookControlPort(env.runtime, options);
  if (order !== "webhook-first") {
    expect(await control().applyPaymentResult(direct)).toMatchObject({ kind: "state_changed", replayed: false });
    expect((await env.owner.query("SELECT count(*)::integer n FROM public.subscription_dunning_cases WHERE cycle_id=$1", [f.cycle])).rows[0].n).toBe(0);
    const before = await handoffRows(f);
    await expect(call(env.runtime, "payment_reconciliation_open_dunning_from_failed_result", [`foreign-event:${f.intent}`, f.intent,
      handoffFixtures.get("webhook-first")!.eventId, "declined", AT, null, f.a.paymentAttemptId, "dunning", "/recover"]))
      .rejects.toMatchObject({ code: "55000", message: "subscription_dunning_failed_attempt_unattributed" });
    expect(await handoffRows(f)).toEqual(before);
  }
  if (order === "already-handed-off") await observe(f, `earlier-handoff:${f.intent}`);
  const beforeWebhook = await handoffRows(f);
  expect(await hook.applyPaymentResult!(request)).toEqual({ replayed: false });
  const receipt = await webhookReceipt(request.idempotencyKey);
  expect(receipt).toMatchObject({ paymentResult: { kind: order === "webhook-first" ? "state_changed" : "ignored_duplicate_terminal_failure" },
    subscriptionWebhookDunning: { opened: true, replayed: order === "already-handed-off", retryAttempt: 1 } });
  if (order === "already-handed-off") expect((await handoffRows(f)).business).toEqual(beforeWebhook.business);
  if (order === "webhook-first") {
    const beforeDirect = await handoffRows(f);
    expect(await control().applyPaymentResult(direct)).toMatchObject({ kind: "ignored_duplicate_terminal_failure", replayed: false });
    expect((await handoffRows(f)).business).toEqual(beforeDirect.business);
  }
  const originalKey = (order === "webhook-first" ? request.idempotencyKey : direct.idempotencyKey) + ":truth";
  const original = (await env.owner.query(`SELECT r.id,r.receipt_key FROM public.subscription_retry_receipts r
    JOIN public.subscription_retry_obligations o ON o.id=r.obligation_id WHERE o.cycle_id=$1 AND r.kind='failure'`, [f.cycle])).rows;
  expect(original).toEqual([{ id: expect.any(String), receipt_key: originalKey }]);
  const caseId = receipt.subscriptionWebhookDunning.caseId;
  expect((await env.owner.query("SELECT failed_payment_attempt_id,failure_receipt_id FROM public.payment_dunning_case_attribution WHERE case_id=$1", [caseId])).rows)
    .toEqual([{ failed_payment_attempt_id: f.a.paymentAttemptId, failure_receipt_id: original[0].id }]);
  expect((await env.owner.query(`SELECT
    (SELECT count(*)::integer FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='failed') financial,
    (SELECT count(*)::integer FROM public.subscription_dunning_cases WHERE cycle_id=$2) cases,
    (SELECT retry_attempt FROM public.subscription_retry_obligations WHERE cycle_id=$2 AND case_id=$3) rung`, [f.intent, f.cycle, caseId])).rows[0])
    .toEqual({ financial: 1, cases: 1, rung: 1 });
  expect((await env.owner.query("SELECT payload ? 'retryFailureKey' has_key FROM public.payment_provider_transitions WHERE idempotency_key=$1", [request.idempotencyKey + ":payment_result"])).rows)
    .toEqual([{ has_key: order === "webhook-first" }]);
  expect((await env.owner.query(`SELECT a.case_id,a.purpose,a.revoked_at,t.revoked_at token_revoked
    FROM public.payment_method_recovery_authorities a JOIN public.commerce_checkout_recovery_tokens t ON t.id=a.token_id WHERE a.cycle_id=$1`, [f.cycle])).rows)
    .toEqual([{ case_id: caseId, purpose: "repair_payment", revoked_at: null, token_revoked: null }]);
  expect((await env.owner.query("SELECT recipient_kind,retry_attempt FROM public.subscription_dunning_notifications WHERE case_id=$1 ORDER BY recipient_kind", [caseId])).rows)
    .toEqual([{ recipient_kind: "customer", retry_attempt: 1 }, { recipient_kind: "operator", retry_attempt: 1 }]);
  expect((await env.owner.query("SELECT status,recovery_url_path FROM public.subscription_dunning_notifications WHERE case_id=$1 AND recipient_kind='customer'", [caseId])).rows)
    .toEqual([{ status: "queued", recovery_url_path: expect.stringMatching(/^\/recover\?token=rcv_/u) }]);
  const before = { original: await snapshot(f), handoff: await handoffRows(f) };
  expect(await hook.applyPaymentResult!(request)).toEqual({ replayed: true });
  expect(await control().applyPaymentResult(direct)).toMatchObject({ replayed: true });
  expect({ original: await snapshot(f), handoff: await handoffRows(f) }).toEqual(before);
});
it("keeps a webhook's named attribution refusal sticky after an ignored financial result", async () => {
  const { f, request } = handoffFixtures.get("unattributed-case")!;
  await control().applyPaymentResult(directFailure(f));
  await call(env.owner, "subscription_retry_open_case", [f.operation, "dunning", "/recover"]);
  const hook = createPostgresPaymentWebhookControlPort(env.runtime, options);
  expect(await hook.applyPaymentResult!(request)).toEqual({ replayed: false });
  const refused = await webhookReceipt(request.idempotencyKey);
  expect(refused).toMatchObject({ paymentResult: { kind: "ignored_duplicate_terminal_failure" },
    subscriptionWebhookDunning: { opened: false, reason: "subscription_dunning_case_unattributed" } });
  await env.owner.query("UPDATE public.subscription_cycles SET status='paid' WHERE id=$1", [f.cycle]);
  const before = { original: await snapshot(f), handoff: await handoffRows(f) };
  expect(await hook.applyPaymentResult!(request)).toEqual({ replayed: true });
  expect(await webhookReceipt(request.idempotencyKey)).toEqual(refused);
  expect({ original: await snapshot(f), handoff: await handoffRows(f) }).toEqual(before);
});
