import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresProviderPaymentControlPort, createPostgresPaymentProviderReconciliationPort } from "@openlup/platform/payments";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureStoreJourney, journeyCensus, journeySelection, storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { AT, call, renewal } from "./subscriptionNativeFixture.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const resources = storeJourneyResources();
const options = { dunningTemplateSlug: "dunning", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" };
let source: JourneyInstallation, target: JourneyInstallation;
beforeAll(async () => { source = await resources.installation("reconciliation-source"); target = await resources.installation("reconciliation-target"); }, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

it("carries all reconciliation, reopen, dunning and refund rows exactly and replays without fresh effects", async () => {
  const db = await source.owner.connect();
  try {
    for (const path of ["paymentProvider/setup.sql", "paymentReconciliation/setup.sql"]) {
      await db.query(readFileSync(`tests/postgres/fixtures/${path}`, "utf8"));
    }
    await db.query("SELECT pg_temp.refund_observe(f,'transfer-full-refund',12999) FROM proof_fixture WHERE name='capture'");
    await db.query(`UPDATE public.payment_provider_attempts SET created_at='2026-11-13T10:00Z',updated_at='2026-11-13T10:00Z'
      WHERE id=(SELECT (f->>'attempt')::uuid FROM proof_fixture WHERE name='prepared')`);
    await db.query(`UPDATE public.payment_provider_states SET created_at='2026-11-13T10:00Z',updated_at='2026-11-13T10:00Z'
      WHERE id=(SELECT (f->>'intent')::uuid FROM proof_fixture WHERE name='prepared')`);
    await db.query("SELECT * FROM public.commerce_payment_reconciliation_claim_prepared_attempts('2026-11-13T12:00Z',900,50,'transfer-claim')");
    await db.query(`SELECT public.commerce_payment_control_reopen_prepared_attempt_after_absence('transfer-reopen',(f->>'attempt')::uuid,
      (f->>'intent')::uuid,(f->>'cycle')::uuid,'operator.fixture','2026-11-13T12:00Z','2026-11-13T12:10Z','{"providerAbsenceConfirmed":true}')
      FROM proof_fixture WHERE name='prepared'`);
  } finally { db.release(); }
  const f = await renewal(source.owner, 10, 1, randomUUID(), true);
  await call(source.owner, "fulfillment_reserve_subscription_renewal", [f.operation, f.token, 900, AT]);
  const original = await call(source.owner, "commerce_prepare_subscription_renewal", [f.operation, f.token, AT]);
  const cycle = (await source.owner.query("SELECT subscription_cycle_id FROM public.commerce_orders WHERE id=$1", [original.orderId])).rows[0].subscription_cycle_id;
  const control = createPostgresProviderPaymentControlPort(source.runtime, options);
  const intent = await control.createIntent({ idempotencyKey: `intent:${f.operation}`, targetKind: "subscription_cycle", orderId: original.orderId,
    subscriptionId: f.subscription, subscriptionCycleId: cycle, amountMinor: 200, currency: "XXX", metadata: {}, channelKey: "fixture", at: AT });
  const prepare = { idempotencyKey: `prepare:${f.operation}`, paymentIntentId: intent.id, provider: "card_rail",
    providerIdempotencyKey: `provider:${f.operation}`, providerRequestFingerprint: "f".repeat(64), providerFlow: "off_session_payment", requestPayload: {} };
  const attempt = await control.prepareProviderAttempt(prepare);
  await control.finalizeProviderAttempt({ ...prepare, idempotencyKey: `finalize:${f.operation}`, paymentAttemptId: attempt.paymentAttemptId,
    providerAttemptId: `payment_${f.operation}`, providerSessionId: null, attemptStatus: "processing", nextActionKind: null, responsePayload: {} });
  await call(source.owner, "commerce_acknowledge_subscription_renewal_attempt", [f.operation, f.fingerprint, `payment_${f.operation}`, AT]);
  const request = { idempotencyKey: `reconciliation:${f.operation}`, expectedOrderId: original.orderId, expectedPaymentIntentId: intent.id,
    expectedPaymentAttemptId: attempt.paymentAttemptId, expectedPaymentId: intent.paymentId, provider: "card_rail", providerPaymentId: `payment_${f.operation}`,
    localStatus: "processing", providerStatus: "failed", resultStatus: "failed" as const, occurredAt: "2032-01-01T12:00:00Z",
    failureReason: "declined", checkedAt: "2032-01-01T12:00:00Z", payload: {} };
  await createPostgresPaymentProviderReconciliationPort(source.runtime, options).applyTerminalResult(request);
  const before = await journeyCensus(source.owner), packet = await captureStoreJourney(source.owner, "reconciliation-source");
  const freshTarget = await captureStoreJourney(target.owner, "reconciliation-target"), pristine = await journeyCensus(target.owner);
  for (const table of ["payment_provider_reconciliation_runs", "payment_prepared_absence_reopens", "payment_dunning_case_attribution", "payment_refund_evidence"] as const) {
    expect(before[table].length).toBeGreaterThan(0);
    expect(packet.owned.find(value => value.table === table)?.rows).toEqual(before[table]);
  }
  const broken = structuredClone(packet), row = broken.owned.find(value => value.table === "payment_dunning_case_attribution")!;
  row.rows[0] = row.rows[0].replace(/("failure_receipt_id":\s*")[^"]+(")/u, `$1${randomUUID()}$2`);
  const { sha256: _old, ...body } = broken; broken.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  await expect(restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet: broken, freshTarget })).rejects.toMatchObject({ code: "target_conflict" });
  expect(await journeyCensus(target.owner)).toEqual(pristine);
  const input = { owner: target.owner, installation: journeySelection, packet, freshTarget };
  expect(await restoreConnectedNativeStore(input)).toMatchObject({ replayed: false });
  expect(await journeyCensus(target.owner)).toEqual(before);
  expect(await restoreConnectedNativeStore(input)).toMatchObject({ replayed: true });
  expect(await createPostgresPaymentProviderReconciliationPort(target.runtime, options).applyTerminalResult(request)).toMatchObject({ replayed: true });
  expect(await journeyCensus(target.owner)).toEqual(before);
});
