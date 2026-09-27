import type { ReactNode } from "react";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

const mockUseStripeLoader = vi.fn();
vi.mock("./useStripePromise", () => ({
  useStripeLoader: () => mockUseStripeLoader(),
  useStripePromise: () => mockUseStripeLoader().stripePromise,
}));
vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: ReactNode }) => (
    <div data-testid="stripe-elements">{children}</div>
  ),
}));
vi.mock("./PaymentForm", () => ({ PaymentForm: () => <div data-testid="payment-form" /> }));

import { StripePaymentStep } from "./StripePaymentStep";

const COPY = {
  payButton: "Zapłać",
  payingButton: "Przetwarzanie…",
  errorPrefix: "Płatność odrzucona",
  unavailable: "Płatność kartą jest teraz niedostępna.",
  loadFailed: "Nie udało się wczytać formularza karty.",
  loadRetry: "Spróbuj ponownie",
  loadAlternative: "Możesz też zapłacić inaczej.",
};

function loader(overrides: Partial<{ stripePromise: unknown; status: string; retry: () => void }> = {}) {
  return { stripePromise: Promise.resolve({}), status: "ready", retry: vi.fn(), ...overrides };
}

describe("StripePaymentStep", () => {
  it("mounts the Elements payment form when the provider script is ready", () => {
    mockUseStripeLoader.mockReturnValue(loader());
    renderWithProviders(
      <StripePaymentStep clientSecret="pi_secret" returnUrl="https://x/dziekujemy" onSettled={vi.fn()} />,
    );
    expect(screen.getByTestId("stripe-elements")).toBeInTheDocument();
    expect(screen.getByTestId("payment-form")).toBeInTheDocument();
  });

  it("still mounts Elements while the script is loading, so a slow network is not shown an error", () => {
    mockUseStripeLoader.mockReturnValue(loader({ status: "loading", stripePromise: new Promise(() => {}) }));
    renderWithProviders(
      <StripePaymentStep clientSecret="pi_secret" returnUrl="https://x/dziekujemy" onSettled={vi.fn()} />,
    );
    expect(screen.getByTestId("stripe-elements")).toBeInTheDocument();
    expect(screen.queryByTestId("stripe-load-failed")).toBeNull();
  });

  it("shows the host's configuration copy when no publishable key is configured", () => {
    mockUseStripeLoader.mockReturnValue(loader({ status: "unconfigured", stripePromise: null }));
    renderWithProviders(
      <StripePaymentStep clientSecret="pi_secret" returnUrl="https://x/dziekujemy" onSettled={vi.fn()} copy={COPY} />,
    );
    expect(screen.getByTestId("stripe-unavailable").textContent).toContain(COPY.unavailable);
    expect(screen.queryByTestId("stripe-elements")).toBeNull();
    expect(screen.queryByTestId("stripe-load-retry")).toBeNull();
  });

  // The regression this wave exists for: a failed script load used to be
  // indistinguishable from a missing key, so the buyer got a dead end with no
  // way forward and no way to retry.
  it("offers a retry and an alternative when the provider script failed to load", () => {
    const retry = vi.fn();
    mockUseStripeLoader.mockReturnValue(loader({ status: "failed", retry }));
    renderWithProviders(
      <StripePaymentStep clientSecret="pi_secret" returnUrl="https://x/dziekujemy" onSettled={vi.fn()} copy={COPY} />,
    );

    const alert = screen.getByTestId("stripe-load-failed");
    expect(alert.textContent).toContain(COPY.loadFailed);
    expect(alert.textContent).toContain(COPY.loadAlternative);
    expect(screen.queryByTestId("stripe-elements")).toBeNull();

    fireEvent.click(screen.getByTestId("stripe-load-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
