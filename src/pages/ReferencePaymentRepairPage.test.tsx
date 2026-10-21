import { createCommercePaymentStatusHandler } from "../../server/domains/commerce/commercePaymentStatusHandler.js";
import { createCommercePaymentVerifyHandler } from "@openlup/platform/payments";
import { createBffResponder } from "@openlup/platform/bff";
import { PAYMENT_FAILURE_DISPLAY_HEADER } from "@/domains/commerce/paymentFailureDisplayContracts";
import { PAYMENT_RECOVERY_GUIDANCE_HEADER } from "@/domains/commerce/paymentRecoveryGuidanceContracts";
import { chargeSubscriptionCycleOffSession } from "../../server/domains/subscription/chargeSubscriptionCycleOffSession.js";
// Neutral host policy replaces the donor's private configured rail and currency.
vi.mock("../../src/domains/payment/storedMethodCapabilities.js", () => ({
  storedMethodExpectations: () => ({ requiresCustomerRef: true, requiredMethodKind: null, requiresPayerContact: false }),
  storedMethodCapabilityKinds: ["provider-a"],
}));
vi.mock("../../src/lib/currency/platformCurrency.js", async original => ({
  ...await original<object>(), readSettlementProfile: () => ({ acceptedCurrencies: ["XXX"] }),
}));
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createPaymentRecoverySetupHandler } from "../../server/domains/payment/paymentRecoverySetupHandler.js";
import { createPaymentRecoveryRedeemHandler } from "../../server/domains/subscription/paymentRecoveryHandler.js";
import ReferencePaymentRepairPage from "./ReferencePaymentRepairPage";
vi.mock("@/domains/commerce/commerceClient", () => ({ getCommercePaymentStatus: vi.fn(async () => ({
  status: "processing", payment: { intentStatus: "processing" }, nextAction: null,
})) }));
vi.mock("@/domains/commerce/paymentVerifyClient", () => ({ verifyCommercePaymentNow: vi.fn(async () => ({ status: "pending", verified: true, applied: false })) }));
const CASE = "11111111-1111-4111-8111-111111111111", SUB = "22222222-2222-4222-8222-222222222222";
const CYCLE = "33333333-3333-4333-8333-333333333333", ORDER = "44444444-4444-4444-8444-444444444444";
const AT = "2026-10-21T10:00:00.000Z", TOKEN = "a".repeat(64);
function response() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() }; res.status.mockReturnValue(res); return res;
}
function setup(actor = "owner-original") {
  const recoveryPort = { findTokenEvidenceByHash: vi.fn().mockResolvedValue({ tokenId: "token-original", caseId: CASE,
    clientId: "client-original", authUserId: "owner-original", purpose: "repair_payment", expiresAt: "2099-01-01T00:00:00Z",
    revokedAt: null, usedAt: null }),
    resolveRecoveryCaseSubscription: vi.fn().mockResolvedValue({ caseId: CASE, subscriptionId: SUB, providerCustomerRef: "cus_original" }),
    recordSubscriptionPaymentRecovery: vi.fn().mockResolvedValue({ contractVersion: "subscription.runtime.v1",
      subscriptionPaymentRecovery: { caseId: CASE, subscriptionId: SUB, cycleId: CYCLE, orderId: ORDER,
        purpose: "repair_payment", nextAction: "retry_existing_cycle", replayed: false } }) };
  const createSetupIntent = vi.fn().mockResolvedValue({ setupIntentId: "seti_original", clientSecret: "test_handoff", replayed: false });
  const ensureCustomer = vi.fn();
  const deps = { enabled: () => true, recoveryPort, authenticateCustomer: async () => ({ ok: true as const, userId: actor }), now: () => new Date(AT) };
  return { recoveryPort, createSetupIntent, ensureCustomer,
    collect: createPaymentRecoverySetupHandler({ ...deps, createSetupIntent, ensureCustomer }),
    redeem: createPaymentRecoveryRedeemHandler(deps) };
}
const collectRequest = { method: "POST", headers: {}, body: { idempotencyKey: "repair-original", recoveryToken: TOKEN } };
const redeemRequest = { method: "POST", headers: {}, body: { idempotencyKey: "repair-original", recoveryToken: TOKEN,
  paymentMethodRef: "pm_repaired", paymentMethodKind: "stored-method", requestedAt: AT } };

