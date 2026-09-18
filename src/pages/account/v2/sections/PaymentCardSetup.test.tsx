import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const startCustomerCardSetup = vi.fn();
const diagnosticReporter = vi.hoisted(() => ({ reportCustomerJourneyDiagnostic: vi.fn() }));
vi.mock("@/domains/customers/paymentMethodSetupClient", () => ({
  startCustomerCardSetup: (...args: unknown[]) => startCustomerCardSetup(...args),
}));
// A counter, not a constant: a fixed key cannot tell "one action settled twice"
// apart from "two actions, one terminal each", which is the whole repair.
const mintedActionKeys = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/flags", () => ({
  createCustomerDiagnosticActionKeyWhenEnabled: () =>
    `${String(++mintedActionKeys.count).repeat(8)}-1111-4111-8111-111111111111`,
  loadCustomerDiagnosticReporterWhenEnabled: () => Promise.resolve(diagnosticReporter),
}));

// Stripe Elements + loader are exercised end-to-end elsewhere (recovery flow); here we
// stub them so the test focuses on this component's state machine.
vi.mock("@stripe/react-stripe-js", () => ({ Elements: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@stripe/stripe-js", () => ({ loadStripe: () => Promise.resolve({}) }));
vi.mock("@/domains/payment/components/RecoveryPaymentSetupForm", () => ({
  RecoveryPaymentSetupForm: ({ onMethodReady, onError }: {
    onMethodReady: (m: { paymentMethodRef: string; paymentMethodKind: string }) => void;
    // The real form calls this on a refused card and stays mounted for a retry.
    onError?: (message: string) => void;
  }) => (
    <>
      <button type="button" data-testid="stub-confirm-card" onClick={() => onMethodReady({ paymentMethodRef: "pm_new", paymentMethodKind: "card" })}>
        confirm
      </button>
      <button type="button" data-testid="stub-decline-card" onClick={() => onError?.("Karta odrzucona")}>
        decline
      </button>
    </>
  ),
}));

import { PaymentCardSetup } from "./PaymentCardSetup";

const SUB = "5b000000-0000-4000-8000-000000000001";

describe("PaymentCardSetup (CJ63-A)", () => {
  beforeEach(() => {
    startCustomerCardSetup.mockReset();
    diagnosticReporter.reportCustomerJourneyDiagnostic.mockReset();
    mintedActionKeys.count = 0;
    vi.stubEnv("VITE_STRIPE_PUBLISHABLE_KEY", "pk_test_123");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("mints a SetupIntent, collects a card, and confirms saved", async () => {
    startCustomerCardSetup.mockResolvedValueOnce({
      contractVersion: "customer.payment-method-setup.v1",
      setup: { clientSecret: "seti_secret", setupIntentId: "seti_1", subscriptionId: SUB },
    });
    const onSaved = vi.fn();
    render(<PaymentCardSetup subscriptionId={SUB} accessToken="tok" onSaved={onSaved} />);

    fireEvent.click(screen.getByText("Zmień kartę"));
    await waitFor(() => expect(startCustomerCardSetup).toHaveBeenCalledWith("tok", expect.objectContaining({ subscriptionId: SUB })));

    // Card element appears; confirming it flips to the saved state and notifies the parent.
    fireEvent.click(await screen.findByTestId("stub-confirm-card"));
    await screen.findByText(/Zapisano nową kartę/);
    expect(onSaved).toHaveBeenCalled();
    await waitFor(() => expect(diagnosticReporter.reportCustomerJourneyDiagnostic).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "account_card_setup", phase: "settled", code: "succeeded" }), "tok",
    ));
  });

  /**
   * A refused card is ordinary, and the form stays mounted for the retry. Each
   * refusal used to settle the SAME action key `failed`, so one action carried
   * several conflicting terminals and a decline-then-success read as a
   * contradiction instead of as two attempts.
   */
  it("settles a declined card once and opens a fresh action key for the retry", async () => {
    startCustomerCardSetup.mockResolvedValueOnce({
      contractVersion: "customer.payment-method-setup.v1",
      setup: { clientSecret: "seti_secret", setupIntentId: "seti_1", subscriptionId: SUB },
    });
    render(<PaymentCardSetup subscriptionId={SUB} accessToken="tok" />);

    fireEvent.click(screen.getByText("Zmień kartę"));
    fireEvent.click(await screen.findByTestId("stub-decline-card"));
    expect(screen.getByText("Karta odrzucona")).toBeInTheDocument();

    fireEvent.click(await screen.findByTestId("stub-confirm-card"));
    await screen.findByText(/Zapisano nową kartę/);

    await waitFor(() => expect(diagnosticReporter.reportCustomerJourneyDiagnostic).toHaveBeenCalledTimes(4));
    const events = diagnosticReporter.reportCustomerJourneyDiagnostic.mock.calls
      .map(([event]) => event as { phase: string; code: string; clientActionKey: string });
    const keys = [...new Set(events.map((event) => event.clientActionKey))];

    expect(keys).toHaveLength(2);
    expect(events.map((event) => [event.phase, event.code, keys.indexOf(event.clientActionKey)])).toEqual([
      ["attempted", "observed", 0],
      ["settled", "failed", 0],
      ["attempted", "observed", 1],
      ["settled", "succeeded", 1],
    ]);
  });

  it("surfaces a localized error when the SetupIntent mint fails", async () => {
    startCustomerCardSetup.mockRejectedValueOnce(new Error("boom"));
    render(<PaymentCardSetup subscriptionId={SUB} accessToken="tok" />);
    fireEvent.click(screen.getByText("Zmień kartę"));
    await screen.findByText(/Nie udało się rozpocząć aktualizacji karty/);
    await waitFor(() => expect(diagnosticReporter.reportCustomerJourneyDiagnostic).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "account_card_setup", phase: "settled", code: "failed" }), "tok",
    ));
  });
});
