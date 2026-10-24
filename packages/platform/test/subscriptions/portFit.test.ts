import { expect, it } from "vitest";
import { NATIVE_SUBSCRIPTION_CAPABILITIES, renewalIdentity } from "../../src/subscriptions/index.js";
import type { RenewalAdmission, RenewalResult, RenewalFrozenSnapshot, RenewalPaymentEvidence,
  RenewalTransactionUnits, RenewalRetryState, RenewalRecoveryAuthorization, RenewalCycleCorrelation,
  SubscriptionCommand, SubscriptionCommandReceipt, StockWaitCase, StockWaitStorePort,
  SubscriptionLifecycleMessageDescriptor } from "../../src/subscriptions/contracts/index.js";
const schedule = { subscriptionId: "s", scheduledAt: "2026-10-21T12:00:00Z", scheduledInstant: Date.parse("2026-10-21T12:00:00Z") };
const cycle = { status: "correlated", logicalCycleNumber: 2, nativeRenewalCounter: 1, activationCycleId: "activation", evidenceRef: "cycle-fact" } as const satisfies RenewalCycleCorrelation;
const snapshot: RenewalFrozenSnapshot = { ...schedule, contractVersion: "platform.subscription.renewal.v1", clientId: "client",
  frozenRevision: "revision-1", frozenFingerprint: "original-fingerprint", cycle, retryAttempt: 1, externalAttemptSequence: 2,
  templateSnapshot: { templateId: "template", version: 1, cadenceDays: 28, lines: [{ lineOrdinal: 1, sku: "sku", quantity: 1, unitAmountMinor: 900 }] },
  pricingSnapshot: { currency: "XXX", totalAmountMinor: 900, shippingAmountMinor: 0, agreementPolicy: "lock_until_edit", proration: "none" },
  orderSnapshot: { shippingAddressRef: null, shippingQuoteRef: null, acquisitionRef: null, lines: [{ lineOrdinal: 1, sku: "sku", quantity: 1, unitAmountMinor: 900 }] },
  stockSourceKey: "stock", settlementChannelKey: "channel", authorizationRef: "authorization", payerAccountRef: null, unattendedChargeAuthorizedAt: schedule.scheduledAt };
