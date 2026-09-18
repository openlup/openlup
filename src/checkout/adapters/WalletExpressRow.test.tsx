import type { ReactNode } from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { renderWithProviders } from "@/test/render";
import { WalletExpressRow } from "./WalletExpressRow";
import {
  LEGACY_CHECKOUT_CONTINUATION_KEY,
  readCheckoutContinuation,
} from "@/checkout/machine/checkoutNavigation";
import type { ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";

const KNOWN_COMPOSITION_SLUGS = ["lamb", "venison", "beef", "turkey", "salmon", "pork"] as const;

const mockConfirmPayment = vi.fn();
const mockSubmit = vi.fn();
const mockUseLiveQuote = vi.fn();
const mockStart = vi.fn();
const mockElementsOptions = vi.fn();
const mockElementsStripe = vi.fn();
const mockResolve = vi.fn();
const mockRetryStripeLoad = vi.fn();
let mockStripeLoaderState: {
  stripePromise: Promise<unknown> | null;
  status: "unconfigured" | "loading" | "ready" | "failed";
  retry: () => void;
};
let capturedOnConfirm: (() => Promise<void>) | null = null;

vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children, options, stripe }: { children: ReactNode; options: unknown; stripe: Promise<unknown> }) => {
    mockElementsOptions(options);
    mockElementsStripe(stripe);
    return <>{children}</>;
  },
  ExpressCheckoutElement: ({
    onReady,
    onConfirm,
    onClick,
  }: {
    onReady: (e: { availablePaymentMethods?: unknown }) => void;
    onConfirm: () => void;
    onClick?: (e: { resolve: () => void }) => void;
  }) => {
    capturedOnConfirm = onConfirm as () => Promise<void>;
    return (
      <div>
        <button type="button" onClick={() => onReady({ availablePaymentMethods: { applePay: true } })}>
          wallet-ready
        </button>
        <button type="button" onClick={() => onReady({ availablePaymentMethods: undefined })}>
          wallet-none
        </button>
        <button type="button" onClick={() => onClick?.({ resolve: mockResolve })}>
          wallet-click
        </button>
        <button type="button" onClick={() => onConfirm()}>
          wallet-confirm
        </button>
      </div>
    );
  },
  useStripe: () => ({ confirmPayment: mockConfirmPayment }),
  useElements: () => ({ submit: mockSubmit }),
}));
vi.mock("@/domains/payment/components/useStripePromise", () => ({
  useStripeLoader: () => mockStripeLoaderState,
}));
vi.mock("@/checkout/machine/useLiveQuote", () => ({ useLiveQuote: () => mockUseLiveQuote() }));
const reportCheckoutClientEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/telemetry/checkoutClientEvent", () => ({ reportCheckoutClientEvent }));
vi.mock("./stripeWalletCheckout", () => ({
  startStripeWalletCheckout: (...args: unknown[]) => mockStart(...args),
}));

const data = { recommendationSnapshot: null, lengthDays: 21, promoCodes: [] } as unknown as ConfiguratorFormData;

function row(onSettled = vi.fn(), returnPath = "/skomponuj-pakiet/platnosc", coveredCheckout = false) {
  return (
    <WalletExpressRow
      coveredCheckout={coveredCheckout}
      data={data}
      checkoutMode="subscription"
      onSettled={onSettled}
      knownCompositionSlugs={KNOWN_COMPOSITION_SLUGS}
      returnPath={returnPath}
    />
  );
}

function renderRow(onSettled = vi.fn(), returnPath = "/skomponuj-pakiet/platnosc") {
  renderWithProviders(row(onSettled, returnPath));
  return onSettled;
}