describe("reference method repair", () => {
  it("scopes collection and redeem to the original obligation and makes unsupported setup visible", async () => {
    const f = setup(), collected = response(), redeemed = response();
    const identity = { orderId: ORDER, clientId: "client-original", paymentIntentId: "intent-original" };
    const setupMethod = vi.fn(async () => {
      await f.collect(collectRequest as never, collected as never);
      return { kind: "ready" as const, setupRef: "setup-original", replayed: false,
        handoff: { kind: "client-confirmed" as const, payload: "test_handoff" as import("@openlup/platform/payments/contracts").TransientSecret } };
    });
    const confirmAction = vi.fn(async () => { await f.redeem(redeemRequest as never, redeemed as never); });
    const view = render(<ReferencePaymentRepairPage identity={identity} setupMethod={setupMethod} confirmAction={confirmAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up payment method" }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalledOnce());
    expect(collected.status).toHaveBeenCalledWith(200);
    expect(f.createSetupIntent).toHaveBeenCalledExactlyOnceWith({ customer: "cus_original",
      idempotencyKey: `recovery-setup:${CASE}:repair-original`, metadata: {
        clientId: "client-original", subscriptionId: SUB, recoveryCaseId: CASE, source: "payment-recovery.setup" } });
    expect(f.ensureCustomer).not.toHaveBeenCalled();
    expect(f.recoveryPort.recordSubscriptionPaymentRecovery).toHaveBeenCalledExactlyOnceWith(redeemRequest.body);
    expect(redeemed.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ recovery: {
      caseId: CASE, subscriptionId: SUB, cycleId: CYCLE, orderId: ORDER, purpose: "repair_payment",
      nextAction: "retry_existing_cycle", replayed: false } }) }));
    expect(screen.queryByText("Payment confirmed.")).not.toBeInTheDocument();
    view.rerender(<ReferencePaymentRepairPage identity={identity} />);
    expect(screen.getByText("Method setup is unsupported by this installation.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Verify payment now" }));
    expect(await screen.findByText(/Verification requested/)).toBeInTheDocument();
    expect(screen.queryByText("Payment confirmed.")).not.toBeInTheDocument();
  });
});

const unattendedChargeCapability = {
  providerKind: "provider-a", requiresStoredMandateEvidence: false,
  assessMandate: () => ({ chargeable: true }), unattendedChargeFlow: "unattended",
  payerContext: { requiresPayerBlock: false, customerRefFallsBackToContactEmail: false },
  methodHealth: { requiresCustomerRef: true, requiredMethodKind: null, requiresPayerContact: false },
  terminalOutcomeReporting: { kind: "inbound_event" as const, silenceBecomesSuspectAfterMinutes: 60 },
  mandateUpsertIsSubscriptionScoped: true, captureFlows: [],
};
const RENEWAL_AT = "2026-10-21T10:00:00.000Z", SCHEDULED = "2026-10-19T00:00:00.000Z";
const due = { subscriptionId: "sub-original", clientId: "client-original", nextCycleAt: SCHEDULED,
  currency: "XXX", providerKind: "provider-a", providerCustomerRef: "cus_original", providerMethodRef: "pm_original",
  methodKind: "card", payerEmail: null, payerName: null };
