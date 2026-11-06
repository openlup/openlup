import { createHash } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { createCapturedTransactionalDelivery, createPostgresTransactionalDeliveryStore, createTransactionalDelivery,
  type TransactionalDeliveryCommand } from "@openlup/platform/communications";
import { createPostgresLifecycleMessages, createPostgresRetryStore, runOneAutomaticSubscriptionRenewal,
  type NativeLifecycleNotice } from "@openlup/platform/subscriptions";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { capturedPaidHandler } from "./m19NoticeFixture.js";
import { assertJourneyRuntime, assertJourneyWithoutIntake, captureStoreJourney, composeJourneyRenewal, journeyCensus,
  journeyRpc, journeySelection, prepareJourneyRenewal, storeJourneyResources } from "../helpers/storeJourney.js";
import { postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const resources = storeJourneyResources();
afterAll(() => resources.close(), postgresTeardownTimeoutMs);
const at = "2026-09-29T12:01:00.654321Z", expires = "2027-09-29T12:01:00.654321Z";

it("dispatches transferred paid and failed-renewal notices once through durable captured delivery", async () => {
  const source = await resources.installation("notices-source"), target = await resources.installation("notices-target");
  await assertJourneyWithoutIntake(target);
  const pristine = await captureStoreJourney(target.owner, "notices-pristine"), purchase = await prepareJourneyRenewal(source);
  const composition = await composeJourneyRenewal(source, purchase.subscriptionId, "declined", at);
  const refusal = await runOneAutomaticSubscriptionRenewal(composition.input, composition.due, at);
  expect(refusal).toMatchObject({ status: "refused", reason: "sandbox_declined", replayed: false });
  expect(composition.executions()).toBe(1);
  const retry = (await createPostgresRetryStore(source.runtime).read(refusal.operationId))!;
  expect(retry).toMatchObject({ state: "waiting", caseId: expect.any(String) });
  const token = "synthetic-journey-recovery-token", tokenHash = createHash("sha256").update(token).digest("hex");
  const issued = await journeyRpc<{ issued: boolean; orderId: string }>(source.runtime, "dunning_lifecycle_issue_recovery_token",
    [retry.caseId, tokenHash, expires]);
  expect(issued).toEqual({ issued: true, orderId: expect.any(String) });
  const recovery = (await source.runtime.query("SELECT id,order_id,client_id,token_hash FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1", [tokenHash])).rows[0];
  expect(recovery).toMatchObject({ order_id: issued.orderId, client_id: purchase.clientId, token_hash: tokenHash });
  const notice = (await source.runtime.query("SELECT id,payload,recovery_url_path FROM public.subscription_dunning_notifications WHERE case_id=$1 AND notification_kind='payment_failed'", [retry.caseId])).rows;
  expect(notice).toHaveLength(1);
  expect(notice[0].recovery_url_path).toBe("/recover");
  const before = await journeyCensus(source.owner), packet = await captureStoreJourney(source.owner, "notices-pending");
  expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget: pristine }))
    .toMatchObject({ replayed: false });
  expect(await journeyCensus(target.owner)).toEqual(before);
  const answers: unknown[] = [];
  for (const store of [source, target]) {
    await assertJourneyRuntime(store.runtime);
    const receipts = createPostgresTransactionalDeliveryStore({ connectionString: store.runtimeUrl });
    const captured = createCapturedTransactionalDelivery(), commands: TransactionalDeliveryCommand[] = [];
    const observed: { orderId: string; to: string; total: string | null }[] = [], bound: NativeLifecycleNotice[] = [];
    const delivery = createTransactionalDelivery({ store: receipts, delivery: { async deliver(command) {
      commands.push(command); return captured.deliver(command);
    } } });
    try {
      const paid = capturedPaidHandler(store.runtime, receipts, delivery, observed);
      const rows = (await store.runtime.query("SELECT * FROM public.outbox_events WHERE event_type=$1 AND aggregate_id=$2", [paid.eventType, purchase.orderId])).rows;
      expect(rows).toHaveLength(1);
      expect(await paid.handle(rows[0], new AbortController().signal)).toMatchObject({ kind: "processed" });
      expect(observed).toEqual([{ orderId: purchase.created.orderDraft.orderId, to: "journey-001@example.invalid", total: "1027 XXX" }]);
      const lifecycle = createPostgresLifecycleMessages({ delivery: { send: delivery.send, readReceipt: receipts.readReceipt },
        async withSession(work) { const db = await store.runtime.connect(); try { return await work(db); } finally { db.release(); } },
        async bind(value, recipient) {
          expect(recipient.email).toBe("journey-001@example.invalid");
          expect(value.clientId).toBe(purchase.clientId);
          if (value.source === "dunning") {
            const claimed = (await store.runtime.query("SELECT claim_token,payload FROM public.subscription_dunning_notifications WHERE id=$1 AND status='sending'", [value.id])).rows;
            expect(claimed).toHaveLength(1);
            expect(claimed[0].claim_token).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
            expect(value.payload).toEqual({ ...notice[0].payload, claimToken: claimed[0].claim_token });
            expect(value.payload).toEqual(claimed[0].payload);
            // Lease identity is generated independently by each real dispatch.
            const { claimToken, ...payload } = value.payload;
            expect(claimToken).toBe(claimed[0].claim_token);
            bound.push({ ...value, payload });
          } else bound.push(value);
          return { recipientReference: `client:${value.clientId}`, templateReference: value.templateSlug,
            ...(value.kind === "payment_failed" ? { accessGrantReference: `recovery:${recovery.id}` } : {}) };
        } });
      const first = await lifecycle.run(100);
      expect(first).toMatchObject({ failed: 0, stale: 0, requeued: 0, skipped: 0, busy: 0 });
      const failed = bound.filter(value => value.kind === "payment_failed");
      expect(failed).toEqual([expect.objectContaining({ id: notice[0].id, source: "dunning", payload: notice[0].payload,
        recoveryUrlPath: "/recover", templateSlug: "subscription-payment-failed-1" })]);
      expect(commands.filter(command => command.idempotencyKey === `subscription-notice:dunning:${notice[0].id}`)).toHaveLength(1);
      const saved = await Promise.all(commands.map(command => receipts.readReceipt(command.idempotencyKey)));
      expect(saved).toHaveLength(first.sent + 1);
      for (const receipt of saved) expect(receipt).toMatchObject({ state: "accepted", attemptCount: 1 });
      const after = await journeyCensus(store.owner), count = commands.length;
      expect(after.transactional_delivery_receipts).toHaveLength(count);
      expect((await store.runtime.query("SELECT status FROM public.subscription_dunning_notifications WHERE id=$1", [notice[0].id])).rows)
        .toEqual([{ status: "sent" }]);
      expect(await paid.handle(rows[0], new AbortController().signal)).toMatchObject({ kind: "processed", detail: { dedupe: "email_already_sent" } });
      expect(await lifecycle.run(100)).toEqual({ sent: 0, replayed: 0, requeued: 0, failed: 0, skipped: 0, busy: 0, stale: 0 });
      expect(commands).toHaveLength(count);
      expect(observed).toHaveLength(1);
      expect(await Promise.all(commands.map(command => receipts.readReceipt(command.idempotencyKey)))).toEqual(saved);
      expect(await journeyCensus(store.owner)).toEqual(after);
      const content = JSON.stringify({ commands, observed, bound });
      expect(content).not.toContain(token); expect(content).not.toContain(tokenHash);
      answers.push({ commands, observed, bound, saved, first });
    } finally { await receipts.close(); }
  }
  expect(answers[1]).toEqual(answers[0]);
// The joined renewal case measured under 11 s; 90 s leaves headroom for notice dispatch and two installations.
}, 90_000);