beforeEach(() => {
  mockConfirmPayment.mockReset().mockResolvedValue({});
  mockSubmit.mockReset().mockResolvedValue({});
  mockStart.mockReset();
  mockElementsOptions.mockReset();
  mockElementsStripe.mockReset();
  mockResolve.mockReset();
  mockRetryStripeLoad.mockReset();
  reportCheckoutClientEvent.mockReset();
  mockStripeLoaderState = {
    stripePromise: Promise.resolve({ id: "stripe-ready" }),
    status: "ready",
    retry: mockRetryStripeLoad,
  };
  capturedOnConfirm = null;
  mockUseLiveQuote
    .mockReset()
    .mockReturnValue({ loading: false, error: null, quote: { totalGross: { amountMinor: 12900, currency: "PLN" } } });
});

afterEach(() => vi.restoreAllMocks());

describe("WalletExpressRow", () => {
  it("surfaces a failed Stripe load and retry mounts Elements with a fresh promise", () => {
    const rejectedAttempt = Promise.resolve({ id: "timed-out-attempt" });
    mockStripeLoaderState = {
      stripePromise: rejectedAttempt,
      status: "failed",
      retry: mockRetryStripeLoad,
    };
    const rendered = renderWithProviders(row());

    expect(screen.getByTestId("wallet-stripe-load-failed")).toHaveTextContent(
      "Nie udało się wczytać formularza karty",
    );
    expect(screen.queryByText("wallet-confirm")).toBeNull();
    expect(mockElementsStripe).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("wallet-stripe-load-retry"));
    expect(mockRetryStripeLoad).toHaveBeenCalledTimes(1);

    const freshAttempt = Promise.resolve({ id: "stripe-after-retry" });
    mockStripeLoaderState = {
      stripePromise: freshAttempt,
      status: "ready",
      retry: mockRetryStripeLoad,
    };
    rendered.rerender(row());

    expect(screen.queryByTestId("wallet-stripe-load-failed")).toBeNull();
    expect(screen.getByText("wallet-confirm")).toBeInTheDocument();
    expect(mockElementsStripe).toHaveBeenCalledTimes(1);
    expect(mockElementsStripe.mock.calls[0]?.[0]).toBe(freshAttempt);
    expect(mockElementsStripe.mock.calls[0]?.[0]).not.toBe(rejectedAttempt);
  });

  it("pins deferred Elements to the same card payment-method contract as the PaymentIntent", () => {
    renderRow();

    expect(mockElementsOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        paymentMethodTypes: ["card"],
        setupFutureUsage: "off_session",
      }),
    );
  });

  it("reserves the row footprint with a skeleton while the live quote resolves", () => {
    mockUseLiveQuote.mockReturnValue({ loading: true, error: null, quote: null });
    renderRow();
    expect(screen.queryByText("wallet-confirm")).toBeNull();
    // Fixed-height placeholder instead of nothing — the wallet row must not
    // pop in later and shift the payment list (CLS on the money step).
    expect(screen.getByTestId("wallet-express-skeleton")).toBeInTheDocument();
  });

  it("collapses for good when the quote resolves without a usable total", () => {
    mockUseLiveQuote.mockReturnValue({ loading: false, error: "quote_failed", quote: null });
    renderRow();
    expect(screen.queryByText("wallet-confirm")).toBeNull();
    expect(screen.queryByTestId("wallet-express-skeleton")).toBeNull();
  });

  it("shows a skeleton while resolving, the button when available, and collapses when not", () => {
    renderRow();
    // Resolving: space reserved (skeleton visible, container NOT hidden).
    expect(screen.getByTestId("wallet-express-skeleton")).toBeInTheDocument();
    expect(screen.getByText("wallet-confirm").closest("div[hidden]")).toBeNull();
    // Wallet available: skeleton gone, button live.
    fireEvent.click(screen.getByText("wallet-ready"));
    expect(screen.queryByTestId("wallet-express-skeleton")).toBeNull();
    expect(screen.getByText("wallet-confirm").closest("div[hidden]")).toBeNull();
    // Confirmed no wallet on this device: one-time collapse.
    fireEvent.click(screen.getByText("wallet-none"));
    expect(screen.getByText("wallet-confirm").closest("div[hidden]")).not.toBeNull();
  });

  it("mints + confirms then settles as processing on success", async () => {
    mockStart.mockResolvedValue({
      kind: "confirm",
      clientSecret: "pi_secret",
      orderId: "o",
      orderRef: "order_x",
      paymentIntentId: "pi",
      clientId: "c",
      journeyId: "checkout:11111111-1111-4111-8111-111111111111",
    });
    const onSettled = renderRow();
    fireEvent.click(screen.getByText("wallet-click"));
    fireEvent.click(screen.getByText("wallet-confirm"));
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutQuoteExpectation: {
          totalGross: { amountMinor: 12900, currency: "PLN" },
        },
      }),
      expect.any(Object),
    );
    expect(mockConfirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        clientSecret: "pi_secret",
        confirmParams: {
          return_url:
            "http://localhost:3000/skomponuj-pakiet/platnosc?order=order_x&orderId=o&paymentIntentId=pi&clientId=c",
        },
        redirect: "if_required",
      }),
    );
    expect(mockResolve.mock.invocationCallOrder[0]).toBeLessThan(
      mockSubmit.mock.invocationCallOrder[0],
    );
    expect(mockSubmit.mock.invocationCallOrder[0]).toBeLessThan(
      mockStart.mock.invocationCallOrder[0],
    );
    expect(mockStart.mock.invocationCallOrder[0]).toBeLessThan(
      mockConfirmPayment.mock.invocationCallOrder[0],
    );
    // ⛔ THE falsifier for the immortal marker, at its only writer. This used to
    // land in a second sessionStorage key as four bare strings: no journey, no
    // action kind, no phase and — fatally — no expiry, which made
    // `isContinuationExpired` unconditionally false. It is now one marker in the
    // one key, and `expiresAt` is the field whose absence let the old one outlive
    // its order, its attempt and the reconciliation window.
    expect(readCheckoutContinuation()).toMatchObject({
      paymentIntentId: "pi",
      journeyId: "checkout:11111111-1111-4111-8111-111111111111",
      actionKind: "none",
      phase: "confirm_dispatched",
      expiresAt: expect.any(Number),
    });
    expect(sessionStorage.getItem(LEGACY_CHECKOUT_CONTINUATION_KEY)).toBeNull();
    expect(onSettled).toHaveBeenCalledWith({
      kind: "processing",
      orderId: "o",
      orderRef: "order_x",
      paymentIntentId: "pi",
      clientId: "c",
    });
  });

  it("uses the explicit account return path for a wallet confirmation", async () => {
    mockStart.mockResolvedValue({
      kind: "confirm",
      clientSecret: "pi_secret",
      orderId: "o",
      orderRef: "order_x",
      paymentIntentId: "pi",
      clientId: "c",
    });
    const onSettled = renderRow(vi.fn(), "/konto/zamowienie/status");

    fireEvent.click(screen.getByText("wallet-confirm"));

    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    const confirmOptions = mockConfirmPayment.mock.calls[0]?.[0] as {
      confirmParams: { return_url: string };
    };
    expect(new URL(confirmOptions.confirmParams.return_url).pathname).toBe("/konto/zamowienie/status");
  });

  it("keeps an Elements validation error inline and allows another wallet action", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSubmit.mockResolvedValue({
      error: { code: "validation_error", type: "validation_error", message: "wallet session failed" },
    });

    const onSettled = renderRow();
    fireEvent.click(screen.getByText("wallet-click"));
    fireEvent.click(screen.getByText("wallet-confirm"));

    await waitFor(() => expect(onSettled).toHaveBeenCalledWith({ kind: "retryable" }));
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockConfirmPayment).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Sprawdź swoje dane/i);
    expect(errorSpy).toHaveBeenCalledWith(
      "[wallet-express] wallet elements submit failed",
      expect.objectContaining({ code: "validation_error", type: "validation_error" }),
    );

    fireEvent.click(screen.getByText("wallet-confirm"));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(2));
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it("keeps an ambiguous wallet-start recovery inline for the idempotent next click", async () => {
    mockStart.mockResolvedValue({ kind: "retryable" });
    const onSettled = renderRow();

    fireEvent.click(screen.getByText("wallet-confirm"));

    await waitFor(() => expect(onSettled).toHaveBeenCalledWith({ kind: "retryable" }));
    expect(mockConfirmPayment).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Sprawdź swoje dane/i);
  });

  it("keeps a rejected Elements Promise inline and re-enables the wallet action", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSubmit.mockRejectedValue(new Error("wallet sheet dismissed"));
    const onSettled = renderRow();

    fireEvent.click(screen.getByText("wallet-click"));
    fireEvent.click(screen.getByText("wallet-confirm"));

    await waitFor(() => expect(onSettled).toHaveBeenCalledWith({ kind: "retryable" }));
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockConfirmPayment).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Sprawdź swoje dane/i);
    expect(errorSpy).toHaveBeenCalledWith(
      "[wallet-express] wallet checkout Promise rejected",
      expect.any(Error),
    );

    // A second explicit action reaches Elements again; the rejected Promise did
    // not leave the component in its busy state.
    fireEvent.click(screen.getByText("wallet-confirm"));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(2));
  });

  it("propagates the opaque v2 acceptance token into express-wallet checkout", async () => {
    mockUseLiveQuote.mockReturnValue({
      loading: false,
      error: null,
      quote: {
        totalGross: { amountMinor: 12900, currency: "PLN" },
        promotionAcceptanceToken: "opaque.signed-token",
      },
    });
    mockStart.mockResolvedValue({ kind: "unavailable" });
    renderRow();
    fireEvent.click(screen.getByText("wallet-confirm"));
    await waitFor(() => expect(mockStart).toHaveBeenCalled());
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutQuoteExpectation: expect.objectContaining({
          promotionAcceptanceToken: "opaque.signed-token",
        }),
      }),
      expect.any(Object),
    );
  });

  it("logs the Stripe error and settles failed with reason + order ids on confirm error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockStart.mockResolvedValue({
      kind: "confirm",
      clientSecret: "pi_secret",
      orderId: "o",
      orderRef: "order_x",
      paymentIntentId: "pi",
      clientId: "c",
    });
    mockConfirmPayment.mockResolvedValue({
      error: { code: "card_declined", decline_code: "generic_decline", type: "card_error", message: "declined" },
    });
    const onSettled = renderRow();
    fireEvent.click(screen.getByText("wallet-confirm"));
    await waitFor(() =>
      expect(onSettled).toHaveBeenCalledWith({
        kind: "failed",
        reason: "card_declined",
        forceFailurePage: true,
        orderRef: "order_x",
        orderId: "o",
        paymentIntentId: "pi",
        clientId: "c",
      }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[wallet-express] wallet confirmPayment failed",
      expect.objectContaining({ code: "card_declined", paymentIntentId: "pi" }),
    );
    // The router deliberately does NOT navigate for an issuer refusal, so this
    // row is the buyer's only feedback. Asserting the settlement alone let a
    // silent dead end ship: the notice was set on a branch refusals never take.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Bank nie autoryzował tej płatności",
    );
  });

  it("renders the in-place notice for an expired card, the other stay-in-place reason", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockStart.mockResolvedValue({
      kind: "confirm",
      clientSecret: "pi_secret",
      orderId: "o",
      orderRef: "order_x",
      paymentIntentId: "pi",
      clientId: "c",
    });
    mockConfirmPayment.mockResolvedValue({
      error: { code: "expired_card", type: "card_error", message: "expired" },
    });
    const onSettled = renderRow();
    fireEvent.click(screen.getByText("wallet-confirm"));
    await waitFor(() =>
      expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ reason: "expired" })),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Bank nie autoryzował tej płatności",
    );
  });

  it("keeps a retryable pre-dispatch Stripe contract error inline with retry copy instead of entering payment routing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockStart.mockResolvedValue({
      kind: "confirm",
      clientSecret: "pi_secret",
      orderId: "o",
      orderRef: "order_x",
      paymentIntentId: "pi",
      clientId: "c",
    });
    mockConfirmPayment.mockResolvedValue({
      error: {
        type: "invalid_request_error",
        code: "payment_intent_authentication_failure",
        message: "automatic payment methods cannot confirm a card-only intent",
      },
    });

    const onSettled = vi.fn();
    renderWithProviders(row(onSettled, "/skomponuj-pakiet/platnosc", true));
    fireEvent.click(screen.getByText("wallet-confirm"));

    await waitFor(() => expect(onSettled).toHaveBeenCalledWith({ kind: "retryable" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nie udało się rozpocząć płatności. Spróbuj ponownie za chwilę.");
  });

  it("uses authoritative status readback when a Stripe transport error has an ambiguous outcome", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockStart.mockResolvedValue({
      kind: "confirm",
      clientSecret: "pi_secret",
      orderId: "o",
      orderRef: "order_x",
      paymentIntentId: "pi",
      clientId: "c",
    });
    mockConfirmPayment.mockResolvedValue({
      error: { type: "api_connection_error", message: "connection interrupted" },
    });

    const onSettled = renderRow();
    fireEvent.click(screen.getByText("wallet-confirm"));

    await waitFor(() =>
      expect(onSettled).toHaveBeenCalledWith({
        kind: "failed",
        reason: "technical",
        orderRef: "order_x",
        orderId: "o",
        paymentIntentId: "pi",
        clientId: "c",
      }),
    );
  });

  it("settles a rejected Stripe confirmation Promise once with its minted context", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockStart.mockResolvedValue({
      kind: "confirm",
      clientSecret: "pi_secret",
      orderId: "o",
      orderRef: "order_x",
      paymentIntentId: "pi",
      clientId: "c",
    });
    mockConfirmPayment.mockRejectedValueOnce(new Error("Stripe transport interrupted"));
    const onSettled = renderRow();

    fireEvent.click(screen.getByText("wallet-confirm"));

    await waitFor(() =>
      expect(onSettled).toHaveBeenCalledWith({
        kind: "failed",
        reason: "technical",
        orderId: "o",
        orderRef: "order_x",
        paymentIntentId: "pi",
        clientId: "c",
      }),
    );
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[wallet-express] wallet checkout Promise rejected",
      expect.any(Error),
    );
  });

  it("maps an expired card to the expired reason", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockStart.mockResolvedValue({
      kind: "confirm",
      clientSecret: "pi_secret",
      orderId: "o",
      orderRef: "order_x",
      paymentIntentId: "pi",
      clientId: "c",
    });
    mockConfirmPayment.mockResolvedValue({ error: { code: "expired_card", message: "expired" } });
    const onSettled = renderRow();
    fireEvent.click(screen.getByText("wallet-confirm"));
    await waitFor(() =>
      expect(onSettled).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "failed", reason: "expired" }),
      ),
    );
  });

  it("logs the real error and settles failed when the mint throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bffError = new Error("boom");
    mockStart.mockRejectedValue(bffError);
    const onSettled = renderRow();
    fireEvent.click(screen.getByText("wallet-confirm"));
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith({ kind: "failed", reason: "technical" }));
    expect(errorSpy).toHaveBeenCalledWith("[wallet-express] checkout start failed", bffError);
    expect(mockConfirmPayment).not.toHaveBeenCalled();
  });

  it("shows the fix-your-details error and does not confirm when the intent is null (disabled)", async () => {
    mockStart.mockResolvedValue({ kind: "disabled" });
    const onSettled = renderRow();
    fireEvent.click(screen.getByText("wallet-ready"));
    fireEvent.click(screen.getByText("wallet-confirm"));
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith({ kind: "disabled" }));
    // Null intent mints no order and takes no payment: surface an actionable error
    // in place instead of letting the caller route to a false thank-you success.
    expect(await screen.findByText(/Uzupełnij brakujące dane/)).toHaveAttribute("role", "alert");
    expect(mockConfirmPayment).not.toHaveBeenCalled();
  });

  it("shows an explicit error and does not confirm when the selected subscription is unavailable", async () => {
    mockStart.mockResolvedValue({ kind: "subscription_unavailable" });
    const onSettled = renderRow();

    fireEvent.click(screen.getByText("wallet-ready"));
    fireEvent.click(screen.getByText("wallet-confirm"));

    expect(await screen.findByText(/Subskrypcja jest chwilowo niedostępna/)).toHaveAttribute(
      "role",
      "alert",
    );
    expect(onSettled).toHaveBeenCalledWith({ kind: "subscription_unavailable" });
    expect(mockConfirmPayment).not.toHaveBeenCalled();
  });

  it("stays on the wallet row when the current quote expectation is unavailable", async () => {
    mockStart.mockResolvedValue({ kind: "quote_unavailable" });
    const onSettled = renderRow();

    fireEvent.click(screen.getByText("wallet-confirm"));

    await screen.findByText(/Cena została zaktualizowana/);
    expect(onSettled).not.toHaveBeenCalled();
    expect(mockConfirmPayment).not.toHaveBeenCalled();
  });

  it("invalidates wallet consent without accepting the server amount on price change", async () => {
    mockStart.mockResolvedValue({ kind: "price_changed" });
    const onSettled = renderRow();

    fireEvent.click(screen.getByText("wallet-confirm"));

    await waitFor(() => expect(onSettled).toHaveBeenCalledWith({ kind: "price_changed" }));
    expect(mockConfirmPayment).not.toHaveBeenCalled();
  });

  it("opens the wallet sheet without minting an order before authorization", async () => {
    const onSettled = renderRow();

    fireEvent.click(screen.getByText("wallet-click"));
    await Promise.resolve();

    // A dismissed wallet sheet emits no confirm. Opening/dismissing it must not
    // leave an order or PaymentIntent that can never receive a payment method.
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockConfirmPayment).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("serializes duplicate provider confirm callbacks before React flushes state", async () => {
    let releaseSubmit: (() => void) | undefined;
    mockSubmit.mockImplementationOnce(() => new Promise((resolve) => {
      releaseSubmit = () => resolve({});
    }));
    mockStart.mockResolvedValue({
      kind: "confirm",
      clientSecret: "pi_secret",
      orderId: "o",
      orderRef: "order_x",
      paymentIntentId: "pi",
      clientId: "c",
    });
    const onSettled = renderRow();
    const onConfirm = capturedOnConfirm;
    expect(onConfirm).not.toBeNull();

    let firstConfirm: Promise<void> | undefined;
    let duplicateConfirm: Promise<void> | undefined;
    await act(async () => {
      firstConfirm = onConfirm?.();
      duplicateConfirm = onConfirm?.();
      await Promise.resolve();
    });

    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockConfirmPayment).not.toHaveBeenCalled();

    releaseSubmit?.();
    await act(async () => {
      await Promise.all([firstConfirm, duplicateConfirm]);
    });

    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockConfirmPayment).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("mints once after a confirmed wallet action passes Elements submission", async () => {
    mockStart.mockResolvedValue({
      kind: "confirm",
      clientSecret: "pi_secret",
      orderId: "o",
      orderRef: "order_x",
      paymentIntentId: "pi",
      clientId: "c",
    });
    const onSettled = renderRow();

    fireEvent.click(screen.getByText("wallet-click"));
    fireEvent.click(screen.getByText("wallet-confirm"));

    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(mockResolve.mock.invocationCallOrder[0]).toBeLessThan(
      mockSubmit.mock.invocationCallOrder[0],
    );
    expect(mockSubmit.mock.invocationCallOrder[0]).toBeLessThan(
      mockStart.mock.invocationCallOrder[0],
    );
    expect(mockStart.mock.invocationCallOrder[0]).toBeLessThan(
      mockConfirmPayment.mock.invocationCallOrder[0],
    );
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockConfirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: "pi_secret" }),
    );
    expect(onSettled).toHaveBeenCalledWith({
      kind: "processing",
      orderId: "o",
      orderRef: "order_x",
      paymentIntentId: "pi",
      clientId: "c",
    });
  });
  it("records whether the device actually offered a wallet", () => {
    // The decision is the device's, so the server cannot see it. Without this a
    // card dead end is indistinguishable from a buyer who never had a one-tap
    // route to take instead.
    renderRow();

    fireEvent.click(screen.getByText("wallet-ready"));
    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("payment_form", "wallet_row_shown");

    fireEvent.click(screen.getByText("wallet-none"));
    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("payment_form", "wallet_row_hidden");
  });
});


