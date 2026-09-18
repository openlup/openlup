import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const submitCheckout = vi.fn();
const bumpCheckoutPaymentAttempt = vi.fn();

vi.mock("@/domains/commerce/commerceClient", () => ({
  submitCheckout: (...args: unknown[]) => submitCheckout(...args),
}));
vi.mock("./buildCheckoutIntent", () => ({
  buildCheckoutIntent: () => ({ mode: "one_time", contact: { email: "anna@example.com" }, idempotencyKey: "seed" }),
}));
vi.mock("./checkoutInvoicePreference", () => ({
  buildCheckoutInvoicePreference: () => undefined,
}));
vi.mock("@/checkout/adapters/tpayCheckoutDraft", () => ({
  buildTpayCheckoutRequestPatch: () => ({
    paymentProvider: "tpay",
    paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" },
  }),
}));
vi.mock("@/checkout/adapters/tpayCheckoutRequestOptions", () => ({
  checkoutRequestOptionsForTpay: async () => ({}),
}));
vi.mock("./checkoutAttemptStore", () => ({
  getOrCreateCheckoutAttemptKey: () => "attempt-key",
  clearCheckoutAttemptKey: vi.fn(),
  readCheckoutPaymentAttempt: vi.fn(() => 0),
  bumpCheckoutPaymentAttempt: (...args: unknown[]) => bumpCheckoutPaymentAttempt(...args),
}));
// Partial mock: override the one gate this suite steers and take every other
// export from the real module. Enumerating the rest would model it completely
// but name vendors this guarded surface is pinned against.
vi.mock("@/checkout/adapters/tpayCheckoutFlags", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tpayCheckoutScaffoldingEnabled: () => true,
}));
vi.mock("@/checkout/adapters/stripeCheckoutFlags", () => ({ stripeCheckoutUiEnabled: () => false }));
vi.mock("@/checkout/composer/deliverySelectionFlags", () => ({
  deliverySelectionUiEnabled: () => false,
  dhlOnlyDeliveryEnabled: () => false,
}));
vi.mock("./checkoutResumeGuard", () => ({ resolvePendingResume: async () => "discard" }));

