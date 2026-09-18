// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import type { ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import { PUBLIC_CONFIGURATOR_DRAFT_SCOPE } from "@/checkout/composer/configuratorDraftStore";
import { emptyTpayCheckoutDraft } from "@/checkout/adapters/tpayCheckoutDraft";
import type { CheckoutPaymentRecoveryGuidance } from "@/domains/commerce/paymentRecoveryGuidanceContracts";
import type { CheckoutInlineRecoveryPayResponse } from "@/domains/commerce/checkoutInlineRecoveryContracts";
import { readCheckoutContinuation } from "../../src/checkout/machine/checkoutNavigation";
import { routeConfiguratorCheckoutResult } from "../../src/checkout/machine/checkoutSubmitResultRouting";
import type { CheckoutInlineWaitStart } from "../../src/checkout/machine/useConfiguratorPaymentWait";
import { buildCheckoutInlineRecoveryPayRequest, createCheckoutInlineRetryRequestId, executeCheckoutInlineRecovery } from "../../src/checkout/adapters/checkoutInlineRecoveryPay";
import { payCheckoutInlineRecovery } from "../../src/domains/commerce/checkoutRecoveryClient";
import { BffClientError } from "../../src/lib/bff/client";

const diagnosticReporter = vi.hoisted(() => ({ reportCustomerJourneyDiagnostic: vi.fn() }));
const diagnosticActionKey = "11111111-1111-4111-8111-111111111111";
vi.mock("@/lib/flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/flags")>();
  return {
    ...actual,
    createCustomerDiagnosticActionKeyWhenEnabled: vi.fn(() => diagnosticActionKey),
    loadCustomerDiagnosticReporterWhenEnabled: vi.fn(() => Promise.resolve(diagnosticReporter)),
  };
});
vi.mock("../../src/domains/commerce/checkoutRecoveryClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/domains/commerce/checkoutRecoveryClient")>();
  return { ...actual, payCheckoutInlineRecovery: vi.fn() };
});

const identity = {
  orderId: "11111111-1111-4111-8111-111111111111",
  clientId: "22222222-2222-4222-8222-222222222222",
  paymentIntentId: "33333333-3333-4333-8333-333333333333",
  journeyId: "checkout:44444444-4444-4444-8444-444444444444",
};
const guidance: CheckoutPaymentRecoveryGuidance = {
  version: 1 as const,
  paymentAttemptId: "55555555-5555-4555-8555-555555555555",
  purchaseContext: "subscription_initial" as const,
  cause: "generic_decline" as const,
  methodKind: "blik",
  methodKey: "blik",
  operation: "recurring_setup" as const,
  restriction: null,
  actions: ["change_method"],
  consecutiveRefusals: 1 as const,
  emphasis: "normal" as const,
};
const retryRequestId = "66666666-6666-4666-8666-666666666666";