it("H1: durable deferral remains separate from terminal refusal", () => {
  const admission: RenewalAdmission = { allowed: false, deferred: true, state: "protected", reason: "arrival_outstanding", caseRef: "case" };
  const result: RenewalResult = { outcome: "deferred", ...schedule, reason: admission.reason, caseRef: admission.caseRef };
  expect(result).toMatchObject({ outcome: "deferred", scheduledAt: schedule.scheduledAt, caseRef: "case" });
});
it("H2: frozen snapshot retains text, instant, revision and complete nested carriers", () => {
  expect(snapshot.scheduledAt).toBe("2026-10-21T12:00:00Z");
  expect(snapshot.frozenFingerprint).toBe("original-fingerprint");
  expect(snapshot.orderSnapshot.lines).toEqual(snapshot.templateSnapshot.lines);
  expect(snapshot.pricingSnapshot.proration).toBe("none");
});
it("H3: identity policy retains every original key value", () => {
  const identity = { cycleIdempotencyKey: "cycle:old", executionIdempotencyKey: "execute:old", externalIdempotencyKey: "external:old", requestFingerprint: "fingerprint:old" };
  expect(renewalIdentity(schedule, () => identity)).toBe(identity);
});
it("H4: ambiguous and late-positive evidence retain nullable money and both clocks", () => {
  const evidence = { status: "unknown", disposition: "ambiguous", operationId: "operation", eventKey: "event", requestFingerprint: "fingerprint", verifiedEvidenceRef: "M07-fact", externalAttemptRef: null,
    occurredAt: null, observedAt: schedule.scheduledAt, firstRecordedAt: "2026-10-22T12:00:00Z", amountMinor: null, currency: null, reason: null } as const satisfies RenewalPaymentEvidence;
  const late: RenewalPaymentEvidence = { ...evidence, status: "succeeded", disposition: "late_positive", amountMinor: 900, currency: "XXX" };
  expect(late.eventKey).toBe(evidence.eventKey); expect(evidence.amountMinor).toBeNull(); expect(late.firstRecordedAt).not.toBe(late.observedAt);
});
it("H5: graph transaction units do not pretend external execution is atomic SQL", () => {
  const native: RenewalTransactionUnits = { graph: "native", prepare: "cycle_order_items_settlement_reservation_attempt", outcome: "settlement_outcome_schedule_counter_reservation", recovery: "settlement_cycle_receipt_case_counter" };
  const managed: RenewalTransactionUnits = { graph: "managed", prepare: "create_cycle_order_then_prepare_attempt", failure: "record_attempt_then_apply_result_then_open_case", recovery: "authorize_method_then_schedule" };
  expect(native.graph).not.toBe(managed.graph); expect(native.prepare).not.toBe(managed.prepare);
});
it("H6: persisted null retry is intentional and authorization binds method plus rung", () => {
  const retry: RenewalRetryState = { rowPresent: true, retryAttempt: 4, nextRetryAt: null };
  const authorization: RenewalRecoveryAuthorization = { tokenId: "token", tokenHash: "hash", caseId: "case", clientId: "client", authUserId: null, subscriptionId: "s", cycleId: "cycle", orderId: "order", payerAccountRef: null,
    purpose: "repair_payment", retryAttempt: 4, paymentMethodRef: "method", paymentMethodKind: "card", expiresAt: "2026-10-23T12:00:00Z", usedAt: null, revokedAt: null, requestedAt: schedule.scheduledAt };
  expect(retry.nextRetryAt).toBeNull(); expect(authorization.retryAttempt).toBe(retry.retryAttempt);
  expect(NATIVE_SUBSCRIPTION_CAPABILITIES.retryRecovery).toBe("selected");
});
it("H7: ambiguous activation correlation never fabricates a logical number", () => {
  const ambiguous: RenewalCycleCorrelation = { status: "ambiguous", logicalCycleNumber: null, nativeRenewalCounter: 8, activationCycleId: null, reason: "legacy_correlation_missing" };
  expect(ambiguous.logicalCycleNumber).toBeNull(); expect(cycle.logicalCycleNumber).not.toBe(cycle.nativeRenewalCounter);
});
it("H8: actor and actual command fingerprint bind receipts; native parity is refused", () => {
  const command: SubscriptionCommand = { actor: { kind: "customer", actorId: "actor", clientId: "client" }, subscriptionId: "s", idempotencyKey: "command-key", now: schedule.scheduledAt, action: "slide", newNextCycleAt: "2026-11-01T12:00:00Z", confirmedChargeTiming: true };
  const receipt: SubscriptionCommandReceipt = { actorId: command.actor.actorId, idempotencyKey: command.idempotencyKey, commandFingerprint: "actual-command-hash", outcome: "applied", subscriptionId: "s", originalState: "active", nextCycleAt: command.newNextCycleAt, revision: "revision", eventId: "event" };
  expect(receipt.actorId).toBe("actor"); expect(NATIVE_SUBSCRIPTION_CAPABILITIES.commandBoundReceipts.supported).toBe(false);
});
it("H9: stock case retains frozen binding, deficits, timestamps and immutable notice keys", () => {
  const wait: StockWaitCase = { ...schedule, caseId: "case", clientId: "client", state: "waiting", frozenSnapshot: snapshot, frozenFingerprint: snapshot.frozenFingerprint,
    binding: { caseId: "case", cycleId: null, orderId: null, paymentId: null, engineIdempotencyKey: null }, deficits: [{ skuId: "sku-id", sku: "sku", displayName: "Item", size: null, required: 2, reserved: 0, available: 1, missing: 1 }],
    fulfillmentRef: null, blockReason: "inventory_unavailable", openedAt: schedule.scheduledAt, checkedAt: null, selectedAt: null, securedAt: null, resumedAt: null, closedAt: null, startedNoticeKey: "case:started", resumedNoticeKey: "case:resumed", noticeEligible: true };
  expect(wait.binding.cycleId).toBeNull(); expect(wait.deficits[0].missing).toBe(1); expect(wait.frozenSnapshot).toBe(snapshot);
});
it("H10: stock recovery has a typed refusal for external ownership", async () => {
  const recover: StockWaitStorePort["recoverRefusedSchedule"] = async () => ({ outcome: "refused", reason: "external_ownership" });
  expect(await recover({ operationId: "operation", caseId: "case", claimGeneration: 2, frozenFingerprint: "frozen", scheduledAt: schedule.scheduledAt, now: schedule.scheduledAt })).toEqual({ outcome: "refused", reason: "external_ownership" });
});
it("H11: selected native composition requires admission with one default-off executor", () => {
  expect(NATIVE_SUBSCRIPTION_CAPABILITIES).toMatchObject({ deliveryAdmission: "required", executorCount: 1, defaultEnabled: false });
});
it("H12: lifecycle facts bind M04 descriptors and prepaid/native commands refuse explicitly", () => {
  const descriptor: SubscriptionLifecycleMessageDescriptor = { fact: { factId: "fact", idempotencyKey: "fact-key", subscriptionId: "s", clientId: "client", cycleId: null, caseId: "case", orderId: null,
    occurredAt: schedule.scheduledAt, firstRecordedAt: schedule.scheduledAt, kind: "payment_expired", retryAttempt: 4, nextRetryAt: null, failureClass: "temporary", amountMinor: null, currency: null }, messageKey: "M04:fact", templateSlug: "host-copy", recipientRef: "recipient", locale: "en", recoveryUrlPath: "/recovery" };
  expect(descriptor.fact.kind).toBe("payment_expired");
  expect(NATIVE_SUBSCRIPTION_CAPABILITIES.multiCyclePrepaid.refusalCode).toBe("multi_cycle_prepaid_unsupported");
  expect(NATIVE_SUBSCRIPTION_CAPABILITIES.genericBundleCommands.refusalCode).toBe("native_generic_bundle_commands_unsupported");
});
