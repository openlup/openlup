import { describe, expect, it } from "vitest";
// Aliased on import: the factory name is the deployment's backend vendor, and
// naming it once at the seam keeps the neutrality ratchet flat while every
// call site below reads as the port it builds.
import { createSupabaseObservabilityEvidencePort as createEvidencePort } from "./observabilityEvidencePort.js";
import { DUNNING_CASE_COLUMNS } from "./dunningObservabilityEvidence.js";

describe("supabase observability evidence port", () => {
  it("maps database rows into a vendor-neutral watchdog snapshot", async () => {
    const queriedTables: string[] = [];
    const port = createEvidencePort(fakeClient({
      platform_job_controls: [{
        job_name: "subscription-dunning-dispatch",
        enabled: true,
        last_success_at: "2026-06-06T09:55:00.000Z",
        last_status: "success",
      }],
      platform_job_runs: [
        {
          job_name: "omnipack-reconciliation",
          status: "success",
          started_at: "2026-06-06T09:57:00.000Z",
          metadata: { stateConflicts: 2 },
        },
        {
          job_name: "subscription-dunning-dispatch",
          status: "success",
          started_at: "2026-06-06T09:55:00.000Z",
        },
      ],
      subscription_dunning_notifications: [
        {
          id: "notice-1",
          case_id: "case-1",
          status: "queued",
          recipient_kind: "customer",
          scheduled_at: "2026-06-06T09:30:00.000Z",
          created_at: "2026-06-06T09:30:00.000Z",
        },
        {
          id: "notice-2",
          case_id: "case-1",
          status: "failed",
          recipient_kind: "admin",
          template_slug: "subscription-payment-failed-admin",
          created_at: "2026-06-06T09:31:00.000Z",
        },
      ],
      subscription_dunning_cases: [{
        id: "case-1",
        status: "open",
        retry_attempt: 1,
        next_retry_at: "2026-06-06T09:45:00.000Z",
      }],
      outbox_events: [
        {
          id: "outbox-1",
          event_type: "commerce.order_draft.created",
          status: "pending",
          available_at: "2026-06-06T09:20:00.000Z",
          created_at: "2026-06-06T09:00:00.000Z",
        },
        {
          id: "outbox-2",
          event_type: "commerce.order.paid.email",
          status: "failed",
          available_at: "2026-06-06T09:40:00.000Z",
          created_at: "2026-06-06T09:10:00.000Z",
        },
        {
          id: "outbox-3",
          event_type: "commerce.order.paid",
          aggregate_type: "commerce_order",
          aggregate_id: "subscription-paid-no-fulfillment",
          status: "processed",
          available_at: "2026-06-06T09:21:00.000Z",
          created_at: "2026-06-06T09:21:00.000Z",
          processed_at: "2026-06-06T09:22:00.000Z",
        },
        {
          id: "outbox-dormant",
          event_type: "commerce.payment_attempt.requested",
          status: "pending",
          available_at: "2026-06-01T00:00:00.000Z",
          created_at: "2026-06-01T00:00:00.000Z",
        },
        {
          id: "outbox-dormant-prefix",
          event_type: "commerce.return.requested",
          status: "failed",
          available_at: "2026-06-01T00:00:00.000Z",
          created_at: "2026-06-01T00:00:00.000Z",
        },
      ],
      notification_recipients: [{ notification_type: "commerce_payment_critical", active: true }],
      email_sends: [
        { status: "failed", source: "subscription-dunning-dispatch", sent_at: "2026-06-06T09:50:00.000Z", created_at: "2026-06-06T09:50:00.000Z" },
        { id: "send-positive", status: "sent", source: "outbox-dispatch", template_slug: "commerce-order-paid", sent_at: "2026-06-06T09:45:00.000Z", created_at: "2026-06-06T09:45:00.000Z" },
      ],
      communication_email_deliveries: [{
        id: "delivery-positive",
        status: "delivered",
        purpose: "transactional",
        template_slug: "commerce-order-paid",
        recipient_fingerprint: "a".repeat(64),
        aggregate_type: "commerce_order",
        aggregate_id: "order-positive",
        email_send_id: "send-positive",
        sent_at: "2026-06-06T09:45:00.000Z",
        delivered_at: "2026-06-06T09:46:00.000Z",
        updated_at: "2026-06-06T09:46:00.000Z",
      }],
      subscriptions: [
        { id: "sub-1", status: "active", client_id: "client-1", next_cycle_at: "2026-06-06T09:00:00.000Z" },
      ],
      // Exact paid Tpay Model O gap, not an unpaid pending checkout ghost.
      subscription_paid_activation_gaps: [{
        subscription_id: "sub-paid-gap",
        paid_at: "2026-06-06T05:00:00.000Z",
      }],
      // Standing method health. The third row is the one the port must NOT
      // count: the narrow paid-activation detector already owns it, and the
      // watchdog pages p1 on that population separately.
      subscription_method_health: [
        { subscription_id: "sub-model-m", health_state: "mandate_not_chargeable_unattended", narrow_activation_gap: false },
        { subscription_id: "sub-broad-gap", health_state: "activation_gap", narrow_activation_gap: false },
        { subscription_id: "sub-narrow-gap", health_state: "activation_gap", narrow_activation_gap: true },
      ],
      // Guard-bypass probe: counted head-only, with no time window at all, so
      // a row inserted seconds ago is already evidence.
      subscription_zero_line_active: [{
        subscription_id: "sub-zero-line",
        client_id: "client-1",
        started_at: "2026-06-06T09:59:00.000Z",
        next_cycle_at: "2026-07-06T09:59:00.000Z",
        updated_at: "2026-06-06T09:59:00.000Z",
      }],
      inventory_balances: [
        // drift: balance says 23 reserved, but the only lease on this slot expired 2h ago.
        { sku_id: "sku-drift", location_id: "loc-1", lot_key: null, reserved: 23 },
        // clean: paid/pinned lease (expires_at NULL) matches the balance.
        { sku_id: "sku-clean", location_id: "loc-1", lot_key: null, reserved: 5 },
      ],
      inventory_reservations: [
        // expired checkout hold (leak + drift source).
        { sku_id: "sku-drift", location_id: "loc-1", lot_key: null, status: "reserved", kind: "checkout_payment_window", quantity: 23, expires_at: "2026-06-06T08:00:00.000Z", order_id: "order-leak-1" },
        // expired retry hold (retry leak).
        { sku_id: "sku-retry", location_id: "loc-1", lot_key: null, status: "reserved", kind: "subscription_retry_window", quantity: 7, expires_at: "2026-06-06T08:00:00.000Z", order_id: "order-leak-2" },
        // live pinned hold — must NOT count as leak or drift.
        { sku_id: "sku-clean", location_id: "loc-1", lot_key: null, status: "reserved", kind: "checkout_payment_window", quantity: 5, expires_at: null, order_id: "order-pinned" },
      ],
      // sub-1 has NO chargeable subscription-scoped ref (the inactive row is
      // filtered out by the port query's eq(active,true)/eq(status,'active')).
      commerce_payment_method_refs: [
        { subscription_id: "sub-1", client_id: "client-1", status: "active", active: false },
        { subscription_id: "sub-other", client_id: "client-9", status: "active", active: true },
      ],
      subscription_cycles: [{
        id: "cycle-2",
        subscription_id: "sub-2",
        status: "paid",
        order_id: "subscription-paid-no-fulfillment",
        scheduled_at: "2026-06-06T09:15:00.000Z",
      }],
      subscription_events: [],
      commerce_orders: [{
        id: "subscription-paid-no-fulfillment",
        status: "paid",
        mode: "subscription_cycle",
        subscription_id: "sub-2",
        subscription_cycle_id: "cycle-2",
        updated_at: "2026-06-06T09:20:00.000Z",
        metadata: {},
      }],
      commerce_payment_intents: [
        {
          id: "intent-1",
          status: "processing",
          provider_kind: "stripe",
          amount_cents: 1299,
          currency: "PLN",
        },
        {
          id: "intent-2",
          status: "succeeded",
          provider_kind: "tpay",
          order_id: "subscription-paid-no-fulfillment",
          subscription_id: "sub-2",
          subscription_cycle_id: "cycle-2",
          target_kind: "subscription_cycle",
          amount_cents: 1299,
          currency: "PLN",
        },
      ],
      commerce_payment_attempts: [
        {
          id: "attempt-1",
          payment_intent_id: "intent-1",
          status: "processing",
          provider_kind: "stripe",
          provider_payment_id: "pi_1",
          created_at: "2026-06-06T09:20:00.000Z",
        },
        {
          id: "attempt-2",
          payment_intent_id: "intent-2",
          status: "failed",
          provider_kind: "tpay",
          provider_payment_id: "tpay_2",
          created_at: "2026-06-06T09:50:00.000Z",
        },
      ],
      commerce_payment_reconciliation_runs: [{
        payment_attempt_id: "attempt-1",
        payment_intent_id: "intent-1",
        provider: "stripe",
        provider_payment_id: "pi_1",
        correction_status: "failed",
        checked_at: "2026-06-06T09:45:00.000Z",
        payload: {
          failureReason: "provider_amount_mismatch",
          providerPayload: { client_secret: "must-not-leak" },
        },
      }],
      inbound_provider_events: [
        {
          provider: "stripe",
          provider_kind: "stripe",
          provider_event_id: "evt_paid",
          event_type: "payment.succeeded",
          payment_intent_id: "intent-1",
          payment_attempt_id: "attempt-1",
          provider_payment_id: "pi_1",
          amount_cents: 1299,
          currency: "PLN",
          signature_verified: true,
        },
        {
          provider: "tpay",
          provider_kind: "tpay",
          provider_event_id: "evt_bad_sig",
          event_type: "payment.failed",
          provider_payment_id: "tpay_bad",
          signature_verified: false,
        },
        {
          provider: "omnipack",
          processing_status: "ignored",
          received_at: "2026-06-06T09:30:00.000Z",
        },
        {
          provider: "omnipack",
          processing_status: "ignored",
          received_at: "2026-06-05T09:59:59.000Z",
        },
      ],
      accounting_invoices: [],
      accounting_invoice_issue_outbox: [],
      accounting_invoice_correction_outbox: [],
      commerce_fulfillment_orders: [{
        id: "fulfillment-missing-invoice",
        order_id: "order-missing-invoice",
        status: "handed_over",
        handed_over_at: "2026-06-06T09:00:00.000Z",
      }, {
        id: "fulfillment-failed-dispatch",
        order_id: "order-failed-dispatch",
        status: "created",
        provider_kind: "omnipack",
      }],
      commerce_fulfillment_provider_commands: [
        {
          id: "provider-command-1",
          fulfillment_order_id: "fulfillment-missing-invoice",
          provider_kind: "omnipack",
          command_kind: "dispatch_create",
          status: "uncertain",
          updated_at: "2026-06-06T09:40:00.000Z",
        },
        {
          id: "provider-command-2",
          fulfillment_order_id: "fulfillment-missing-invoice",
          provider_kind: "omnipack",
          command_kind: "dispatch_create",
          status: "submitting",
          claim_expires_at: "2026-06-06T09:59:00.000Z",
          updated_at: "2026-06-06T09:58:00.000Z",
        },
      ],
      omnipack_dispatch_refs: [{
        fulfillment_order_id: "fulfillment-failed-dispatch",
        status: "failed",
        updated_at: "2026-06-06T09:55:00.000Z",
      }],
      omnipack_status_evidence: [{ occurred_at: "2026-06-06T09:00:00.000Z" }],
      omnipack_stock_sync_cursors: [{ status: "succeeded", last_stock_synced_at: "2026-06-06T09:30:00.000Z" }],
      fulfillment_provider_stock_current: [
        { provider_kind: "omnipack", sku: "OPENLUP-BEEF-2KG", inventory_class: "sellable", stale_after: "2026-06-06T12:00:00.000Z" },
        { provider_kind: "omnipack", sku: "UNKNOWN-OMNIPACK-SKU", inventory_class: null, stale_after: "2026-06-06T12:00:00.000Z" },
      ],
      omnipack_stock_snapshots: [{
        sku: "OPENLUP-BEEF-2KG",
        mismatch_kind: "provider_lower",
        snapshot_at: "2026-06-06T09:45:00.000Z",
      }],
      omnipack_low_stock_evidence: [
        { status: "open", threshold_kind: "safety_stock", created_at: "2026-06-06T09:50:00.000Z" },
        { status: "open", threshold_kind: "reservation_coverage", created_at: "2026-06-06T09:50:00.000Z" },
      ],
    }, queriedTables) as never, { COMMERCE_DUNNING_EMAILS_ENABLED: true }, {
      readOpenDeliveryAlignmentCases: async () => [{
        subscription_id: "sub-alignment-overdue",
        state: "manual_review",
        observed_next_cycle_at: "2026-06-05T09:00:00.000Z",
      }],
    });

    const snapshot = await port.collectSnapshot(new Date("2026-06-06T10:00:00.000Z"));

    expect(snapshot.runtimeFlags.COMMERCE_DUNNING_EMAILS_ENABLED).toBe(true);
    expect(snapshot.jobControls[0]).toMatchObject({ jobName: "subscription-dunning-dispatch", lastStatus: "success" });
    expect(snapshot.queues[0]).toMatchObject({
      queueName: "subscription_dunning_notifications",
      queuedCount: 1,
      failedCount: 1,
      criticalFailedCount: 1,
    });
    expect(snapshot.queues.find((queue) => queue.queueName === "outbox_events")).toMatchObject({
      jobName: "outbox-dispatch",
      queuedCount: 2,
      failedCount: 1,
      oldestQueuedAt: "2026-06-06T09:20:00.000Z",
    });
    expect(snapshot.recipients[0]).toMatchObject({ notificationType: "commerce_payment_critical", activeCount: 1 });
    expect(snapshot.dunning.overdueRetryCount).toBe(1);
    expect(snapshot.dunning.failedAdminNotificationCount).toBe(1);
    expect(snapshot.dunning.failureWithoutAdminAlertCount).toBe(0);
    expect(snapshot.emails.criticalFailedCount).toBe(1);
    expect(snapshot.emails.auditIncompleteCount).toBe(1);
    expect(snapshot.emails.maxSendsPerRecipient).toBe(1);
    expect(snapshot.emails.communicationOutboxFailedCount).toBe(1);
    expect(snapshot.subscriptions.dueCycleWithoutOrderCount).toBe(1);
    expect(snapshot.subscriptions.paidRenewalWithoutFulfillmentCount).toBe(1);
    // sub-1's only ref is inactive (filtered by the port query), so the
    // mandate early-warning counts it.
    expect(snapshot.subscriptions.activeWithoutPaymentMethodCount).toBe(1);
    const paidRenewalEvidence = snapshot.subscriptions.evidence?.find((row) => row.kind === "paid_renewal_without_fulfillment");
    expect(paidRenewalEvidence).toMatchObject({
      kind: "paid_renewal_without_fulfillment",
      subscriptionId: "sub-2",
      subscriptionCycleId: "cycle-2",
      orderId: "subscription-paid-no-fulfillment",
      owner: "commerce/fulfillment",
      customerSafeStatus: "paid_fulfillment_pending",
      operatorNextAction: "inspect_fulfillment_dispatch",
      triageContext: expect.objectContaining({
        localPaymentStatus: "succeeded",
        subscriptionCycleStatus: "paid",
        outboxStatus: "processed",
        fulfillmentRecoveryPosture: "manual_review",
      }),
    });
    expect(snapshot.payments.providerPaidLocalUnpaidCount).toBe(1);
    expect(snapshot.payments.localPaidProviderUnpaidCount).toBe(1);
    expect(snapshot.payments.stuckProcessingCount).toBe(0);
    expect(snapshot.payments.amountCurrencyMismatchCount).toBe(1);
    expect(snapshot.payments.signatureFailureCount).toBe(1);
    // intent-2 is `succeeded`: the money landed, so this failed attempt is a
    // retry the customer got through, not an abandoned payment. The fixture
    // used to read 1 only because it fabricated `recovery_required` and
    // `recovery_link_created` — columns no migration creates.
    expect(snapshot.payments.recoveryRequiredWithoutLinkCount).toBe(0);
    expect(JSON.stringify(snapshot.payments.evidence)).not.toContain("pi_1");
    expect(JSON.stringify(snapshot.payments.evidence)).not.toContain("tpay_2");
    expect(JSON.stringify(snapshot.payments.evidence)).not.toContain("must-not-leak");
    expect(snapshot.payments.evidence).toContainEqual(expect.objectContaining({
      kind: "amount_currency_mismatch",
      paymentAttemptId: "attempt-1",
      reason: "provider_amount_mismatch",
    }));
    expect(snapshot.payments.leakedCheckoutReservationCount).toBe(1);
    expect(snapshot.payments.leakedSubscriptionRetryReservationCount).toBe(1);
    expect(snapshot.payments.reservedBalanceDriftCount).toBe(1);
    expect(snapshot.payments.reservedBalanceDriftEvidence).toEqual([
      { skuId: "sku-drift", locationId: "loc-1", lotKey: null, balanceReserved: 23, activeReserved: 0, drift: 23 },
    ]);
    expect(snapshot.subscriptions.pendingActivationOverdueCount).toBe(1);
    expect(queriedTables).toContain("subscription_method_health");
    expect(snapshot.subscriptions.methodHealthUnchargeableCount).toBe(1);
    // 1, not 2: the row the narrow detector already owns is subtracted here, so
    // one root cause cannot reach the pager twice.
    expect(snapshot.subscriptions.methodHealthActivationGapCount).toBe(1);
    expect(queriedTables).toContain("subscription_zero_line_active");
    expect(snapshot.subscriptions.zeroLineActiveCount).toBe(1);
    expect(snapshot.subscriptions.deliveryAlignmentOverdueCount).toBe(1);
    expect(snapshot.accounting.shippedWithoutInvoiceCount).toBe(1);
    expect(snapshot.accounting.missingInvoiceHandoffs[0]).toMatchObject({
      fulfillmentOrderId: "fulfillment-missing-invoice",
      orderId: "order-missing-invoice",
      recoveryAction: "replay_accounting_invoice_issue_request_from_handoff",
    });
    expect(snapshot.omnipack.dispatchFailureCount).toBe(1);
    expect(snapshot.omnipack.actionableShortageEvidenceCount).toBe(1);
    expect(snapshot.omnipack.reservationCoverageCount).toBe(1);
    expect(snapshot.omnipack.unknownStockSkuCount).toBe(1);
    expect(snapshot.omnipack.providerLowerMismatchCount).toBeUndefined();
    expect(snapshot.omnipack.recentQuarantinedInboundCount).toBe(1);
    expect(snapshot.omnipack.reconciliationStateConflictCount).toBe(2);
    expect(snapshot.omnipack).not.toHaveProperty("providerCommandAttentionCount");
    expect(snapshot.omnipack).not.toHaveProperty("providerCommandUncertainCount");
    expect(snapshot.omnipack).not.toHaveProperty("providerCommandStaleSubmittingCount");
    expect(snapshot.omnipack).not.toHaveProperty("providerCommandEvidence");
    expect(queriedTables).not.toContain("commerce_fulfillment_provider_commands");
    expect(JSON.stringify(snapshot.payments.evidence)).not.toContain("client_secret");
    expect(JSON.stringify(snapshot.omnipack.fulfillmentHealthEvidence)).not.toContain("buyer@example.com");
    expect(JSON.stringify(snapshot.omnipack.fulfillmentHealthEvidence)).not.toContain("fingerprint");
  });

  it("scopes the bounded payment-event window before an OmniPack burst can evict PSP evidence", async () => {
    const omnipackBurst = Array.from({ length: 2_000 }, (_, index) => ({
      provider: "omnipack",
      event_type: "order.status_changed",
      received_at: `2026-06-06T09:${String(index % 60).padStart(2, "0")}:00.000Z`,
    }));
    const port = createEvidencePort(fakeClient({
      commerce_payment_intents: [{
        id: "intent-payment-event",
        status: "processing",
        updated_at: "2026-06-06T09:50:00.000Z",
      }],
      commerce_payment_attempts: [{
        id: "attempt-payment-event",
        payment_intent_id: "intent-payment-event",
        status: "processing",
        provider: "stripe",
        provider_attempt_id: "pi_payment_event",
        updated_at: "2026-06-06T09:50:00.000Z",
      }],
      inbound_provider_events: [
        ...omnipackBurst,
        {
          provider: "stripe",
          event_type: "payment.succeeded",
          payment_intent_id: "intent-payment-event",
          payment_attempt_id: "attempt-payment-event",
          provider_payment_id: "pi_payment_event",
          received_at: "2026-06-06T08:00:00.000Z",
        },
      ],
    }) as never, {});

    const snapshot = await port.collectSnapshot(new Date("2026-06-06T10:00:00.000Z"));

    expect(snapshot.payments.providerPaidLocalUnpaidCount).toBe(1);
    expect(snapshot.payments.webhookMissingCount).toBe(0);
  });
  it("keeps the dunning signals whole once the case table outgrows a single 2000-row slice", async () => {
    // Every one of these closed cases would have fitted inside the old blunt
    // `.select("*").limit(2000)` read, pushing the rows that actually matter -
    // the two transitions from the last 24h and the one open overdue case -
    // outside whatever arbitrary 2000 the database felt like returning.
    const closedLongAgo = Array.from({ length: 2_400 }, (_, index) => ({
      id: `case-closed-${index}`,
      status: "expired",
      retry_attempt: 1,
      opened_at: "2026-01-01T00:00:00.000Z",
      expired_at: "2026-01-02T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
    }));
    const port = createEvidencePort(fakeClient({
      subscription_dunning_cases: [
        ...closedLongAgo,
        {
          id: "case-expired-today",
          status: "expired",
          retry_attempt: 1,
          opened_at: "2026-06-04T09:00:00.000Z",
          expired_at: "2026-06-06T09:00:00.000Z",
          updated_at: "2026-06-06T09:00:00.000Z",
        },
        {
          id: "case-recovered-today",
          status: "recovered",
          retry_attempt: 1,
          opened_at: "2026-06-04T09:10:00.000Z",
          recovered_at: "2026-06-06T09:30:00.000Z",
          updated_at: "2026-06-06T09:30:00.000Z",
        },
        {
          id: "case-open-overdue",
          status: "open",
          retry_attempt: 1,
          opened_at: "2026-06-05T09:00:00.000Z",
          next_retry_at: "2026-06-06T09:45:00.000Z",
          updated_at: "2026-06-06T09:45:00.000Z",
        },
        // Closed by a subscription cancellation: terminal, never pruned, and
        // carrying neither expired_at nor recovered_at. It must reach the
        // summarizer (it is an unalerted failure) without moving either 24h
        // counter.
        {
          id: "case-cancelled-today",
          status: "cancelled",
          retry_attempt: 1,
          opened_at: "2026-06-04T09:20:00.000Z",
          updated_at: "2026-06-06T09:40:00.000Z",
        },
      ],
      subscription_dunning_notifications: [
        {
          id: "notice-open-admin",
          case_id: "case-open-overdue",
          status: "queued",
          recipient_kind: "admin",
          scheduled_at: "2026-06-06T09:46:00.000Z",
          created_at: "2026-06-06T09:46:00.000Z",
        },
      ],
    }) as never, {});

    const snapshot = await port.collectSnapshot(new Date("2026-06-06T10:00:00.000Z"));

    expect(snapshot.dunning.expiredCount24h).toBe(1);
    expect(snapshot.dunning.recoveredCount24h).toBe(1);
    expect(snapshot.dunning.overdueRetryCount).toBe(1);
    expect(snapshot.queues[0]).toMatchObject({ queuedCount: 1, oldestQueuedAt: "2026-06-06T09:46:00.000Z" });
    // Retained cases: the 2000 most recently touched closed ones (the three
    // from today plus 1997 of the backlog) and the one open case. Only the open
    // case has an admin notice, so 2000 lack one - the cancelled case among
    // them, exactly as the pre-split all-status read counted it.
    expect(snapshot.dunning.failureWithoutAdminAlertCount).toBe(2_000);
    // ...and it is not counted as an expiry: 1997 backlog expiries plus today's
    // one. A cancelled case leaking into this signal would read 1999.
    expect(snapshot.dunning.expiredWithoutCustomerNoticeCount).toBe(1_998);
  });

  // The predicate is proved in the domain suite; what only the adapter can prove
  // is that `commerce_checkout_recovery_tokens` is actually read and that its
  // `order_id` reaches the detector. Before this wave the detector read two
  // columns no migration creates, so no adapter read existed to prove.
  it.each([
    { label: "with no recovery token", tokens: [] as Array<Record<string, unknown>>, expected: 1 },
    { label: "once the recovery rail issued one", tokens: [{ order_id: "order-abandoned", created_at: "2026-06-06T09:52:00.000Z" }], expected: 0 },
  ])("reads the checkout recovery tokens table $label", async ({ tokens, expected }) => {
    const queriedTables: string[] = [];
    const port = createEvidencePort(fakeClient({
      commerce_payment_intents: [{
        id: "intent-abandoned",
        status: "requires_action",
        target_kind: "one_time_order",
        order_id: "order-abandoned",
      }],
      commerce_payment_attempts: [{
        id: "attempt-abandoned",
        payment_intent_id: "intent-abandoned",
        status: "failed",
        updated_at: "2026-06-06T09:30:00.000Z",
      }],
      commerce_checkout_recovery_tokens: tokens,
    }, queriedTables) as never, {});

    const snapshot = await port.collectSnapshot(new Date("2026-06-06T10:00:00.000Z"));

    expect(queriedTables).toContain("commerce_checkout_recovery_tokens");
    expect(snapshot.payments.recoveryRequiredWithoutLinkCount).toBe(expected);
  });

  // ⛔ The fake client ignores the column list, so no behavioural test here can
  // see a narrowed projection — and a projection that silently drops these two
  // columns would empty the rescue sets and bring back exactly the false p1 on
  // every renewal refusal that this suppressor exists to prevent. Pin the string.
  it("keeps the two columns the recovery detector links dunning cases by", () => {
    expect(DUNNING_CASE_COLUMNS.split(",")).toEqual(expect.arrayContaining([
      "payment_intent_id",
      "cycle_id",
    ]));
  });

  // A renewal refusal never gets a checkout-recovery token; its way back is a
  // dunning case. Only the adapter can prove the case projection carries the two
  // link columns the detector needs — the domain suite is handed them directly.
  it.each([
    { label: "with an open dunning case covering the cycle", cases: [{
      id: "case-1", status: "open", retry_attempt: 1, opened_at: "2026-06-06T09:31:00.000Z",
      payment_intent_id: "intent-renewal", cycle_id: "cycle-renewal",
    }], expected: 0 },
    { label: "with no dunning case at all", cases: [] as Array<Record<string, unknown>>, expected: 1 },
  ])("reads the dunning case as the renewal rail's recovery path $label", async ({ cases, expected }) => {
    const port = createEvidencePort(fakeClient({
      commerce_payment_intents: [{
        id: "intent-renewal",
        status: "requires_action",
        target_kind: "subscription_cycle",
        order_id: "order-renewal",
        subscription_id: "sub-renewal",
        subscription_cycle_id: "cycle-renewal",
      }],
      commerce_payment_attempts: [{
        id: "attempt-renewal",
        payment_intent_id: "intent-renewal",
        status: "failed",
        updated_at: "2026-06-06T09:30:00.000Z",
      }],
      subscription_dunning_cases: cases,
    }) as never, {});

    const snapshot = await port.collectSnapshot(new Date("2026-06-06T10:00:00.000Z"));

    expect(snapshot.payments.recoveryRequiredWithoutLinkCount).toBe(expected);
  });
});