beforeEach(() => {
  sessionStorage.clear();
  diagnosticReporter.reportCustomerJourneyDiagnostic.mockReset();
  vi.mocked(payCheckoutInlineRecovery).mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("checkout inline recovery request", () => {
  it("binds card to the exact failed attempt without a client-selected payment key", () => {
    expect(buildCheckoutInlineRecoveryPayRequest({ identity, guidance,
      data: { ...defaultConfiguratorFormData, subscription: true, paymentMethod: "card" },
      executionDraft: emptyTpayCheckoutDraft, retryRequestId })).toEqual({
      ...identity, expectedPaymentAttemptId: guidance.paymentAttemptId, retryRequestId,
      paymentMethod: "card", paymentProvider: "stripe",
    });
  });

  it("builds only fresh Model O BLIK for subscription recovery", () => {
    expect(buildCheckoutInlineRecoveryPayRequest({ identity, guidance,
      data: { ...defaultConfiguratorFormData, subscription: true, paymentMethod: "blik" },
      executionDraft: { ...emptyTpayCheckoutDraft, blikToken: " 123456 ", blikBankId: "bank" },
      retryRequestId })).toMatchObject({ paymentMethod: "blik", paymentProvider: "tpay",
        paymentExecution: { provider: "tpay", flow: "blik_recurring_activation",
          blikToken: "123456", recurringModel: "O" } });
  });

  it.each([
    ["wrong context", { ...guidance, purchaseContext: "one_time" as const }, "card", emptyTpayCheckoutDraft],
    ["PBL", guidance, "transfer", { ...emptyTpayCheckoutDraft, pblChannelId: "21" }],
    ["saved BLIK", guidance, "blik_one_click", { ...emptyTpayCheckoutDraft,
      savedMethodId: "77777777-7777-4777-8777-777777777777" }],
    ["invalid fresh BLIK", guidance, "blik", { ...emptyTpayCheckoutDraft, blikToken: "123" }],
  ] as const)("rejects %s before POST", (_label, recovery, paymentMethod, executionDraft) => {
    expect(buildCheckoutInlineRecoveryPayRequest({ identity, guidance: recovery,
      data: { ...defaultConfiguratorFormData, subscription: true, paymentMethod },
      executionDraft, retryRequestId })).toBeNull();
  });

  it("uses a browser-tab nonce and never derives it from payment data", () => {
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockReturnValue(retryRequestId);
    expect(createCheckoutInlineRetryRequestId()).toBe(retryRequestId);
    expect(randomUUID).toHaveBeenCalledOnce();
  });
});

describe("checkout inline recovery result routing", () => {
  it("records one stable submit lifecycle after an accepted recovery request", async () => {
    vi.mocked(payCheckoutInlineRecovery).mockResolvedValue(inlineRecoveryResponse());

    await executeCheckoutInlineRecovery({
      identity,
      guidance,
      data: { ...defaultConfiguratorFormData, subscription: true, paymentMethod: "card" },
      executionDraft: emptyTpayCheckoutDraft,
      retryRequestId,
      timeoutMs: 1_000,
      onAuthorityChanged: vi.fn(),
    });

    await Promise.resolve();
    expect(diagnosticReporter.reportCustomerJourneyDiagnostic).toHaveBeenCalledWith({
      action: "checkout_recovery_submit", phase: "attempted", code: "observed", clientActionKey: diagnosticActionKey,
    });
    expect(diagnosticReporter.reportCustomerJourneyDiagnostic).toHaveBeenCalledWith({
      action: "checkout_recovery_submit", phase: "settled", code: "succeeded", clientActionKey: diagnosticActionKey,
    });
  });

  it("classifies local request validation without issuing a recovery charge", async () => {
    await expect(executeCheckoutInlineRecovery({
      identity,
      guidance: { ...guidance, purchaseContext: "one_time" },
      data: { ...defaultConfiguratorFormData, subscription: true, paymentMethod: "card" },
      executionDraft: emptyTpayCheckoutDraft,
      retryRequestId,
      timeoutMs: 1_000,
      onAuthorityChanged: vi.fn(),
    })).rejects.toThrow("checkout:errors.detailsIncomplete");

    await Promise.resolve();
    expect(payCheckoutInlineRecovery).not.toHaveBeenCalled();
    expect(diagnosticReporter.reportCustomerJourneyDiagnostic).toHaveBeenCalledWith({
      action: "checkout_recovery_submit", phase: "settled", code: "validation_blocked", clientActionKey: diagnosticActionKey,
    });
  });

  it.each([
    [
      "a known BFF refusal",
      new BffClientError({ code: "CONFLICT", message: "recovery refused", details: {} }, 409, "req_inline_rejected"),
      "rejected",
      "req_inline_rejected",
    ],
    [
      "an uncertain BFF transport result",
      new BffClientError({ code: "UPSTREAM_UNAVAILABLE", message: "connection lost", details: {} }, 0, "req_inline_uncertain"),
      "transport_uncertain",
      "req_inline_uncertain",
    ],
  ] as const)("reports %s with only its BFF request reference and no second charge", async (_label, failure, code, relatedRequestId) => {
    const onAuthorityChanged = vi.fn();
    vi.mocked(payCheckoutInlineRecovery).mockRejectedValueOnce(failure);

    await expect(executeCheckoutInlineRecovery({
      identity,
      guidance,
      data: { ...defaultConfiguratorFormData, subscription: true, paymentMethod: "card" },
      executionDraft: emptyTpayCheckoutDraft,
      retryRequestId,
      timeoutMs: 1_000,
      onAuthorityChanged,
    })).rejects.toBe(failure);

    await Promise.resolve();
    expect(payCheckoutInlineRecovery).toHaveBeenCalledTimes(1);
    expect(diagnosticReporter.reportCustomerJourneyDiagnostic).toHaveBeenCalledWith({
      action: "checkout_recovery_submit", phase: "settled", code, clientActionKey: diagnosticActionKey, relatedRequestId,
    });
    expect(onAuthorityChanged).toHaveBeenCalledTimes(code === "rejected" ? 1 : 0);
  });

  it("routes an exact inline card retry through the existing embedded panel", () => {
    const setEmbedded = vi.fn();
    routeConfiguratorCheckoutResult({
      ...routingDeps("embedded", setEmbedded),
      result: inlineRecoveryResponse({
        provider: "stripe",
        clientAction: { kind: "provider_embedded", provider: "stripe", clientSecret: "pi_inline_secret" },
      }),
      source: "inline_recovery",
      journeyId: identity.journeyId,
    });

    expect(setEmbedded).toHaveBeenCalledWith(expect.objectContaining({
      orderId: identity.orderId,
      clientSecret: "pi_inline_secret",
      journeyId: identity.journeyId,
    }));
    expect(readCheckoutContinuation()).toMatchObject({
      orderRef: `order_${identity.orderId}`,
      actionKind: "embedded",
    });
  });

  it("hands an actionless exact code retry to the existing in-place wait", () => {
    const onInlineWait = vi.fn();
    const navigate = vi.fn();
    routeConfiguratorCheckoutResult({
      ...routingDeps("redirect"),
      navigate,
      onInlineWait,
      data: { ...defaultConfiguratorFormData, paymentMethod: "blik" },
      result: inlineRecoveryResponse({ provider: "tpay", clientAction: { kind: "none" } }),
      source: "inline_recovery",
      journeyId: identity.journeyId,
    });

    expect(onInlineWait).toHaveBeenCalledWith(expect.objectContaining({
      orderId: identity.orderId,
      journeyId: identity.journeyId,
    }));
    expect(navigate).not.toHaveBeenCalled();
    expect(readCheckoutContinuation()).toMatchObject({ actionKind: "none", phase: "confirm_dispatched" });
  });
});

function inlineRecoveryResponse(
  overrides: Partial<CheckoutInlineRecoveryPayResponse> = {},
): CheckoutInlineRecoveryPayResponse {
  return {
    contractVersion: "commerce.checkout-inline-recovery.v1",
    status: "processing",
    ...identity,
    orderRef: `order_${identity.orderId}`,
    paymentAttemptId: guidance.paymentAttemptId,
    provider: "stripe",
    providerPaymentId: "pi_inline",
    clientAction: { kind: "none" },
    ...overrides,
  };
}

function routingDeps(
  actionKind: "embedded" | "redirect",
  setEmbedded = vi.fn(),
  onInlineWait?: (start: CheckoutInlineWaitStart) => void,
) {
  return {
    data: defaultConfiguratorFormData as ConfiguratorFormData,
    ...(onInlineWait ? { onInlineWait } : {}),
    navigate: vi.fn(),
    paths: { thankYou: "/thanks", paymentPath: "/payment" },
    accountMode: false,
    hasTpayPatch: actionKind === "redirect",
    useStripe: actionKind === "embedded",
    draftScope: PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
    setStripePay: setEmbedded,
  };
}
