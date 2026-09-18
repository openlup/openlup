import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { renderWithProviders } from "@/test/render";
import {
  SkomponujPakietStripePayPanel,
  type StripePayState,
} from "./SkomponujPakietStripePayPanel";
import {
  persistCheckoutContinuation,
  readCheckoutContinuation,
} from "@/checkout/machine/checkoutNavigation";

const mockStripeSettled = vi.fn();
const mockPollerTerminal = vi.fn();
const mockStripeReturnUrl = vi.fn();
const mockCheckoutCopy = vi.fn();

vi.mock("@/domains/payment/components/StripePaymentStep", () => ({
  StripePaymentStep: ({
    onSettled,
    onConfirmStart,
    returnUrl,
    coveredCheckout,
    copy,
  }: {
    onSettled: (status: "succeeded" | "failed") => void;
    onConfirmStart?: () => void;
    returnUrl: string;
    coveredCheckout?: boolean;
    copy?: { recoveryMessage?: (key: string) => string; loadFailed?: string; loadAlternative?: string };
  }) => {
    mockStripeReturnUrl(returnUrl);
    mockCheckoutCopy({ coveredCheckout, copy });
    return (
      <button
        type="button"
        onClick={() => {
          onConfirmStart?.();
          onSettled("succeeded");
        }}
      >
        confirm stripe
      </button>
    );
  },
}));

vi.mock("@/domains/payment/components/PaymentStatusPoller", () => ({
  PaymentStatusPoller: ({ onTerminal }: { onTerminal: (status: "paid") => void }) => (
    <button type="button" onClick={() => onTerminal("paid")}>
      poll paid
    </button>
  ),
}));


const FB_IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) [FBAN/FBIOS;FBAV/470.0.0.36.109]";
const REAL_UA = window.navigator.userAgent;

function stubUserAgent(value: string) {
  Object.defineProperty(window.navigator, "userAgent", { value, configurable: true });
}

describe("SkomponujPakietStripePayPanel", () => {
  beforeEach(() => {
    mockStripeSettled.mockClear();
    mockPollerTerminal.mockClear();
    mockStripeReturnUrl.mockClear();
    mockCheckoutCopy.mockClear();
    sessionStorage.clear();
  });

  afterEach(() => {
    stubUserAgent(REAL_UA);
  });

  it("renders Stripe confirmation before an authoritative status poll begins", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "confirm stripe" }));

    expect(mockStripeSettled).toHaveBeenCalledWith("succeeded");
    expect(mockPollerTerminal).not.toHaveBeenCalled();
  });

  it("hides Stripe confirmation while awaiting payment-control readback", () => {
    renderPanel({ awaitingWebhook: true });

    expect(screen.queryByRole("button", { name: "confirm stripe" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "poll paid" }));

    expect(mockPollerTerminal).toHaveBeenCalledWith("paid");
  });

  it("returns Stripe redirects to the payment-status poller with all identifiers", () => {
    renderPanel();

    const returnUrl = new URL(mockStripeReturnUrl.mock.calls[0]?.[0]);
    expect(returnUrl.pathname).toBe("/skomponuj-pakiet/platnosc");
    expect(returnUrl.searchParams.get("order")).toBe("order_44444444-4444-4444-8444-444444444444");
    expect(returnUrl.searchParams.get("orderId")).toBe("44444444-4444-4444-8444-444444444444");
    expect(returnUrl.searchParams.get("paymentIntentId")).toBe("55555555-5555-4555-8555-555555555555");
    expect(returnUrl.searchParams.get("clientId")).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("keeps account Stripe redirects in the account terminal", () => {
    renderPanel(undefined, "/konto/zamowienie/status");

    expect(new URL(mockStripeReturnUrl.mock.calls[0]?.[0]).pathname).toBe(
      "/konto/zamowienie/status",
    );
  });

  it("does NOT persist a resume marker just from rendering the card form", () => {
    // Regression for the phantom-unpaid-order bug: persisting on mount let a
    // buyer who refreshed BEFORE entering a card resume to /platnosc for a
    // PaymentIntent with no payment method, polling forever. A rendered-but-
    // unsubmitted card must leave NO marker.
    expect(readCheckoutContinuation()).toBeNull();

    renderPanel();

    expect(readCheckoutContinuation()).toBeNull();
  });

  it("mints NO marker from a card-form event", () => {
    // The card form is not a source of persistence authority. Only checkout
    // itself, holding the server's answer, may write a marker; a commit event
    // can move an existing one but must never conjure one. A marker minted here
    // would point at a PaymentIntent with no payment method — the first link of
    // the false-decline chain.
    renderPanel();

    expect(readCheckoutContinuation()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "confirm stripe" }));

    expect(readCheckoutContinuation()).toBeNull();
  });

  it("raises an existing marker to confirm_dispatched at card commit", () => {
    // The commit is the moment a payment can start existing, so it is the moment
    // the marker stops meaning "the server issued an action" and starts meaning
    // "the provider was called" — the phase a later refresh reads to decide
    // whether there is anything to wait on. The single-use clientSecret is not
    // part of the transition and never enters the marker.
    persistCheckoutContinuation({
      orderId: "44444444-4444-4444-8444-444444444444",
      orderRef: "order_44444444-4444-4444-8444-444444444444",
      paymentIntentId: "55555555-5555-4555-8555-555555555555",
      clientId: "11111111-1111-4111-8111-111111111111",
      journeyId: "checkout:66666666-6666-4666-8666-666666666666",
      actionKind: "embedded",
    });
    expect(readCheckoutContinuation()).toMatchObject({ phase: "action_issued" });

    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "confirm stripe" }));

    expect(readCheckoutContinuation()).toMatchObject({
      orderId: "44444444-4444-4444-8444-444444444444",
      paymentIntentId: "55555555-5555-4555-8555-555555555555",
      phase: "confirm_dispatched",
    });
    expect(JSON.stringify(readCheckoutContinuation())).not.toContain("pi_secret");
  });

  it("offers the way out of an embedded webview under the card form", () => {
    // Where the measured buyers were stuck: the card form is on screen, the
    // provider was never reached, and the browser itself is the reason.
    stubUserAgent(FB_IOS_UA);

    renderPanel();

    expect(screen.getByTestId("finish-in-browser")).toBeTruthy();
  });
});