function fixture() {
  const frozen = Object.freeze({ totals: { totalGross: { amountMinor: 9100 } }, marker: "original-frozen-order" });
  const persistence = { buildCycleSnapshots: vi.fn().mockResolvedValue({ cycleNumber: 7, retryAttempt: 2,
    providerAttemptSequence: 0, templateSnapshot: { template: "original" }, pricingSnapshot: { price: "original" }, orderSnapshot: frozen }),
    createCycleOrder: vi.fn().mockResolvedValue({ cycleId: "cycle-original", orderUuid: "order-original", orderRef: "order_original",
      paymentRef: "payment-original", replayed: true }),
    preflightReservation: vi.fn().mockResolvedValue({ ok: true, itemsChecked: 1, reacquired: 0, reason: null }),
    readMandateRecurringModel: vi.fn(), noteRowOutcome: vi.fn() };
  const prepared = { paymentAttemptId: "attempt-original", status: "created" as const, replayed: false,
    providerAttemptId: null, providerSessionId: null, nextActionKind: null };
  const paymentPort = { createIntent: vi.fn().mockResolvedValue({ paymentIntentId: "intent-original", paymentId: "payment-original",
    status: "processing", replayed: true }), recordAttempt: vi.fn(), applyResult: vi.fn(),
    prepareProviderAttempt: vi.fn().mockResolvedValue(prepared), finalizeProviderAttempt: vi.fn().mockResolvedValue({ ...prepared, status: "processing" }) };
  const chargeFailurePropagation = { recordBlockedPreflightAttempt: vi.fn(),
    readDurableAttemptInstant: vi.fn().mockResolvedValue("2026-10-19T00:01:00.000Z"),
    applyFailedResult: vi.fn().mockResolvedValue({ replayed: false }),
    readCycleRetryState: vi.fn().mockResolvedValue({ retryAttempt: 3, nextRetryAt: null, rowPresent: true }),
    openDunningCase: vi.fn().mockResolvedValue({ status: "opened", caseId: "case-original" }) };
  const execution = { provider: "provider-a" as const, providerAttemptId: "pi_original", providerSessionId: null,
    attemptStatus: "processing" as const, nextActionKind: null, requestPayload: {}, responsePayload: {} };
  const execute = vi.fn().mockResolvedValue(execution);
  const run = () => chargeSubscriptionCycleOffSession({ persistence, paymentPort, executionPort: { execute },
    capability: unattendedChargeCapability, chargeFailurePropagation, now: () => RENEWAL_AT,
    deliveryAlignment: { admitDeliveryAlignment: async () => ({ allowed: true, state: "none", reason: "clear" }) } }, due);
  function originalObligation() {
    expect(persistence.buildCycleSnapshots).toHaveBeenCalledExactlyOnceWith({ subscriptionId: "sub-original", scheduledAt: SCHEDULED });
    expect(persistence.createCycleOrder).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      cycleNumber: 7, scheduledAt: SCHEDULED, orderSnapshot: frozen,
      idempotencyKey: "subscription:sub-original:cycle:2026-10-19T00:00:00.000Z",
    }));
    expect(persistence.createCycleOrder.mock.calls[0][0].orderSnapshot).toBe(frozen);
    expect(paymentPort.createIntent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      orderId: "order-original", subscriptionId: "sub-original", subscriptionCycleId: "cycle-original", amountMinor: 9100,
      currency: "XXX", metadata: expect.objectContaining({ scheduledAt: SCHEDULED }),
    }));
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ amountMinor: 9100, currency: "XXX",
      paymentIntentId: "intent-original", orderRef: "order_original" }));
    expect(paymentPort.recordAttempt).not.toHaveBeenCalled(); expect(paymentPort.applyResult).not.toHaveBeenCalled();
    expect(persistence.noteRowOutcome).not.toHaveBeenCalled();
  }
  return { run, execute, execution, originalObligation, paymentPort, chargeFailurePropagation };
}

describe("reference original renewal obligation", () => {
  it.each(["decline", "sca"] as const)("keeps %s on the frozen original cycle with one failure handoff", async (outcome) => {
    const f = fixture();
    f.execute.mockResolvedValue({ ...f.execution, ...(outcome === "sca" ? { attemptStatus: "requires_action", nextActionKind: "sca_required" }
      : { providerDecline: { code: "card_declined", mandateUnsupported: false } }) });
    const result = await f.run();
    expect(result).toMatchObject({ outcome: outcome === "sca" ? "requires_action" : "failed", cycleId: "cycle-original",
      orderId: "order-original", paymentIntentId: "intent-original" });
    f.originalObligation();
    expect(f.chargeFailurePropagation.applyFailedResult).toHaveBeenCalledTimes(1);
    expect(f.chargeFailurePropagation.openDunningCase).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      subscriptionId: "sub-original", cycleId: "cycle-original", orderUuid: "order-original", paymentIntentId: "intent-original",
      nextRetryAt: null, occurredAt: "2026-10-19T00:01:00.000Z",
    }));
    expect(f.chargeFailurePropagation.recordBlockedPreflightAttempt).not.toHaveBeenCalled();
  });

  it("keeps unknown execution on the same obligation without finalization or failure callbacks", async () => {
    const f = fixture(); f.execute.mockRejectedValue(new Error("acceptance_reply_lost"));
    await expect(f.run()).rejects.toThrow("provider_execution_indeterminate"); f.originalObligation();
    expect(f.paymentPort.finalizeProviderAttempt).not.toHaveBeenCalled();
    expect(f.chargeFailurePropagation.applyFailedResult).not.toHaveBeenCalled();
    expect(f.chargeFailurePropagation.openDunningCase).not.toHaveBeenCalled();
  });

});