function fakeClient(
  tables: Record<string, Array<Record<string, unknown>>>,
  queriedTables: string[] = [],
) {
  return {
    from(table: string) {
      queriedTables.push(table);
      return query(tables[table] ?? []);
    },
  };
}

function query(rows: Array<Record<string, unknown>>) {
  const filters: Array<(row: Record<string, unknown>) => boolean> = [];
  let orderBy: { column: string; ascending: boolean } | null = null;
  let limitCount: number | null = null;
  let exactCount = false;
  let head = false;

  const builder = {
    select: (_columns?: string, options?: { count?: string; head?: boolean }) => {
      exactCount = options?.count === "exact";
      head = options?.head === true;
      return builder;
    },
    eq: (column: string, value: unknown) => {
      filters.push((row) => row[column] === value);
      return builder;
    },
    gte: (column: string, value: unknown) => {
      filters.push((row) => compare(row[column], value) >= 0);
      return builder;
    },
    in: (column: string, values: unknown[]) => {
      filters.push((row) => values.includes(row[column]));
      return builder;
    },
    limit: (count: number) => {
      limitCount = count;
      return builder;
    },
    lte: (column: string, value: unknown) => {
      // Postgres comparison semantics: NULL never satisfies lte.
      filters.push((row) => row[column] != null && compare(row[column], value) <= 0);
      return builder;
    },
    not: (column: string, operator: string, value: string) => {
      if (operator === "in") {
        const values = value.replace(/^\(|\)$/g, "").split(",").filter(Boolean);
        filters.push((row) => !values.includes(String(row[column] ?? "")));
      } else if (operator === "like") {
        const prefix = value.endsWith("%") ? value.slice(0, -1) : value;
        filters.push((row) => !String(row[column] ?? "").startsWith(prefix));
      }
      return builder;
    },
    order: (column: string, options?: { ascending?: boolean }) => {
      orderBy = { column, ascending: options?.ascending !== false };
      return builder;
    },
    then(resolve: (value: { data: typeof rows | null; error: null; count?: number }) => void) {
      const filtered = rows.filter((row) => filters.every((filter) => filter(row)));
      const ordering = orderBy;
      const sorted = ordering
        ? [...filtered].sort((left, right) => compare(left[ordering.column], right[ordering.column]) * (ordering.ascending ? 1 : -1))
        : filtered;
      const limited = limitCount === null ? sorted : sorted.slice(0, limitCount);
      resolve({ data: head ? null : limited, error: null, ...(exactCount ? { count: filtered.length } : {}) });
    },
  };
  return builder;
}

function compare(left: unknown, right: unknown): number {
  const leftValue = typeof left === "string" || typeof left === "number" ? left : "";
  const rightValue = typeof right === "string" || typeof right === "number" ? right : "";
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