function renderPanel(
  overridesForState?: Partial<StripePayState>,
  returnPath?: string,
) {
  return renderWithProviders(
    <SkomponujPakietStripePayPanel
      state={state(overridesForState)}
      onConfirmSettled={mockStripeSettled}
      onPollerTerminal={mockPollerTerminal}
      {...(returnPath ? { returnPath } : {})}
    />,
  );
}

function state(overrides: Partial<StripePayState> = {}): StripePayState {
  return {
    orderId: "44444444-4444-4444-8444-444444444444",
    orderRef: "order_44444444-4444-4444-8444-444444444444",
    paymentIntentId: "55555555-5555-4555-8555-555555555555",
    clientSecret: "pi_secret",
    clientId: "11111111-1111-4111-8111-111111111111",
    journeyId: "checkout:66666666-6666-4666-8666-666666666666",
    awaitingWebhook: false,
    ...overrides,
  };
}


it("opts in only with current-language guidance keys and avoids unavailable alternatives", async () => {
  const state: StripePayState = { orderId: "o", orderRef: "ref", paymentIntentId: "pi", clientId: "c", clientSecret: "secret", awaitingWebhook: false };
  const withGuidance = createInstance();
  await withGuidance.init({ lng: "xx", fallbackLng: false, resources: { xx: { checkout: {
    stripePay: { title: "fixture title", body: "fixture body" },
    recoveryGuidance: { messages: { c09: "fixture status", c13NoAlternative: "fixture load failure" } },
  } } } });
  const { rerender } = renderWithProviders(<I18nextProvider i18n={withGuidance}><SkomponujPakietStripePayPanel state={state} onConfirmSettled={vi.fn()} onPollerTerminal={vi.fn()} /></I18nextProvider>);
  expect(mockCheckoutCopy).toHaveBeenLastCalledWith(expect.objectContaining({ coveredCheckout: true,
    copy: expect.objectContaining({ loadFailed: "fixture load failure", loadAlternative: undefined }) }));
  const withoutGuidance = createInstance();
  await withoutGuidance.init({ lng: "yy", fallbackLng: false, resources: { yy: { checkout: { stripePay: {
    title: "legacy fixture title", body: "legacy fixture body", loadFailed: "legacy fixture load failure", loadAlternative: "legacy fixture alternative",
  } } } } });
  rerender(<I18nextProvider i18n={withoutGuidance}><SkomponujPakietStripePayPanel state={state} onConfirmSettled={vi.fn()} onPollerTerminal={vi.fn()} /></I18nextProvider>);
  expect(mockCheckoutCopy).toHaveBeenLastCalledWith(expect.objectContaining({ coveredCheckout: false,
    copy: expect.objectContaining({ recoveryMessage: undefined, loadFailed: "legacy fixture load failure" }) }));
});