// Pins current behavior for OSS M07 extraction; must not change with refactors.
// Existing status mappers/header matrices are retained; this composes verify → stored status.
const RETURN_ORDER = "11111111-1111-4111-8111-111111111111", RETURN_CLIENT = "22222222-2222-4222-8222-222222222222";
const RETURN_INTENT = "33333333-3333-4333-8333-333333333333", RETURN_ATTEMPT = "44444444-4444-4444-8444-444444444444";
const RETURN_AT = "2026-10-21T10:00:00.000Z", RETURN_JOURNEY = "checkout:55555555-5555-4555-8555-555555555555";
const RETURN_ids = { orderId: RETURN_ORDER, clientId: RETURN_CLIENT, paymentIntentId: RETURN_INTENT };
function returnResponse() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn(), getHeader: vi.fn() };
  res.status.mockReturnValue(res); return res;
}
function returnFixture() {
  const snapshot = { ...RETURN_ids, orderStatus: "pending_payment", intentStatus: "processing" as const,
    paymentAttemptId: RETURN_ATTEMPT, attemptStatus: "processing" as const, provider: "provider-a", providerPaymentId: "pi_stored",
    updatedAt: RETURN_AT, failureReason: null, subscriptionActivationStatus: "not_applicable" as const, subscriptionId: null };
  const readVerifiableAttempt = vi.fn().mockResolvedValue({ orderId: RETURN_ORDER, orderClientId: RETURN_CLIENT, orderMode: "one_time",
    paymentIntentId: RETURN_INTENT, intentStatus: "processing", intentProviderPaymentId: "pi_old", paymentAttemptId: RETURN_ATTEMPT,
    paymentId: "payment-stored", attemptStatus: "processing", provider: "provider-a", providerAttemptId: "pi_stored",
    providerSessionId: "session-old", amountMinor: 9000, currency: "XXX", localUpdatedAt: RETURN_AT });
  const applyTerminalResult = vi.fn();
  const readPayment = vi.fn().mockResolvedValue({ status: "unknown", providerStatus: "unrecognized", occurredAt: null,
    amountMinor: null, currency: null, failureReason: null, rawPayload: {} });
  const verify = createCommercePaymentVerifyHandler({ readPort: { readVerifiableAttempt }, applyPort: { applyTerminalResult },
    providers: { "provider-a": { readPayment } }, responder: createBffResponder(), mutationsEnabled: () => true, now: () => new Date(RETURN_AT) });
  const getPaymentStatus = vi.fn(async () => snapshot), readActiveAction = vi.fn().mockResolvedValue(null);
  const readContinuationClaims = vi.fn().mockReturnValue({ ...RETURN_ids, journeyId: RETURN_JOURNEY,
    paymentAttemptId: RETURN_ATTEMPT, executionRail: "provider-a", expiresAt: 9999999999 });
  const status = createCommercePaymentStatusHandler({ statusPort: { getPaymentStatus }, resolveFailureDisplay: () => null,
    mutationsEnabled: () => true, readContinuationClaims, activeActionResolver: { readActiveAction } });
  return { verify, status, readPayment, applyTerminalResult, getPaymentStatus, readVerifiableAttempt,
    readActiveAction, readContinuationClaims };
}

describe("reference stored return truth", () => {
  it("preserves stored status truth and capability headers on the signed attempt", async () => {
    const f = returnFixture(), legacy = returnResponse(), opted = returnResponse();
    const req = { method: "GET", query: { ...RETURN_ids, journeyId: RETURN_JOURNEY }, headers: {} };
    await f.status(req as never, legacy as never);
    await f.status({ ...req, headers: { [PAYMENT_FAILURE_DISPLAY_HEADER.toLowerCase()]: "1",
      [PAYMENT_RECOVERY_GUIDANCE_HEADER.toLowerCase()]: "1" } } as never, opted as never);
    expect(legacy.json.mock.calls[0][0].data).not.toHaveProperty("failureDisplay");
    expect(legacy.json.mock.calls[0][0].data).not.toHaveProperty("recoveryGuidance");
    expect(opted.json.mock.calls[0][0].data).toMatchObject({ failureDisplay: null, recoveryGuidance: null });
    expect(opted.setHeader).toHaveBeenCalledWith("Vary", `Cookie, Authorization, ${PAYMENT_FAILURE_DISPLAY_HEADER}, ${PAYMENT_RECOVERY_GUIDANCE_HEADER}`);
    expect(opted.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(f.readActiveAction.mock.calls).toEqual([[{ ...RETURN_ids, paymentAttemptId: RETURN_ATTEMPT, executionRail: "provider-a" }],
      [{ ...RETURN_ids, paymentAttemptId: RETURN_ATTEMPT, executionRail: "provider-a" }]]);

    const stored = returnResponse();
    await f.status({ method: "GET", query: RETURN_ids, headers: {} } as never, stored as never);
    expect(stored.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "processing",
      payment: expect.objectContaining({ paymentAttemptId: RETURN_ATTEMPT, providerPaymentId: "pi_stored" }) }) }));
    f.readContinuationClaims.mockReturnValue({ ...RETURN_ids, journeyId: RETURN_JOURNEY, paymentAttemptId: "stale-attempt", executionRail: "provider-a" });
    f.readActiveAction.mockClear();
    await f.status(req as never, returnResponse() as never);
    expect(f.readActiveAction).not.toHaveBeenCalled(); expect(f.applyTerminalResult).not.toHaveBeenCalled();
  });
});
