import { useEffect } from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { PaymentForm } from "./PaymentForm";
import { STRIPE_LOAD_TIMEOUT_MS } from "./useStripePromise";

const { mockConfirmPayment, handshake } = vi.hoisted(() => ({
  mockConfirmPayment: vi.fn(),
  // Whether the Elements handshake has completed. Every case but the
  // never-completes one leaves it `true`, which is the pre-existing behaviour.
  //
  // `elementPaints` is the SECOND, independent axis, and the mock has to model
  // it or these tests cannot see the defect they were written for: the real
  // provider hands over an `elements` object immediately and paints its fields
  // later, so a mock that reports both at once would keep asserting a button is
  // live at a moment the buyer has nothing to type into.
  handshake: { completed: true, elementPaints: true, elementFailsToLoad: false },
}));

vi.mock("@stripe/react-stripe-js", () => ({
  PaymentElement: ({ onReady, onLoadError }: {
    onReady?: () => void;
    onLoadError?: () => void;
  }) => {
    // In an effect, not during render: the real callback arrives after mount,
    // and firing it inline would hide any ordering bug in the component.
    useEffect(() => {
      // Readiness is gated on `completed` too, because the real element lives
      // inside `<Elements>`: with no provider object there is nothing for it to
      // mount against, so it can never report itself ready. Letting the mock
      // paint without a handshake would make the never-completes cases pass for
      // healthy.
      if (handshake.elementFailsToLoad) onLoadError?.();
      else if (handshake.completed && handshake.elementPaints) onReady?.();
      // Empty deps ON PURPOSE: the real element reports readiness or failure
      // ONCE. The component passes inline arrows, so a dependency on them would
      // re-fire the callback on every re-render the callback itself caused —
      // making the mock, not the component, the source of duplicate reports.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="payment-element" />;
  },
  useElements: () => (handshake.completed ? { id: "elements" } : null),
  useStripe: () => (handshake.completed ? { confirmPayment: mockConfirmPayment } : null),
}));

const reportCheckoutClientEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/telemetry/checkoutClientEvent", () => ({ reportCheckoutClientEvent }));

beforeEach(() => {
  reportCheckoutClientEvent.mockReset();
});

afterEach(() => {
  handshake.completed = true;
  handshake.elementPaints = true;
  handshake.elementFailsToLoad = false;
  vi.useRealTimers();
});

describe("PaymentForm", () => {
  it("confirms Stripe payment with the supplied return URL and settles inline success", async () => {
    const onSettled = vi.fn();
    mockConfirmPayment.mockResolvedValue({
      paymentIntent: { status: "succeeded" },
    });

    renderWithProviders(
      <PaymentForm
        returnUrl="https://preview.example/skomponuj-pakiet/platnosc?order=o&orderId=1&paymentIntentId=2&clientId=3"
        onSettled={onSettled}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Zapłać" }));

    await waitFor(() => expect(onSettled).toHaveBeenCalledWith("succeeded"));
    expect(mockConfirmPayment).toHaveBeenCalledWith({
      elements: { id: "elements" },
      confirmParams: {
        return_url: "https://preview.example/skomponuj-pakiet/platnosc?order=o&orderId=1&paymentIntentId=2&clientId=3",
      },
      redirect: "if_required",
    });
  });

  it("fires onConfirmStart on submit (not on render) — before confirmPayment", async () => {
    const onConfirmStart = vi.fn();
    const onSettled = vi.fn();
    mockConfirmPayment.mockImplementation(() => {
      // The resume marker must already be persisted by the time the payment
      // actually goes to Stripe — guarding the in-flight refresh window.
      expect(onConfirmStart).toHaveBeenCalledTimes(1);
      return Promise.resolve({ paymentIntent: { status: "succeeded" } });
    });

    renderWithProviders(
      <PaymentForm returnUrl="https://preview.example/return" onSettled={onSettled} onConfirmStart={onConfirmStart} />,
    );

    // Rendering the card form must NOT arm resume.
    expect(onConfirmStart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Zapłać" }));

    await waitFor(() => expect(onSettled).toHaveBeenCalledWith("succeeded"));
    expect(onConfirmStart).toHaveBeenCalledTimes(1);
  });

  it("recovers from a rejected Stripe Promise with one visible unknown settlement", async () => {
    const onSettled = vi.fn();
    mockConfirmPayment.mockRejectedValue(new Error("Stripe transport interrupted"));

    renderWithProviders(
      <PaymentForm returnUrl="https://preview.example/return" onSettled={onSettled} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Zapłać" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Wystąpił błąd płatności.");
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith("unknown");
    await waitFor(() => expect(screen.getByRole("button", { name: "Zapłać" })).toBeEnabled());
  });

  it.each(["api_connection_error", "api_error"])(
    "treats a resolved Stripe %s error as an unknown outcome",
    async (type) => {
      const onSettled = vi.fn();
      mockConfirmPayment.mockResolvedValue({ error: { type, message: "network interrupted" } });

      renderWithProviders(
        <PaymentForm returnUrl="https://preview.example/return" onSettled={onSettled} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Zapłać" }));

      await waitFor(() => expect(onSettled).toHaveBeenCalledWith("unknown"));
      expect(onSettled).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a resolved deterministic card error as a retryable failure", async () => {
    const onSettled = vi.fn();
    mockConfirmPayment.mockResolvedValue({
      error: { type: "card_error", code: "card_declined", message: "declined" },
    });

    renderWithProviders(
      <PaymentForm returnUrl="https://preview.example/return" onSettled={onSettled} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Zapłać" }));

    await waitFor(() => expect(onSettled).toHaveBeenCalledWith("failed"));
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it.each(["validation_error", "invalid_request_error", "authentication_error", "rate_limit_error"])(
    "keeps local Stripe %s in the form instead of entering terminal payment routing",
    async (type) => {
      const onSettled = vi.fn();
      mockConfirmPayment.mockResolvedValue({
        error: { type, message: "Missing payment details" },
      });

      renderWithProviders(
        <PaymentForm returnUrl="https://preview.example/return" onSettled={onSettled} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Zapłać" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Missing payment details");
      await waitFor(() => expect(screen.getByRole("button", { name: "Zapłać" })).toBeEnabled());
      expect(onSettled).toHaveBeenCalledWith("retryable");
      expect(onSettled).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["idempotency_error", undefined, "future_provider_error"])(
    "treats Stripe error type %s as ambiguous rather than exposing terminal retry",
    async (type) => {
      const onSettled = vi.fn();
      mockConfirmPayment.mockResolvedValue({
        error: { type, message: "Retry later" },
      });

      renderWithProviders(
        <PaymentForm returnUrl="https://preview.example/return" onSettled={onSettled} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Zapłać" }));

      await waitFor(() => expect(onSettled).toHaveBeenCalledWith("unknown"));
      expect(onSettled).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["succeeded", "processing", "requires_action", "requires_capture"]) (
    "keeps Stripe payment-intent status %s on the authoritative polling path",
    async (status) => {
      const onSettled = vi.fn();
      mockConfirmPayment.mockResolvedValue({ paymentIntent: { status } });

      renderWithProviders(
        <PaymentForm returnUrl="https://preview.example/return" onSettled={onSettled} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Zapłać" }));

      await waitFor(() => expect(onSettled).toHaveBeenCalledWith("succeeded"));
      expect(onSettled).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["canceled", "requires_payment_method", "requires_confirmation"]) (
    "classifies Stripe payment-intent status %s as a deterministic retryable failure",
    async (status) => {
      const onSettled = vi.fn();
      mockConfirmPayment.mockResolvedValue({ paymentIntent: { status } });

      renderWithProviders(
        <PaymentForm returnUrl="https://preview.example/return" onSettled={onSettled} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Zapłać" }));

      await waitFor(() => expect(onSettled).toHaveBeenCalledWith("failed"));
      expect(onSettled).toHaveBeenCalledTimes(1);
    },
  );

  it.each([null, "future_provider_status"]) (
    "treats absent or unfamiliar Stripe payment-intent status %s as ambiguous",
    async (status) => {
      const onSettled = vi.fn();
      mockConfirmPayment.mockResolvedValue({ paymentIntent: { status } });

      renderWithProviders(
        <PaymentForm returnUrl="https://preview.example/return" onSettled={onSettled} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Zapłać" }));

      await waitFor(() => expect(onSettled).toHaveBeenCalledWith("unknown"));
      expect(onSettled).toHaveBeenCalledTimes(1);
    },
  );

  // A handshake that never completes used to render as a greyed button and
  // nothing else, indefinitely — the exact dead end reported from an in-app
  // webview on 2026-08-26.
  it("explains a handshake that never completes instead of leaving a mute disabled button", () => {
    vi.useFakeTimers();
    handshake.completed = false;

    renderWithProviders(
      <PaymentForm
        returnUrl="https://preview.example/return"
        onSettled={vi.fn()}
        copy={{
          payButton: "Zapłać",
          payingButton: "Przetwarzanie…",
          errorPrefix: "Płatność odrzucona",
          loadFailed: "Nie udało się wczytać formularza karty.",
          loadAlternative: "Możesz też zapłacić inaczej.",
        }}
      />,
    );

    expect(screen.queryByTestId("payment-form-not-ready")).toBeNull();

    act(() => { vi.advanceTimersByTime(STRIPE_LOAD_TIMEOUT_MS + 1); });

    const alert = screen.getByTestId("payment-form-not-ready");
    expect(alert.textContent).toContain("Nie udało się wczytać formularza karty.");
    expect(alert.textContent).toContain("Możesz też zapłacić inaczej.");
    expect(screen.getByRole("button", { name: "Zapłać" })).toBeDisabled();
  });

  // P6: the sentence the buyer reads and the line we keep are the same event, so
  // they cannot drift apart.
  it("reports the never-completing handshake at the moment it says so on screen", () => {
    vi.useFakeTimers();
    handshake.completed = false;

    renderWithProviders(
      <PaymentForm returnUrl="https://preview.example/return" onSettled={vi.fn()} />,
    );

    expect(reportCheckoutClientEvent).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(STRIPE_LOAD_TIMEOUT_MS + 1); });

    expect(screen.getByTestId("payment-form-not-ready")).toBeInTheDocument();
    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("payment_form", "payment_element_not_ready");
    expect(reportCheckoutClientEvent).toHaveBeenCalledTimes(1);
  });

  it("reports readiness, and no dead end, when the handshake completes", () => {
    // ⛔ This used to assert SILENCE on a healthy handshake. A healthy step is now
    // a positive fact instead: nine card checkouts died on 2026-09-02 without one
    // of them reaching the provider, and "the fields painted" is the first
    // bracket around that seam. The dead-end codes must still be absent, which is
    // what the call count pins.
    vi.useFakeTimers();

    renderWithProviders(
      <PaymentForm returnUrl="https://preview.example/return" onSettled={vi.fn()} />,
    );
    act(() => { vi.advanceTimersByTime(STRIPE_LOAD_TIMEOUT_MS + 1); });

    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("payment_form", "element_ready");
    expect(reportCheckoutClientEvent).toHaveBeenCalledTimes(1);
  });

  it("records the confirm call BEFORE dispatching it, and what it came back with", async () => {
    // Ordering is the whole point: a `confirm_started` with no
    // `confirm_returned_*` after it is the shape of a call that never returned,
    // and that distinction only exists if the report precedes the dispatch.
    const order: string[] = [];
    reportCheckoutClientEvent.mockImplementation((_stage: string, code: string) => {
      order.push(`report:${code}`);
    });
    mockConfirmPayment.mockImplementation(() => {
      order.push("confirmPayment");
      return Promise.resolve({ paymentIntent: { status: "succeeded" } });
    });

    renderWithProviders(
      <PaymentForm returnUrl="https://preview.example/return" onSettled={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Zapłać" }));

    await waitFor(() => expect(order).toContain("report:confirm_returned_status"));
    expect(order).toEqual([
      "report:element_ready",
      "report:confirm_started",
      "confirmPayment",
      "report:confirm_returned_status",
    ]);
  });

  it("counts a tap that lands on the disabled pay button", async () => {
    // A disabled control fires no event at all, so "I pressed pay and nothing
    // happened" was a claim we could neither confirm nor refute.
    handshake.elementPaints = false;

    renderWithProviders(
      <PaymentForm returnUrl="https://preview.example/return" onSettled={vi.fn()} />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Zapłać" }));

    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("payment_form", "submit_disabled_tap");
  });
});

// WHY THE BUYER LEFT — the question the 2026-08-27 card report could not answer,
// because nothing recorded the difference between a closed tab and a back press.
//
// ⛔ THE GUARD IS THE FEATURE. `pagehide` fires on every departure, including a
// 3DS bounce and a completed purchase, so the tests that matter most here are the
// SILENCE ones: an abandonment code that fires after a successful payment is
// worse than no code at all, because it would be muted within a day.
describe("PaymentForm departure reporting", () => {
  const departures = () =>
    reportCheckoutClientEvent.mock.calls.filter(([, code]) =>
      code === "payment_step_abandoned" || code === "payment_step_exited_back");

  function renderPanel() {
    renderWithProviders(
      <PaymentForm returnUrl="https://preview.example/return" onSettled={vi.fn()} />,
    );
  }

  it("reports abandonment when the document goes away before a card is committed", () => {
    renderPanel();
    fireEvent(window, new Event("pagehide"));
    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("payment_form", "payment_step_abandoned");
  });

  it("re-arms departure reporting after Stripe proves confirmation was not dispatched", async () => {
    mockConfirmPayment.mockResolvedValue({
      error: { type: "validation_error", message: "Missing payment details" },
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Zapłać" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Zapłać" })).toBeEnabled());
    fireEvent(window, new Event("pagehide"));

    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("payment_form", "payment_step_abandoned");
  });

  it("keeps departure muted for an ambiguous Stripe API outcome", async () => {
    mockConfirmPayment.mockResolvedValue({
      error: { type: "api_connection_error", message: "Provider response lost" },
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Zapłać" }));
    await waitFor(() => expect(mockConfirmPayment).toHaveBeenCalled());
    fireEvent(window, new Event("pagehide"));

    expect(departures()).toHaveLength(0);
  });

  it("reports a backwards exit when history moves without unloading the document", () => {
    renderPanel();
    fireEvent(window, new Event("popstate"));
    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("payment_form", "payment_step_exited_back");
  });

  // `visibilitychange` is the half that fires in a mobile webview, and it fires
  // in BOTH directions — coming back to the tab is not a departure.
  it("reports on becoming hidden and says nothing on becoming visible", () => {
    renderPanel();
    const setVisibility = (state: DocumentVisibilityState) =>
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });

    setVisibility("visible");
    fireEvent(document, new Event("visibilitychange"));
    expect(departures()).toHaveLength(0);

    setVisibility("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("payment_form", "payment_step_abandoned");
    setVisibility("visible");
  });

  // ⛔ The load-bearing silence: a 3DS redirect and a finished purchase both
  // leave this page, and neither is an abandonment.
  it("says nothing about departure once the buyer has committed a card", async () => {
    mockConfirmPayment.mockResolvedValue({ paymentIntent: { status: "requires_action" } });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Zapłać" }));
    await waitFor(() => expect(mockConfirmPayment).toHaveBeenCalled());

    fireEvent(window, new Event("pagehide"));
    fireEvent(window, new Event("popstate"));
    expect(departures()).toHaveLength(0);
  });

  // The one branch where the browser has no answer at all: no error object, no
  // intent, nothing for the server to reconcile from.
  it("reports a confirmation that came back with nothing", async () => {
    const onSettled = vi.fn();
    mockConfirmPayment.mockRejectedValue(new Error("sheet vanished"));
    renderWithProviders(
      <PaymentForm returnUrl="https://preview.example/return" onSettled={onSettled} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Zapłać" }));

    await waitFor(() => expect(onSettled).toHaveBeenCalledWith("unknown"));
    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("payment_form", "psp_confirm_no_response");
  });

  it("leaves no listener behind after the panel unmounts", () => {
    const { unmount } = renderWithProviders(
      <PaymentForm returnUrl="https://preview.example/return" onSettled={vi.fn()} />,
    );
    unmount();
    fireEvent(window, new Event("pagehide"));
    fireEvent(window, new Event("popstate"));
    expect(departures()).toHaveLength(0);
  });
});

// G3 + G3b: THE PANEL USED TO LIE ABOUT BEING READY.
//
// On a warm provider script `elementsReady` is true on the first render, long
// before the payment iframe paints. Everything was keyed off it, so the buyer got
// a live "Zapłać" button over an empty box, no feedback at all while the fields
// loaded, and a panel that grew ~224px when they arrived — moving the button out
// from under a click already in flight. That last one is measured: it swallowed
// the first click in 4 of 5 subscription e2e runs.
describe("PaymentForm readiness feedback", () => {
  const payButton = () => screen.getByRole("button", { name: "Zapłać" });

  function renderUnpainted() {
    handshake.elementPaints = false;
    renderWithProviders(
      <PaymentForm returnUrl="https://preview.example/return" onSettled={vi.fn()} />,
    );
  }

  // ⛔ The regression guard for the swallowed click. `elementsReady` is TRUE in
  // this state (the mock's useStripe/useElements both answer), so a button gated
  // on it would be enabled here — which is exactly the bug.
  it("keeps the pay button disabled until the provider reports the fields painted", () => {
    renderUnpainted();
    expect(payButton()).toBeDisabled();
  });

  it("enables the pay button once the fields are painted", async () => {
    renderWithProviders(
      <PaymentForm returnUrl="https://preview.example/return" onSettled={vi.fn()} />,
    );
    await waitFor(() => expect(payButton()).toBeEnabled());
  });

  // The height reservation IS the layout fix: it holds the panel's size steady
  // so the button cannot move when the iframe paints.
  it("reserves the payment field height while the fields are still loading", () => {
    renderUnpainted();
    const placeholder = screen.getByTestId("payment-form-placeholder");
    expect(placeholder.className).toContain("h-[264px]");
    expect(placeholder).toHaveAttribute("aria-hidden", "true");
  });

  it("collapses the reservation once the fields are painted", async () => {
    renderWithProviders(
      <PaymentForm returnUrl="https://preview.example/return" onSettled={vi.fn()} />,
    );
    await waitFor(() =>
      expect(screen.queryByTestId("payment-form-placeholder")).not.toBeInTheDocument());
  });

  // Silence above a dead button is what the webview report was made of.
  it("tells the buyer the form is loading, in a live region", () => {
    renderUnpainted();
    const status = screen.getByTestId("payment-form-loading");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status.textContent).toContain("Wczytujemy bezpieczny formularz płatności");
  });

  it("stops saying it is loading once the fields are painted", async () => {
    renderWithProviders(
      <PaymentForm returnUrl="https://preview.example/return" onSettled={vi.fn()} />,
    );
    await waitFor(() =>
      expect(screen.queryByTestId("payment-form-loading")).not.toBeInTheDocument());
  });

  // The host owns every word this domain renders; the fallback only covers a
  // caller that has not been updated yet.
  it("prefers the host's loading copy over the fallback", () => {
    handshake.elementPaints = false;
    renderWithProviders(
      <PaymentForm
        returnUrl="https://preview.example/return"
        onSettled={vi.fn()}
        copy={{
          payButton: "Zapłać",
          payingButton: "…",
          errorPrefix: "Błąd",
          loading: "Ładujemy pole karty",
        }}
      />,
    );
    expect(screen.getByTestId("payment-form-loading").textContent).toBe("Ładujemy pole karty");
  });

  // onLoadError is the timeout's failure arriving early and named. It reuses the
  // EXISTING code: from the buyer's side "the fields never became usable" is one
  // state however it was reached.
  it("reports a load error immediately, without waiting out the timeout", () => {
    handshake.elementFailsToLoad = true;
    renderWithProviders(
      <PaymentForm returnUrl="https://preview.example/return" onSettled={vi.fn()} />,
    );

    expect(screen.getByTestId("payment-form-not-ready")).toBeInTheDocument();
    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("payment_form", "payment_element_not_ready");
    expect(reportCheckoutClientEvent).toHaveBeenCalledTimes(1);
    expect(payButton()).toBeDisabled();
    // No loading reassurance once we know it failed — the two must not both show.
    expect(screen.queryByTestId("payment-form-loading")).not.toBeInTheDocument();
  });

  // ⛔ The timer now measures the right thing. Against `elementsReady` it was
  // cancelled on the first render of a warm script, so the state it exists to
  // report could never reach the buyer or the drain.
  it("still reports the fields never painting even though the SDK handshake succeeded", () => {
    vi.useFakeTimers();
    handshake.elementPaints = false;
    renderWithProviders(
      <PaymentForm returnUrl="https://preview.example/return" onSettled={vi.fn()} />,
    );

    expect(reportCheckoutClientEvent).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(STRIPE_LOAD_TIMEOUT_MS + 1); });

    expect(screen.getByTestId("payment-form-not-ready")).toBeInTheDocument();
    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("payment_form", "payment_element_not_ready");
  });
});


describe("covered checkout confirmation", () => {
  const copy = { payButton: "Pay", payingButton: "Waiting", errorPrefix: "Error", recoveryMessage: (key: string) => key };
  it("uses curated field copy and keeps proven local correction retryable", async () => {
    mockConfirmPayment.mockResolvedValue({ error: { type: "validation_error", code: "incomplete_cvc", message: "private provider prose" } });
    const onSettled = vi.fn();
    renderWithProviders(<PaymentForm coveredCheckout copy={copy} returnUrl="https://example.test/return" onSettled={onSettled} />);
    fireEvent.click(screen.getByRole("button", { name: "Pay" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("checkout:recoveryGuidance.messages.c05b");
    expect(screen.queryByText("private provider prose")).toBeNull();
    expect(onSettled).toHaveBeenCalledWith("retryable");
    expect(screen.getByRole("button", { name: "Pay" })).toBeEnabled();
  });
  it("maps the observed cancelled-3DS Stripe result to retry copy through the live form composition", async () => {
    mockConfirmPayment.mockResolvedValue({
      error: {
        type: "invalid_request_error",
        code: "payment_intent_authentication_failure",
        message: "private provider prose",
      },
    });
    const onSettled = vi.fn();
    renderWithProviders(<PaymentForm coveredCheckout copy={copy} returnUrl="https://example.test/return" onSettled={onSettled} />);

    fireEvent.click(screen.getByRole("button", { name: "Pay" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("checkout:recoveryGuidance.messages.c17");
    expect(screen.queryByText("private provider prose")).toBeNull();
    expect(onSettled).toHaveBeenCalledWith("retryable");
    expect(screen.getByRole("button", { name: "Pay" })).toBeEnabled();
  });
  it.each(["card_error", "api_error"])("locks the mounted form after %s until its parent admits a fresh attempt", async (type) => {
    mockConfirmPayment.mockReset().mockResolvedValue({ error: { type, code: "unrecognized", message: "private provider prose" } });
    const onSettled = vi.fn();
    renderWithProviders(<PaymentForm coveredCheckout copy={copy} returnUrl="https://example.test/return" onSettled={onSettled} />);
    fireEvent.click(screen.getByRole("button", { name: "Pay" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("checkout:recoveryGuidance.messages.c09");
    expect(onSettled).toHaveBeenCalledWith(type === "card_error" ? "failed" : "unknown");
    expect(screen.getByRole("button", { name: "Waiting" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "Waiting" }).closest("form")!);
    expect(mockConfirmPayment).toHaveBeenCalledTimes(1);
  });
  it.each(["api_connection_error", "future_provider_error"])(
    "keeps covered %s outcomes fail-closed without retry copy or a second confirmation",
    async (type) => {
      mockConfirmPayment.mockReset().mockResolvedValue({
        error: { type, code: "unrecognized", message: "private provider prose" },
      });
      const onSettled = vi.fn();
      renderWithProviders(<PaymentForm coveredCheckout copy={copy} returnUrl="https://example.test/return" onSettled={onSettled} />);

      fireEvent.click(screen.getByRole("button", { name: "Pay" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("checkout:recoveryGuidance.messages.c09");
      expect(screen.queryByText("checkout:recoveryGuidance.messages.c17")).toBeNull();
      expect(onSettled).toHaveBeenCalledWith("unknown");
      const lockedButton = screen.getByRole("button", { name: "Waiting" });
      expect(lockedButton).toBeDisabled();
      fireEvent.submit(lockedButton.closest("form")!);
      expect(mockConfirmPayment).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps a rejected covered confirmation fail-closed without retry copy or a second confirmation", async () => {
    mockConfirmPayment.mockReset().mockRejectedValue(new Error("provider response unavailable"));
    const onSettled = vi.fn();
    renderWithProviders(<PaymentForm coveredCheckout copy={copy} returnUrl="https://example.test/return" onSettled={onSettled} />);

    fireEvent.click(screen.getByRole("button", { name: "Pay" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("checkout:recoveryGuidance.messages.c09");
    expect(screen.queryByText("checkout:recoveryGuidance.messages.c17")).toBeNull();
    expect(onSettled).toHaveBeenCalledWith("unknown");
    const lockedButton = screen.getByRole("button", { name: "Waiting" });
    fireEvent.submit(lockedButton.closest("form")!);
    expect(mockConfirmPayment).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["requires_action", "succeeded"],
    ["future_provider_status", "unknown"],
  ])("keeps covered status %s on a single fail-closed confirmation path", async (status, settlement) => {
    mockConfirmPayment.mockReset().mockResolvedValue({ paymentIntent: { status } });
    const onSettled = vi.fn();
    renderWithProviders(<PaymentForm coveredCheckout copy={copy} returnUrl="https://example.test/return" onSettled={onSettled} />);

    fireEvent.click(screen.getByRole("button", { name: "Pay" }));

    await waitFor(() => expect(onSettled).toHaveBeenCalledWith(settlement));
    expect(screen.queryByText("checkout:recoveryGuidance.messages.c17")).toBeNull();
    const lockedButton = screen.getByRole("button", { name: "Waiting" });
    expect(lockedButton).toBeDisabled();
    fireEvent.submit(lockedButton.closest("form")!);
    expect(mockConfirmPayment).toHaveBeenCalledTimes(1);
  });
  it("does not change a legacy caller's provider error rendering or retry button", async () => {
    mockConfirmPayment.mockResolvedValue({ error: { type: "card_error", message: "existing provider text" } });
    renderWithProviders(<PaymentForm copy={copy} returnUrl="https://example.test/return" onSettled={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Pay" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("existing provider text");
    expect(screen.getByRole("button", { name: "Pay" })).toBeEnabled();
  });
});