async function renderCoveredFixture(onSettled = vi.fn()) {
  const fixtureI18n = createInstance();
  await fixtureI18n.init({ lng: "xx", fallbackLng: false, resources: { xx: { checkout: {
    recoveryGuidance: { messages: { c09: "fixture status", c05a: "fixture card number help" } },
  } } } });
  return renderWithProviders(<I18nextProvider i18n={fixtureI18n}>{row(onSettled, "/status", true)}</I18nextProvider>);
}

describe("covered wallet checkout", () => {
  it("hands a refusal to authoritative status without permitting another confirm on the same mounted Elements", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockStart.mockResolvedValue({ kind: "confirm", clientSecret: "secret", orderId: "o", orderRef: "ref", paymentIntentId: "pi", clientId: "c", journeyId: "checkout:11111111-1111-4111-8111-111111111111" });
    mockConfirmPayment.mockResolvedValue({ error: { type: "card_error", code: "card_declined", message: "private provider prose" } });
    const onSettled = vi.fn();
    await renderCoveredFixture(onSettled);
    fireEvent.click(screen.getByText("wallet-confirm"));
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith({ kind: "processing", orderId: "o", orderRef: "ref", paymentIntentId: "pi", clientId: "c" }));
    expect(readCheckoutContinuation()).not.toBeNull();
    fireEvent.click(screen.getByText("wallet-confirm"));
    expect(mockConfirmPayment).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("private provider prose")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("shows translated local field validation without minting an order", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockSubmit.mockResolvedValue({ error: { type: "validation_error", code: "incomplete_number", message: "private provider prose" } });
    await renderCoveredFixture();
    fireEvent.click(screen.getByText("wallet-confirm"));
    expect(await screen.findByRole("alert")).toHaveTextContent("fixture card number help");
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockConfirmPayment).not.toHaveBeenCalled();
  });
  it("retains the existing language path when approved translations are absent", async () => {
    const isolatedI18n = createInstance();
    await isolatedI18n.init({ lng: "yy", fallbackLng: false, resources: { yy: { checkout: { errors: { paymentDeclinedCard: "fixture declined payment" } } } } });
      vi.spyOn(console, "error").mockImplementation(() => {});
      mockStart.mockResolvedValue({ kind: "confirm", clientSecret: "secret", orderId: "o", orderRef: "ref", paymentIntentId: "pi", clientId: "c", journeyId: "checkout:11111111-1111-4111-8111-111111111111" });
      mockConfirmPayment.mockResolvedValue({ error: { type: "card_error", code: "card_declined" } });
      const onSettled = vi.fn();
      renderWithProviders(<I18nextProvider i18n={isolatedI18n}>{row(onSettled, "/status", true)}</I18nextProvider>);
      fireEvent.click(screen.getByText("wallet-confirm"));
      await waitFor(() => expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ kind: "failed", reason: "card_declined" })));
      expect(await screen.findByRole("alert")).not.toHaveTextContent("recoveryGuidance");
      expect(screen.getByRole("alert")).toHaveTextContent("fixture declined payment");
  });
});
