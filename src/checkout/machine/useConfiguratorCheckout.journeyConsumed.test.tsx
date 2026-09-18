import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const staleAttemptKey = "checkout:11111111-1111-4111-8111-111111111111";
const rotatedAttemptKey = "checkout:22222222-2222-4222-8222-222222222222";
const submitCheckout = vi.fn();
const clearCheckoutAttemptKey = vi.fn();
let attemptKeyCleared = false;

vi.mock("@/domains/commerce/commerceClient", () => ({
  submitCheckout: (...args: unknown[]) => submitCheckout(...args),
}));
vi.mock("./buildCheckoutIntent", () => ({
  buildCheckoutIntent: () => ({
    mode: "one_time",
    contact: { email: "anna@example.com" },
    idempotencyKey: "checkout:pending",
  }),
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
  // A consumed journey key survives in storage until cleared; the rotation
  // mints a fresh key only after clearCheckoutAttemptKey ran.
  getOrCreateCheckoutAttemptKey: () => (attemptKeyCleared ? rotatedAttemptKey : staleAttemptKey),
  readCheckoutPaymentAttempt: vi.fn(() => 2),
  clearCheckoutAttemptKey: (...args: unknown[]) => {
    attemptKeyCleared = true;
    return clearCheckoutAttemptKey(...args);
  },
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

import { BffClientError } from "@/lib/bff/client";
import { useConfiguratorCheckout } from "./useConfiguratorCheckout";
import type { ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import type { CheckoutResponse } from "@/domains/commerce/checkoutContracts";

/**
 * Line γ seam fixture: the composition vocabulary the composition root supplies in
 * production. Held here as plain data so the machine's tests exercise the seam without
 * importing the vertical's validation module.
 */
const KNOWN_COMPOSITION_SLUGS = ["lamb", "venison", "beef", "turkey", "salmon", "pork"] as const;

const PATHS = {
  thankYou: "/skomponuj-pakiet/dziekujemy",
  paymentFailed: "/skomponuj-pakiet/platnosc-nieudana",
  paymentPath: "/skomponuj-pakiet/platnosc",
};

const formData = {
  accountPetId: "pet-123",
  dogName: "Lida",
  subscription: false,
  paymentMethod: "blik",
  checkoutQuoteExpectation: {
    totalGross: { amountMinor: 18_774, currency: "PLN" },
  },
} as ConfiguratorFormData;

const processingResult: CheckoutResponse = {
  contractVersion: "commerce.checkout.v2",
  checkoutKind: "one_time",
  status: "processing",
  orderId: "33333333-3333-4333-8333-333333333333",
  orderRef: "order_33333333-3333-4333-8333-333333333333",
  paymentIntentId: "44444444-4444-4444-8444-444444444444",
  clientId: "55555555-5555-4555-8555-555555555555",
  providerPaymentId: "tpay_sim_44444444-4444-4444-8444-444444444444",
  clientAction: { kind: "none" },
};

function journeyConsumedError(): BffClientError {
  return new BffClientError(
    {
      code: "CONFLICT",
      message: "Checkout journey already completed",
      details: { feature: "checkout", stage: "start_runtime", reason: "journey_consumed" },
    },
    409,
  );
}

function providerInFlightError(): BffClientError {
  return new BffClientError(
    {
      code: "CONFLICT",
      message: "Provider attempt is already active",
      details: { reason: "provider_attempt_in_flight" },
    },
    409,
  );
}

function timeoutError(): BffClientError {
  return new BffClientError(
    {
      code: "UPSTREAM_UNAVAILABLE",
      message: "Checkout request timed out",
      details: { reason: "timeout" },
    },
    0,
  );
}

function stockUnavailableError(): BffClientError {
  return new BffClientError(
    {
      code: "CONFLICT",
      message: "A line is no longer available",
      details: { reason: "stock_unavailable" },
    },
    409,
  );
}

beforeEach(() => {
  submitCheckout.mockReset();
  clearCheckoutAttemptKey.mockReset();
  attemptKeyCleared = false;
  sessionStorage.clear();
  localStorage.clear();
});

function setup(accountMode = false) {
  const navigate = vi.fn();
  const onAccountOrderComplete = accountMode ? vi.fn() : undefined;
  const { result } = renderHook(() =>
    useConfiguratorCheckout({ knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS,
      navigate,
      lang: "pl",
      paths: {
        ...PATHS,
        ...(accountMode
          ? { accountStatusPath: "/konto/zamowienie/status", accountDashboardPath: "/konto" }
          : {}),
      },
      ...(onAccountOrderComplete ? { onAccountOrderComplete } : {}),
    }),
  );
  return { controller: result, navigate, onAccountOrderComplete };
}

async function completeAndCaptureError(
  controller: ReturnType<typeof setup>["controller"],
): Promise<unknown> {
  let thrown: unknown;
  await act(async () => {
    try {
      await controller.current.handleComplete(formData, { paymentMethod: "blik" } as never);
    } catch (error) {
      thrown = error;
    }
  });
  return thrown;
}

function expectRotatedRequest(request: Record<string, unknown>) {
  expect(request.intent).toMatchObject({ idempotencyKey: rotatedAttemptKey });
  expect(request.paymentAttemptSequence).toBeUndefined();
  expect(request.expectedQuote).toEqual(formData.checkoutQuoteExpectation);
}

describe("useConfiguratorCheckout consumed-journey rotation", () => {
  it.each([
    ["public", false, /^\/skomponuj-pakiet\/platnosc\?/],
    ["account", true, /^\/konto\/zamowienie\/status\?/],
  ])("rotates the %s journey and silently retries once on CONFLICT/journey_consumed", async (
    _host,
    accountMode,
    expectedPath,
  ) => {
    submitCheckout
      .mockRejectedValueOnce(journeyConsumedError())
      .mockResolvedValueOnce(processingResult);
    const { controller, navigate } = setup(accountMode);

    await act(async () => {
      await controller.current.handleComplete(formData, { paymentMethod: "blik" } as never);
    });

    expect(clearCheckoutAttemptKey).toHaveBeenCalledTimes(1);
    expect(submitCheckout).toHaveBeenCalledTimes(2);
    expect(submitCheckout.mock.calls[0]![0].intent.idempotencyKey).toBe(staleAttemptKey);
    const retryRequest = submitCheckout.mock.calls[1]![0];
    expectRotatedRequest(retryRequest);
    expect(retryRequest.returnContext).toBe(accountMode ? "account" : undefined);
    expect(navigate).toHaveBeenCalledWith(expect.stringMatching(expectedPath));
  });

  it("does not loop: a consumed-journey conflict on the retry surfaces as an error", async () => {
    submitCheckout
      .mockRejectedValueOnce(journeyConsumedError())
      .mockRejectedValueOnce(journeyConsumedError());
    const { controller } = setup();
    const thrown = await completeAndCaptureError(controller);

    expect(submitCheckout).toHaveBeenCalledTimes(2);
    expect(clearCheckoutAttemptKey).toHaveBeenCalledTimes(1);
    expect(thrown).toBeInstanceOf(BffClientError);
  });

  it("does not replay an explicit in-flight provider conflict after journey rotation", async () => {
    submitCheckout
      .mockRejectedValueOnce(journeyConsumedError())
      .mockRejectedValueOnce(providerInFlightError());
    const { controller, navigate } = setup();

    const thrown = await completeAndCaptureError(controller);

    expect(clearCheckoutAttemptKey).toHaveBeenCalledTimes(1);
    expect(submitCheckout).toHaveBeenCalledTimes(2);
    expectRotatedRequest(submitCheckout.mock.calls[1]![0]);
    expect(thrown).toEqual(new Error("checkout:errors.paymentInFlight"));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("maps a timeout after rotation through the normal ambiguous-submit readback", async () => {
    submitCheckout
      .mockRejectedValueOnce(journeyConsumedError())
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(processingResult);
    const { controller, navigate } = setup();

    await expect(completeAndCaptureError(controller)).resolves.toBeUndefined();

    expect(clearCheckoutAttemptKey).toHaveBeenCalledTimes(1);
    expect(submitCheckout).toHaveBeenCalledTimes(3);
    expectRotatedRequest(submitCheckout.mock.calls[1]![0]);
    expectRotatedRequest(submitCheckout.mock.calls[2]![0]);
    expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/skomponuj-pakiet\/platnosc\?/));
  });

  it("clears the freshly rotated journey when stock becomes unavailable", async () => {
    submitCheckout
      .mockRejectedValueOnce(journeyConsumedError())
      .mockRejectedValueOnce(stockUnavailableError());
    const { controller, navigate } = setup();

    await expect(completeAndCaptureError(controller)).resolves.toEqual(
      new Error("checkout:errors.stockUnavailable"),
    );

    expect(submitCheckout).toHaveBeenCalledTimes(2);
    expectRotatedRequest(submitCheckout.mock.calls[1]![0]);
    // First clear rotates a consumed key; second clear discards the new key
    // because the current package can no longer be purchased.
    expect(clearCheckoutAttemptKey).toHaveBeenCalledTimes(2);
    expect(navigate).not.toHaveBeenCalled();
  });
});
