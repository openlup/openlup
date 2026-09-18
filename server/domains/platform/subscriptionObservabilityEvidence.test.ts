import { describe, expect, it } from "vitest";
import { summarizeSubscriptionEvidence } from "./subscriptionObservabilityEvidence.js";

const now = new Date("2026-07-03T12:00:00.000Z");

describe("summarizeSubscriptionEvidence", () => {
  it("surfaces stale paid subscription-cycle orders without fulfillment", () => {
    const snapshot = summarizeSubscriptionEvidence(
      [{ id: "sub_1", status: "active", next_cycle_at: "2026-07-04T11:00:00.000Z", template_version: 4 }],
      [{
        id: "cycle_1",
        subscription_id: "sub_1",
        status: "paid",
        order_id: "order_1",
        scheduled_at: "2026-07-03T10:30:00.000Z",
        template_version: 3,
      }],
      [],
      [{
        id: "order_1",
        mode: "subscription_cycle",
        status: "paid",
        subscription_id: "sub_1",
        subscription_cycle_id: "cycle_1",
        updated_at: "2026-07-03T10:45:00.000Z",
        metadata: { lines: [{ quantity: 2 }, { quantity: 1 }] },
      }],
      [],
      now,
      [{
        order_id: "order_1",
        subscription_id: "sub_1",
        subscription_cycle_id: "cycle_1",
        target_kind: "subscription_cycle",
        status: "succeeded",
        updated_at: "2026-07-03T10:46:00.000Z",
      }],
      [{
        id: "outbox_1",
        event_type: "commerce.order.paid",
        aggregate_id: "order_1",
        status: "failed",
        available_at: "2026-07-03T10:46:00.000Z",
        created_at: "2026-07-03T10:46:00.000Z",
      }],
    );

    expect(snapshot.dueCycleWithoutOrderCount).toBe(0);
    expect(snapshot.paidRenewalWithoutFulfillmentCount).toBe(1);
    expect(snapshot.evidence).toEqual([{
      kind: "paid_renewal_without_fulfillment",
      subscriptionId: "sub_1",
      subscriptionCycleId: "cycle_1",
      orderId: "order_1",
      reason: "paid_subscription_cycle_order_without_fulfillment_order",
      ageSeconds: 4500,
      owner: "commerce/fulfillment",
      customerSafeStatus: "paid_fulfillment_pending",
      operatorNextAction: "inspect_fulfillment_dispatch",
      observedAt: now.toISOString(),
      triageContext: {
        localPaymentStatus: "succeeded",
        subscriptionCycleStatus: "paid",
        orderStatus: "paid",
        outboxStatus: "failed",
        outboxAvailableAt: "2026-07-03T10:46:00.000Z",
        outboxAttempts: null,
        fulfillmentEligibilityReason: "order_paid_outbox_failed_retrying",
        fulfillmentRecoveryPosture: "wait_for_outbox",
        lockedCycleSummary: {
          status: "paid",
          scheduledAt: "2026-07-03T10:30:00.000Z",
          nextCycleAt: null,
          templateVersion: 3,
          lineCount: 2,
          totalQuantity: 3,
        },
        futureTemplateSummary: {
          status: "active",
          scheduledAt: null,
          nextCycleAt: "2026-07-04T11:00:00.000Z",
          templateVersion: 4,
          lineCount: null,
          totalQuantity: null,
        },
      },
    }]);
  });

  it("surfaces exact due-cycle rows and keeps provider-paid local-unpaid orders out of fulfillment triage", () => {
    const snapshot = summarizeSubscriptionEvidence(
      [{ id: "sub_due", status: "active", next_cycle_at: "2026-07-03T11:00:00.000Z", template_version: 2 }],
      [],
      [],
      [{
        id: "order_provider_paid_local_unpaid",
        mode: "subscription_cycle",
        status: "paid",
        subscription_id: "sub_provider",
        subscription_cycle_id: "cycle_provider",
        updated_at: "2026-07-03T10:00:00.000Z",
      }],
      [],
      now,
      [{
        order_id: "order_provider_paid_local_unpaid",
        status: "processing",
        updated_at: "2026-07-03T10:01:00.000Z",
      }],
      [],
    );

    expect(snapshot.dueCycleWithoutOrderCount).toBe(1);
    expect(snapshot.paidRenewalWithoutFulfillmentCount).toBe(0);
    expect(snapshot.evidence).toEqual([expect.objectContaining({
      kind: "due_cycle_without_order",
      subscriptionId: "sub_due",
      nextCycleAt: "2026-07-03T11:00:00.000Z",
      triageContext: expect.objectContaining({
        fulfillmentEligibilityReason: "cycle_order_missing",
        fulfillmentRecoveryPosture: "not_retryable",
      }),
    })]);
  });

  // The shape the collector used to miss entirely. The paid activation cycle is
  // older than the current due date and always "has progress", so the previous
  // any-cycle test dropped every subscription that ever paid cycle 1 - which is
  // every renewing subscription there is.
  it("surfaces a due subscription whose only cycle predates its due date", () => {
    const snapshot = summarizeSubscriptionEvidence(
      [{ id: "sub_due", status: "active", next_cycle_at: "2026-07-03T11:00:00.000Z" }],
      [{
        id: "cycle_activation",
        subscription_id: "sub_due",
        status: "paid",
        order_id: "order_activation",
        scheduled_at: "2026-06-03T11:00:00.000Z",
      }],
      [], [], [], now,
    );

    expect(snapshot.dueCycleWithoutOrderCount).toBe(1);
    expect(snapshot.evidence).toEqual([expect.objectContaining({
      kind: "due_cycle_without_order",
      subscriptionId: "sub_due",
    })]);
  });

  // The complement: once a cycle exists FOR the due date the charge was tried,
  // and dunning or the retry ladder owns the outcome - in any status the port
  // reads, including the ones that never reach an order.
  it("stops surfacing a due subscription once a cycle for the due date exists", () => {
    for (const status of ["payment_pending", "payment_failed", "retry_scheduled", "paid"]) {
      const snapshot = summarizeSubscriptionEvidence(
        [{ id: "sub_due", status: "active", next_cycle_at: "2026-07-03T11:00:00.000Z" }],
        [
          { id: "cycle_activation", subscription_id: "sub_due", status: "paid", order_id: "order_activation", scheduled_at: "2026-06-03T11:00:00.000Z" },
          { id: "cycle_due", subscription_id: "sub_due", status, scheduled_at: "2026-07-03T11:00:00.000Z" },
        ],
        [], [], [], now,
      );

      expect(snapshot.dueCycleWithoutOrderCount, status).toBe(0);
      expect(snapshot.dueCycleUnattemptedCount, status).toBe(0);
    }
  });

  // The pageable escalation. It is a strict subset of the p1 above: same rows,
  // minus seeded fixtures, minus the first 6h that belong to the renewal lane's
  // own cadence and retries.
  it("escalates only real subscriptions unattempted for more than six hours", () => {
    const snapshot = summarizeSubscriptionEvidence(
      [
        { id: "sub_fixture", status: "active", next_cycle_at: "2026-07-01T12:00:00.000Z", is_test_fixture: true },
        { id: "sub_fresh", status: "active", next_cycle_at: "2026-07-03T07:00:00.000Z" },
        { id: "sub_overdue", status: "active", next_cycle_at: "2026-07-03T05:00:00.000Z" },
        { id: "sub_oldest", status: "active", next_cycle_at: "2026-07-02T12:00:00.000Z", is_test_fixture: false },
      ],
      [], [], [], [], now,
    );

    // Every one of the four is still counted by the panel-level p1.
    expect(snapshot.dueCycleWithoutOrderCount).toBe(4);
    expect(snapshot.dueCycleUnattemptedCount).toBe(2);
    // Oldest first, so the page names the likeliest root cause.
    expect(snapshot.dueCycleUnattemptedEvidence).toEqual([
      { subscriptionId: "sub_oldest", nextCycleAt: "2026-07-02T12:00:00.000Z", ageSeconds: 86400 },
      { subscriptionId: "sub_overdue", nextCycleAt: "2026-07-03T05:00:00.000Z", ageSeconds: 25200 },
    ]);
  });

  // The second half of the same disease, and the shape production actually has:
  // the paid ACTIVATION order is itself `mode: "subscription_cycle"` with the
  // subscription id set (checkoutContracts.ts:22-24, and the join in migration
  // 20260722120000), so an all-time "has any subscription-cycle order" test
  // filtered out every subscription that ever activated. Renewal-due-ness is
  // keyed on the due date alone.
  it("surfaces a due subscription whose paid activation order and cycle both predate its due date", () => {
    const snapshot = summarizeSubscriptionEvidence(
      [{ id: "sub_activated", status: "active", next_cycle_at: "2026-07-02T12:00:00.000Z" }],
      [{
        id: "cycle_1",
        subscription_id: "sub_activated",
        status: "paid",
        order_id: "order_activation",
        scheduled_at: "2026-06-02T12:00:00.000Z",
      }],
      [],
      [{
        id: "order_activation",
        mode: "subscription_cycle",
        status: "paid",
        subscription_id: "sub_activated",
        subscription_cycle_id: "cycle_1",
        updated_at: "2026-06-02T12:05:00.000Z",
      }],
      [], now,
    );

    expect(snapshot.dueCycleWithoutOrderCount).toBe(1);
    expect(snapshot.dueCycleUnattemptedCount).toBe(1);
    expect(snapshot.dueCycleUnattemptedEvidence).toEqual([
      { subscriptionId: "sub_activated", nextCycleAt: "2026-07-02T12:00:00.000Z", ageSeconds: 86400 },
    ]);
  });

  it("does not surface fresh, non-renewal, or already fulfillment-backed orders", () => {
    const snapshot = summarizeSubscriptionEvidence(
      [{ id: "sub_1", next_cycle_at: "2026-07-04T12:00:00.000Z" }],
      [],
      [{ subscription_id: "sub_1", event_type: "subscription.delivery_reminder_queued" }],
      [
        {
          id: "order_fresh",
          mode: "subscription_cycle",
          status: "paid",
          subscription_id: "sub_1",
          subscription_cycle_id: "cycle_fresh",
          updated_at: "2026-07-03T11:45:00.000Z",
        },
        {
          id: "order_checkout",
          mode: "checkout",
          status: "paid",
          subscription_id: "sub_1",
          subscription_cycle_id: "cycle_checkout",
          updated_at: "2026-07-03T10:00:00.000Z",
        },
        {
          id: "order_fulfilled",
          mode: "subscription_cycle",
          status: "fulfillment_pending",
          subscription_id: "sub_1",
          subscription_cycle_id: "cycle_fulfilled",
          updated_at: "2026-07-03T10:00:00.000Z",
        },
      ],
      [{ id: "ful_1", order_id: "order_fulfilled", status: "created" }],
      now,
    );

    expect(snapshot.dueCycleWithoutOrderCount).toBe(0);
    expect(snapshot.upcomingDeliveryReminderMissingCount).toBe(0);
    expect(snapshot.paidRenewalWithoutFulfillmentCount).toBe(0);
    expect(snapshot.evidence).toEqual([]);
  });

  it("counts active subscriptions without a chargeable payment_method_ref (mandate early warning)", () => {
    const snapshot = summarizeSubscriptionEvidence(
      [
        // has a chargeable subscription-scoped ref → not counted
        { id: "sub_ok", status: "active", client_id: "client_1", next_cycle_at: "2026-08-01T10:00:00.000Z" },
        // ref exists but belongs to ANOTHER client → counted (due-RPC rejects it)
        { id: "sub_cross", status: "active", client_id: "client_1", next_cycle_at: "2026-08-01T10:00:00.000Z" },
        // ref exists but inactive → counted
        { id: "sub_inactive_ref", status: "active", client_id: "client_2", next_cycle_at: "2026-08-01T10:00:00.000Z" },
        // no ref at all → counted
        { id: "sub_none", status: "active", client_id: "client_3", next_cycle_at: "2026-08-01T10:00:00.000Z" },
      ],
      [],
      [],
      [],
      [],
      now,
      [],
      [],
      [
        { subscription_id: "sub_ok", client_id: "client_1", status: "active", active: true },
        { subscription_id: "sub_cross", client_id: "client_OTHER", status: "active", active: true },
        { subscription_id: "sub_inactive_ref", client_id: "client_2", status: "active", active: false },
      ],
    );

    expect(snapshot.activeWithoutPaymentMethodCount).toBe(3);
  });

  it("reports zero mandate gaps when refs are omitted and there are no subscriptions", () => {
    const snapshot = summarizeSubscriptionEvidence([], [], [], [], [], now);
    expect(snapshot.activeWithoutPaymentMethodCount).toBe(0);
  });

  // A quarantined cycle is the one renewal failure that produces NO other
  // evidence: while its window is open the row raises no run-ledger error and
  // sends the customer nothing. Counting only LIVE windows is the point — an
  // elapsed one is already back in the lane and needs no operator.
  it("counts only cycles whose renewal quarantine window is still open", () => {
    const snapshot = summarizeSubscriptionEvidence(
      [],
      [
        { subscription_id: "sub_live", status: "retry_scheduled", renewal_quarantined_until: new Date(now.getTime() + 60_000).toISOString() },
        { subscription_id: "sub_live_2", status: "payment_pending", renewal_quarantined_until: new Date(now.getTime() + 6 * 60 * 60_000).toISOString() },
        { subscription_id: "sub_elapsed", status: "retry_scheduled", renewal_quarantined_until: new Date(now.getTime() - 1_000).toISOString() },
        { subscription_id: "sub_never", status: "retry_scheduled", renewal_quarantined_until: null },
        { subscription_id: "sub_absent", status: "paid" },
        { subscription_id: "sub_garbage", status: "retry_scheduled", renewal_quarantined_until: "not-a-timestamp" },
      ],
      [], [], [], now,
    );

    expect(snapshot.renewalRowQuarantinedCount).toBe(2);
  });

  it("reports no quarantine when there are no cycles at all", () => {
    expect(summarizeSubscriptionEvidence([], [], [], [], [], now).renewalRowQuarantinedCount).toBe(0);
  });

  it("suppresses intentionally protected renewals and counts only protection overdue by 24h", () => {
    const snapshot = summarizeSubscriptionEvidence(
      [
        { id: "sub_protected", next_cycle_at: "2026-07-03T10:00:00.000Z" },
        { id: "sub_unprotected", next_cycle_at: "2026-07-03T10:00:00.000Z" },
      ],
      [], [], [], [], now, [], [], [],
      [
        { subscription_id: "sub_protected", state: "protected", observed_next_cycle_at: "2026-07-02T11:59:59.000Z" },
        { subscription_id: "sub_protected", state: "manual_review", observed_next_cycle_at: "2026-07-01T12:00:00.000Z" },
        { subscription_id: "sub_fresh", state: "protected", observed_next_cycle_at: "2026-07-03T11:00:00.000Z" },
        { subscription_id: "sub_closed", state: "aligned", observed_next_cycle_at: "2026-07-01T12:00:00.000Z" },
      ],
    );

    expect(snapshot.dueCycleWithoutOrderCount).toBe(1);
    expect(snapshot.evidence).toEqual([expect.objectContaining({ subscriptionId: "sub_unprotected" })]);
    expect(snapshot.deliveryAlignmentOverdueCount).toBe(1);
    expect(snapshot.deliveryAlignmentOverdueEvidence).toEqual([{
      subscriptionId: "sub_protected",
      nextCycleAt: "2026-07-01T12:00:00.000Z",
      ageSeconds: 172800,
    }]);
  });

  // Open-case suppression is an allowlist of the two blocking states, so a state
  // this summary has never heard of - the shape any future terminal case closure
  // takes - is neither paged for nor allowed to suppress the ordinary
  // due-without-order evidence for its subscription. Both halves matter: a
  // terminal case that still suppressed would hide a real stuck renewal.
  it("neither pages for nor suppresses a ledger state it does not recognise", () => {
    const snapshot = summarizeSubscriptionEvidence(
      [{ id: "sub_closed", next_cycle_at: "2026-07-03T10:00:00.000Z" }],
      [], [], [], [], now, [], [], [],
      [{ subscription_id: "sub_closed", state: "closed_undeliverable", observed_next_cycle_at: "2026-07-01T12:00:00.000Z" }],
    );

    expect(snapshot.deliveryAlignmentOverdueCount).toBe(0);
    expect(snapshot.dueCycleWithoutOrderCount).toBe(1);
  });
});
