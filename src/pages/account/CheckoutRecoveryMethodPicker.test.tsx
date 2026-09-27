import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CheckoutRecoveryMethodPicker } from "./CheckoutRecoveryMethodPicker";
import {
  BLIK_BANK_UNSUPPORTED,
  emptyTpayCheckoutDraft,
} from "@/checkout/adapters/tpayCheckoutDraft";

const BLIK = { value: "blik" as const, provider: "tpay" as const };
const TRANSFER = { value: "transfer" as const, provider: "tpay" as const };
const CARD = { value: "card" as const, provider: "stripe" as const };
const SUPPORTED_BANK_IDS = ["pko_bp", "ing", "millennium", "alior", "erste", "credit_agricole", "nest", "sgb"] as const;

function renderPicker(over: Partial<React.ComponentProps<typeof CheckoutRecoveryMethodPicker>> = {}) {
  const onSelect = vi.fn();
  const onDraftChange = vi.fn();
  render(
    <CheckoutRecoveryMethodPicker
      methods={[BLIK, TRANSFER]}
      paymentMethod="blik"
      onSelect={onSelect} onContactSupport={vi.fn()}
      draft={emptyTpayCheckoutDraft}
      onDraftChange={onDraftChange}
      channels={[]}
      checkoutMode="one_time"
      fieldErrors={{}}
      {...over}
    />,
  );
  return { onSelect, onDraftChange };
}

describe("CheckoutRecoveryMethodPicker", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("renders a tile per visible method and a BLIK code input when BLIK is selected", () => {
    renderPicker();
    expect(screen.getByTestId("recovery-method-picker")).toBeTruthy();
    expect(screen.getByTestId("recovery-blik-input")).toBeTruthy();
    expect(screen.queryByTestId("recovery-pbl-select")).toBeNull();
  });

  it("digit-filters the BLIK input", () => {
    const { onDraftChange } = renderPicker();
    fireEvent.change(screen.getByTestId("recovery-blik-input"), { target: { value: "1a2b3c4d5e6f" } });
    expect(onDraftChange).toHaveBeenCalledWith({ blikToken: "123456" });
  });

  it("renders the bank select with channels when transfer is selected", () => {
    renderPicker({
      paymentMethod: "transfer",
      channels: [
        { id: "ch1", name: "Bank A", fullName: "Bank A SA", available: true, onlinePayment: true, instantRedirection: true, image: null, groups: [] } as never,
      ],
    });
    const select = screen.getByTestId("recovery-pbl-select");
    expect(select).toBeTruthy();
    expect(screen.getByRole("option", { name: "Bank A SA" })).toBeTruthy();
  });

  it("shows a BLIK validation error (translated key) when present", () => {
    renderPicker({ fieldErrors: { blikToken: "checkout:step6.blikCodeError" } });
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  });

  it("renders exactly the eight recurring-BLIK banks for subscription recovery", () => {
    vi.stubEnv("VITE_PAYMENTS_TPAY_BLIK_MODEL_O_ENABLED", "true");
    renderPicker({ checkoutMode: "subscription" });

    expect(screen.getAllByRole("option").map((option) => option.getAttribute("value")))
      .toEqual(["", ...SUPPORTED_BANK_IDS, BLIK_BANK_UNSUPPORTED]);
  });

  it.each(SUPPORTED_BANK_IDS)("accepts recurring-BLIK bank %s during subscription recovery", (blikBankId) => {
    vi.stubEnv("VITE_PAYMENTS_TPAY_BLIK_MODEL_O_ENABLED", "true");
    renderPicker({
      checkoutMode: "subscription",
      draft: { ...emptyTpayCheckoutDraft, blikBankId },
    });

    expect(screen.getByTestId("recovery-blik-bank")).toHaveValue(blikBankId);
    expect(screen.getByTestId("recovery-blik-input")).toBeTruthy();
  });

  it("offers approved help instead of a bank diagnosis when preflight has no card", () => {
    vi.stubEnv("VITE_PAYMENTS_TPAY_BLIK_MODEL_O_ENABLED", "true");
    const onContactSupport = vi.fn();
    renderPicker({ methods: [BLIK], checkoutMode: "subscription", onContactSupport,
      draft: { ...emptyTpayCheckoutDraft, blikBankId: BLIK_BANK_UNSUPPORTED } });
    expect(screen.getByText("Nie możemy teraz dokończyć płatności. Skontaktuj się z nami.")).toBeInTheDocument();
    expect(screen.queryByText(/Nie ponawiaj BLIK-u w tym banku/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Napisz do nas" }));
    expect(onContactSupport).toHaveBeenCalledOnce();
  });

  it("selects and focuses card on the same recovery page for an unsupported recurring-BLIK bank", async () => {
    vi.stubEnv("VITE_PAYMENTS_TPAY_BLIK_MODEL_O_ENABLED", "true");
    const { onSelect } = renderPicker({
      methods: [CARD, BLIK],
      checkoutMode: "subscription",
      draft: { ...emptyTpayCheckoutDraft, blikBankId: BLIK_BANK_UNSUPPORTED },
    });

    expect(screen.getByText("Nie mamy potwierdzenia obsługi BLIK dla subskrypcji w tym banku. Wybierz kartę.")).toBeInTheDocument();
    expect(screen.queryByText(/Nie udało się włączyć płatności cyklicznych BLIK/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Wybierz kartę" }));

    expect(onSelect).toHaveBeenCalledWith("card");
    await waitFor(() => {
      expect(document.activeElement).toBe(document.getElementById("recovery-payment-method-card"));
    });
    expect(screen.getByRole("status").textContent).toMatch(/Wybrano kartę|Card or wallet selected/i);
  });
});