import { useConfiguratorCheckout } from "./useConfiguratorCheckout";
import {
  LEGACY_CHECKOUT_CONTINUATION_KEY,
  readAccountOrderReturn,
  clearAccountOrderReturn,
} from "./checkoutNavigation";
import { setConfiguratorFormData, type ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import {
  createAccountConfiguratorDraftScope,
  getConfiguratorDraftStorageKey,
  PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
} from "@/checkout/composer/configuratorDraftStore";

/**
 * Line γ seam fixture: the composition vocabulary the composition root supplies in
 * production. Held here as plain data so the machine's tests exercise the seam without
 * importing the vertical's validation module.
 */
const KNOWN_COMPOSITION_SLUGS = ["lamb", "venison", "beef", "turkey", "salmon", "pork"] as const;

const ACCOUNT_STATUS_PATH = "/konto/zamowienie/status";

const formData = {
  accountPetId: "pet-123",
  dogName: "Burek",
  subscription: false,
  checkoutQuoteExpectation: {
    totalGross: { amountMinor: 20_860, currency: "PLN" },
  },
} as ConfiguratorFormData;

const processingResult = {
  status: "processing" as const,
  orderId: "11111111-1111-4111-8111-111111111111",
  orderRef: "order_11111111-1111-4111-8111-111111111111",
  paymentIntentId: "22222222-2222-4222-8222-222222222222",
  clientId: "33333333-3333-4333-8333-333333333333",
  providerPaymentId: "tpay_sim_22222222-2222-4222-8222-222222222222",
  clientAction: { kind: "none" as const },
};

beforeEach(() => {
  submitCheckout.mockReset();
  bumpCheckoutPaymentAttempt.mockReset();
  clearAccountOrderReturn();
  localStorage.clear();
  sessionStorage.clear();
  globalThis.__openlup_TEST_CONFIGURATOR_LIVE_QUOTE__ = undefined;
  globalThis.__openlup_TEST_SUBSCRIPTION_CHECKOUT_CONTRACT__ = undefined;
});
afterEach(() => {
  globalThis.__openlup_TEST_CONFIGURATOR_LIVE_QUOTE__ = undefined;
  globalThis.__openlup_TEST_SUBSCRIPTION_CHECKOUT_CONTRACT__ = undefined;
  clearAccountOrderReturn();
  delete globalThis.__openlup_TEST_COMMERCE_FORM_PERSISTENCE__;
});

function setup(accountMode: boolean) {
  const navigate = vi.fn();
  const onAccountOrderComplete = accountMode ? vi.fn() : undefined;
  const { result } = renderHook(() =>
    useConfiguratorCheckout({ knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS,
      navigate,
      lang: "pl",
      paths: {
        thankYou: "/skomponuj-pakiet/dziekujemy",
        paymentFailed: "/skomponuj-pakiet/platnosc-nieudana",
        paymentPath: "/skomponuj-pakiet/platnosc",
        ...(accountMode ? { accountStatusPath: ACCOUNT_STATUS_PATH } : {}),
        ...(accountMode ? { accountDashboardPath: "/konto" } : {}),
      },
      onAccountOrderComplete,
      ...(accountMode
        ? { draftScope: createAccountConfiguratorDraftScope("client-123", "pet-123") }
        : {}),
    }),
  );
  return { navigate, controller: result, onAccountOrderComplete };
}

describe("useConfiguratorCheckout account-mode Tpay return", () => {
  it("fails closed before intent submission when a selected subscription contract is disabled", async () => {
    globalThis.__openlup_TEST_SUBSCRIPTION_CHECKOUT_CONTRACT__ = false;
    const { navigate, controller } = setup(false);
    let thrown: unknown;

    await act(async () => {
      try {
        await controller.current.handleComplete(
          { ...formData, subscription: true },
          { paymentMethod: "blik" } as never,
        );
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toEqual(
      new Error("checkout:errors.subscriptionCheckoutUnavailable"),
    );
    expect(submitCheckout).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("blocks checkout locally when the current quote expectation is missing", async () => {
    const { controller } = setup(false);
    let thrown: unknown;

    await act(async () => {
      try {
        await controller.current.handleComplete(
          { ...formData, checkoutQuoteExpectation: null },
          { paymentMethod: "blik" } as never,
        );
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toEqual(new Error("checkout:errors.quoteUnavailable"));
    expect(submitCheckout).not.toHaveBeenCalled();
  });

  it("sends returnContext:account and routes a BLIK checkout to the in-shell terminal", async () => {
    submitCheckout.mockResolvedValue(processingResult);
    const { navigate, controller } = setup(true);

    await act(async () => {
      await controller.current.handleComplete(formData, { paymentMethod: "blik" } as never);
    });

    expect(submitCheckout).toHaveBeenCalledTimes(1);
    expect(submitCheckout.mock.calls[0][0]).toMatchObject({ returnContext: "account" });

    const calls = navigate.mock.calls;
    const navUrl = calls[calls.length - 1][0] as string;
    expect(navUrl.startsWith(ACCOUNT_STATUS_PATH)).toBe(true);

    expect(readAccountOrderReturn(processingResult.orderId)).toMatchObject({
      orderRef: processingResult.orderRef,
      petName: "Burek",
      isSubscription: false,
      petId: "pet-123",
    });
  });

  it("clears only the selected account/pet draft after an immediate paid result", async () => {
    globalThis.__openlup_TEST_COMMERCE_FORM_PERSISTENCE__ = true;
    const accountScope = createAccountConfiguratorDraftScope("client-123", "pet-123");
    const accountKey = getConfiguratorDraftStorageKey(accountScope);
    const publicKey = getConfiguratorDraftStorageKey(PUBLIC_CONFIGURATOR_DRAFT_SCOPE);
    localStorage.setItem(accountKey, "account-draft");
    localStorage.setItem(publicKey, "public-draft");
    submitCheckout.mockResolvedValue({ ...processingResult, status: "paid" });
    const { controller } = setup(true);

    await act(async () => {
      await controller.current.handleComplete(formData, { paymentMethod: "blik" } as never);
    });

    expect(localStorage.getItem(accountKey)).toBeNull();
    expect(localStorage.getItem(publicKey)).toBe("public-draft");
  });

  it("keeps an account wallet processing result in the account terminal", () => {
    const scope = createAccountConfiguratorDraftScope("client-123", "pet-123");
    setConfiguratorFormData(formData, { scope, persist: false });
    const { controller, navigate } = setup(true);

    act(() => {
      controller.current.handleWalletSettled({
        kind: "processing",
        orderId: processingResult.orderId,
        orderRef: processingResult.orderRef,
        paymentIntentId: processingResult.paymentIntentId,
        clientId: processingResult.clientId,
      });
    });

    expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/konto\/zamowienie\/status\?/));
    expect(readAccountOrderReturn(processingResult.orderId)?.petId).toBe("pet-123");
  });

  it("does not strand a deterministic account wallet failure in the status terminal", () => {
    const scope = createAccountConfiguratorDraftScope("client-123", "pet-123");
    setConfiguratorFormData(formData, { scope, persist: false });
    sessionStorage.setItem(LEGACY_CHECKOUT_CONTINUATION_KEY, "stale-confirm-attempt");
    const { controller, navigate } = setup(true);

    act(() => {
      controller.current.handleWalletSettled({
        kind: "failed",
        reason: "technical",
        forceFailurePage: true,
        orderId: processingResult.orderId,
        orderRef: processingResult.orderRef,
        paymentIntentId: processingResult.paymentIntentId,
        clientId: processingResult.clientId,
      });
    });

    expect(navigate).toHaveBeenCalledWith("/konto?zamowienie=configurator&pet=pet-123");
    expect(navigate).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\/konto\/zamowienie\/status\?/),
    );
    expect(sessionStorage.getItem(LEGACY_CHECKOUT_CONTINUATION_KEY)).toBeNull();
    expect(bumpCheckoutPaymentAttempt).toHaveBeenCalledTimes(1);
    expect(bumpCheckoutPaymentAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      navigate.mock.invocationCallOrder[0],
    );
  });

  it("does not advance the account retry sequence for an ambiguous wallet technical failure", () => {
    const scope = createAccountConfiguratorDraftScope("client-123", "pet-123");
    setConfiguratorFormData(formData, { scope, persist: false });
    const { controller, navigate } = setup(true);

    act(() => {
      controller.current.handleWalletSettled({
        kind: "failed",
        reason: "technical",
        orderId: processingResult.orderId,
        orderRef: processingResult.orderRef,
        paymentIntentId: processingResult.paymentIntentId,
        clientId: processingResult.clientId,
      });
    });

    expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/konto\/zamowienie\/status\?/));
    expect(bumpCheckoutPaymentAttempt).not.toHaveBeenCalled();
  });

  it("keeps an account wallet pre-dispatch error on the live form and clears only its provisional marker", () => {
    sessionStorage.setItem(LEGACY_CHECKOUT_CONTINUATION_KEY, "provisional-wallet-confirmation");
    const { controller, navigate } = setup(true);

    act(() => {
      controller.current.handleWalletSettled({ kind: "retryable" });
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(LEGACY_CHECKOUT_CONTINUATION_KEY)).toBeNull();
    expect(bumpCheckoutPaymentAttempt).not.toHaveBeenCalled();
  });

  it("does not persist account form data when a changed price invalidates consent", async () => {
    const publicDraft = JSON.stringify({ untouched: "public-flow-draft" });
    localStorage.setItem("openlup:configurator:v1", publicDraft);
    submitCheckout.mockResolvedValue({ status: "price_changed" });
    const { controller } = setup(true);
    let thrown: unknown;

    await act(async () => {
      try {
        await controller.current.handleComplete(formData, { paymentMethod: "blik" } as never);
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toEqual(new Error("checkout:errors.priceChanged"));
    expect(localStorage.getItem("openlup:configurator:v1")).toBe(publicDraft);
  });

  it("keeps the public flow on the public payment page with no returnContext", async () => {
    submitCheckout.mockResolvedValue(processingResult);
    const { navigate, controller } = setup(false);

    await act(async () => {
      await controller.current.handleComplete(formData, { paymentMethod: "blik" } as never);
    });

    expect(submitCheckout.mock.calls[0][0]).not.toHaveProperty("returnContext");
    const calls = navigate.mock.calls;
    const navUrl = calls[calls.length - 1][0] as string;
    expect(navUrl.startsWith("/skomponuj-pakiet/platnosc")).toBe(true);
    expect(readAccountOrderReturn()).toBeNull();
  });
});
