vi.mock("../../src/domains/payment/storedMethodCapabilities.js", () => ({
  storedMethodExpectations: () => ({ requiresCustomerRef: false, requiredMethodKind: "stored-method", requiresPayerContact: true }),
  storedMethodCapabilityKinds: ["provider-b"],
}));
vi.mock("../../src/lib/currency/platformCurrency.js", async original => ({
  ...await original<object>(), readSettlementProfile: () => ({ acceptedCurrencies: ["XXX"] }),
}));
import { chargeSubscriptionCycleOffSession } from "../../server/domains/subscription/chargeSubscriptionCycleOffSession.js";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createPaymentRecoverySetupHandler } from "../../server/domains/payment/paymentRecoverySetupHandler.js";
import { createPaymentRecoveryRedeemHandler } from "../../server/domains/subscription/paymentRecoveryHandler.js";
import { PaymentRepairStatus } from "./PaymentRepairStatus";
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

describe("reference repair authority and poller", () => {
  it("refuses a denied actor before every effect and polls stored status rather than browser claims", async () => {
    const f = setup("different-owner"), collected = response(), redeemed = response();
    await f.collect(collectRequest as never, collected as never); await f.redeem(redeemRequest as never, redeemed as never);
    expect(collected.status).toHaveBeenCalledWith(403); expect(redeemed.status).toHaveBeenCalledWith(403);
    expect(f.recoveryPort.resolveRecoveryCaseSubscription).not.toHaveBeenCalled();
    expect(f.createSetupIntent).not.toHaveBeenCalled(); expect(f.ensureCustomer).not.toHaveBeenCalled();
    expect(f.recoveryPort.recordSubscriptionPaymentRecovery).not.toHaveBeenCalled();
    const fetchStatus = vi.fn().mockResolvedValueOnce({ status: "processing", intentStatus: "processing" })
      .mockResolvedValue({ status: "paid", intentStatus: "succeeded" });
    const view = render(<PaymentRepairStatus orderId={ORDER} clientId="client-original" paymentIntentId="intent-original" fetchStatus={fetchStatus} />);
    await waitFor(() => expect(fetchStatus).toHaveBeenCalledOnce());
    expect(screen.queryByText("Payment confirmed.")).not.toBeInTheDocument();
    // Remount with a different stored attempt identity; the reused poller reads immediately.
    view.rerender(<PaymentRepairStatus key="next" orderId={ORDER} clientId="client-original" paymentIntentId="intent-next" fetchStatus={fetchStatus} />);
    expect(await screen.findByText("Payment confirmed.")).toBeInTheDocument();
    expect(fetchStatus).toHaveBeenLastCalledWith({ orderId: ORDER, clientId: "client-original", paymentIntentId: "intent-next" });
  });
});

describe("reference mandate refusal", () => {
  it("refuses an unchargeable mandate before prepare, execute or finalize", async () => {
    const prepare = vi.fn(), execute = vi.fn(), finalize = vi.fn(), blocked = vi.fn();
    const applyFailedResult = vi.fn().mockResolvedValue({ replayed: false });
    const readMandateRecurringModel = vi.fn().mockResolvedValue("M");
    const result = await chargeSubscriptionCycleOffSession({ capability: {
      providerKind: "provider-b", requiresStoredMandateEvidence: true, assessMandate: () => ({ chargeable: false }),
      unattendedChargeFlow: "unattended", captureFlows: [], mandateUpsertIsSubscriptionScoped: true,
      payerContext: { requiresPayerBlock: true, customerRefFallsBackToContactEmail: true },
      methodHealth: { requiresCustomerRef: false, requiredMethodKind: "stored-method", requiresPayerContact: true },
      terminalOutcomeReporting: { kind: "inbound_event", silenceBecomesSuspectAfterMinutes: 60 },
    }, paymentPort: { createIntent: vi.fn().mockResolvedValue({ paymentIntentId: "intent-original", replayed: true }),
      prepareProviderAttempt: prepare, finalizeProviderAttempt: finalize } as never, executionPort: { execute }, now: () => AT,
    deliveryAlignment: { admitDeliveryAlignment: async () => ({ allowed: true, state: "none", reason: "clear" }) },
    persistence: { readMandateRecurringModel, buildCycleSnapshots: vi.fn().mockResolvedValue({ cycleNumber: 7, retryAttempt: 1,
      providerAttemptSequence: 0, templateSnapshot: {}, pricingSnapshot: {}, orderSnapshot: { totals: { totalGross: { amountMinor: 9100 } } } }),
      createCycleOrder: vi.fn().mockResolvedValue({ cycleId: "cycle-original", orderUuid: "order-original", orderRef: "order_original", replayed: true }),
      preflightReservation: vi.fn(), noteRowOutcome: vi.fn() }, chargeFailurePropagation: {
      recordBlockedPreflightAttempt: blocked, readDurableAttemptInstant: vi.fn().mockResolvedValue(AT), applyFailedResult,
      readCycleRetryState: vi.fn().mockResolvedValue({ retryAttempt: 2, nextRetryAt: null, rowPresent: true }),
      openDunningCase: vi.fn().mockResolvedValue({ status: "opened", caseId: "case-original" }),
    } }, { subscriptionId: "sub-original", clientId: "client-original", nextCycleAt: AT, currency: "XXX", providerKind: "provider-b",
      providerCustomerRef: null, providerMethodRef: "method-original", methodKind: "stored-method", payerEmail: "buyer@example.invalid", payerName: "Buyer" });
    expect(result).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/_recurring_requires_model_o$/), cycleId: "cycle-original", orderId: "order-original" });
    expect(readMandateRecurringModel).toHaveBeenCalledExactlyOnceWith("provider-b", "method-original");
    expect(blocked).toHaveBeenCalledTimes(1); expect(applyFailedResult).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(finalize).not.toHaveBeenCalled();
  });
});
