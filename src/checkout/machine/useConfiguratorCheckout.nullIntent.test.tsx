import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A null checkout intent (empty flavors, invalid weight, non-checkoutable/
// stock-bounded recommendation, schema mismatch) and a "checkout disabled" BFF
// error both used to bounce the card/BLIK submit to the thank-you page — a false
// success, because no order was created and no payment taken. Both must now
// surface an in-place error and keep the shopper on the form.

let buildIntentResult: unknown = null;
const submitCheckout = vi.fn();

vi.mock("@/domains/commerce/commerceClient", () => ({
  submitCheckout: (...args: unknown[]) => submitCheckout(...args),
}));
vi.mock("./buildCheckoutIntent", () => ({
  buildCheckoutIntent: () => buildIntentResult,
}));
vi.mock("./checkoutInvoicePreference", () => ({
  buildCheckoutInvoicePreference: () => undefined,
}));
vi.mock("@/checkout/adapters/tpayCheckoutRequestOptions", () => ({
  checkoutRequestOptionsForTpay: async () => ({}),
}));
vi.mock("./checkoutAttemptStore", () => ({
  getOrCreateCheckoutAttemptKey: () => "checkout:11111111-1111-4111-8111-111111111111",
  readCheckoutPaymentAttempt: vi.fn(() => 0),
  clearCheckoutAttemptKey: vi.fn(),
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
import type { TpayCheckoutDraft } from "@/checkout/adapters/tpayCheckoutDraft";

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

const validIntent = {
  mode: "one_time",
  contact: { email: "anna@example.com" },
  idempotencyKey: "checkout:pending",
};

const formData = {
  dogName: "Lida",
  subscription: false,
  paymentMethod: "blik",
  checkoutQuoteExpectation: {
    totalGross: { amountMinor: 18_774, currency: "PLN" },
  },
} as ConfiguratorFormData;
const validBlikDraft: TpayCheckoutDraft = {
  blikToken: "123456",
  blikBankId: "",
  pblChannelId: "",
  savedMethodId: "",
};

function setup() {
  const navigate = vi.fn();
  const { result } = renderHook(() =>
    useConfiguratorCheckout({ knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, navigate, lang: "pl", paths: PATHS }),
  );
  return { controller: result, navigate };
}

async function completeAndCaptureError(
  controller: ReturnType<typeof setup>["controller"],
  data = formData,
  tpayDraft = validBlikDraft,
) {
  let thrown: unknown;
  await act(async () => {
    try {
      await controller.current.handleComplete(data, tpayDraft);
    } catch (error) {
      thrown = error;
    }
  });
  return thrown;
}

function checkoutDisabledError(): BffClientError {
  return new BffClientError(
    {
      code: "UPSTREAM_UNAVAILABLE",
      message: "Checkout is disabled",
      details: { reason: "feature_flag_disabled" },
    },
    503,
  );
}

beforeEach(() => {
  submitCheckout.mockReset();
  buildIntentResult = null;
  sessionStorage.clear();
  localStorage.clear();
});

describe("useConfiguratorCheckout null-intent / disabled false-success", () => {
  it("does NOT route to thank-you when the intent is null; surfaces an error and never submits", async () => {
    buildIntentResult = null;
    const { controller, navigate } = setup();

    const thrown = await completeAndCaptureError(controller);

    expect(thrown).toEqual(new Error("checkout:errors.detailsIncomplete"));
    expect(navigate).not.toHaveBeenCalled();
    // No order should be minted for a null intent.
    expect(submitCheckout).not.toHaveBeenCalled();
  });

  it("does NOT route to thank-you when the checkout endpoint reports itself disabled", async () => {
    buildIntentResult = validIntent;
    submitCheckout.mockRejectedValueOnce(checkoutDisabledError());
    const { controller, navigate } = setup();

    const thrown = await completeAndCaptureError(controller);

    expect(thrown).toEqual(new Error("checkout:errors.detailsIncomplete"));
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each<[string, ConfiguratorFormData["paymentMethod"], TpayCheckoutDraft]>([
    ["missing method", null, validBlikDraft],
    ["malformed BLIK", "blik", { ...validBlikDraft, blikToken: "12ab" }],
    ["invalid PBL channel", "transfer", { ...validBlikDraft, blikToken: "", pblChannelId: "bad channel!" }],
  ])("fails closed before submit for %s", async (_label, paymentMethod, tpayDraft) => {
    buildIntentResult = validIntent;
    const { controller, navigate } = setup();

    const thrown = await completeAndCaptureError(
      controller,
      { ...formData, paymentMethod },
      tpayDraft,
    );

    expect(thrown).toEqual(new Error("checkout:errors.detailsIncomplete"));
    expect(navigate).not.toHaveBeenCalled();
    expect(submitCheckout).not.toHaveBeenCalled();
  });
});
