import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import type { SubscriptionArrears } from "../lib/dunningFacts";
import { ActionRequiredBanner } from "./ActionRequiredBanner";

const LANG = "pl" as const;

const arrears: SubscriptionArrears = {
  orderId: "o1",
  recoveryEligible: true,
  failureCause: "unknown",
  dueAt: "2026-07-02T10:00:00.000Z",
  nextRetryAt: "2026-07-01T10:00:00.000Z",
  amountMinor: 13702,
  currency: "PLN",
};

function renderBanner(
  overrides: Partial<SubscriptionArrears> = {},
  methodStatus?: "expiring" | "revoked" | "usable",
  variant?: "open" | "expired",
) {
  const onRepair = vi.fn();
  const onResumeAfterExpired = vi.fn();
  render(
    <ActionRequiredBanner
      petName="Burek"
      arrears={{ ...arrears, ...overrides }}
      methodStatus={methodStatus}
      lang={LANG}
      onRepair={onRepair}
      onResumeAfterExpired={onResumeAfterExpired}
      variant={variant}
    />,
  );
  return { onRepair, onResumeAfterExpired };
}

describe("ActionRequiredBanner", () => {
  it("states the overdue amount and the next attempt date", () => {
    renderBanner();
    expect(screen.getByText(/137,02/)).toBeInTheDocument();
    expect(screen.getByText(/Kolejna próba obciążenia: 1 lipca/)).toBeInTheDocument();
    // With a retry scheduled, the softer "due" line must not also appear.
    expect(screen.queryByText(/^Termin:/)).toBeNull();
  });

  it("falls back to the due date when no retry is scheduled", () => {
    renderBanner({ nextRetryAt: null });
    expect(screen.getByText(/Termin: 2 lipca/)).toBeInTheDocument();
  });

  it("omits the amount rather than showing a fabricated zero", () => {
    renderBanner({ amountMinor: null });
    expect(screen.queryByText(/Do zapłaty/)).toBeNull();
    expect(screen.queryByText(/0,00/)).toBeNull();
  });

  it("names the stored method's problem when the payload carries one", () => {
    renderBanner({}, "revoked");
    expect(screen.getByText("Zgoda na obciążenia została cofnięta")).toBeInTheDocument();
  });

  it("says nothing about the method when it is usable", () => {
    renderBanner({}, "usable");
    expect(screen.queryByText(/Zapisana metoda/)).toBeNull();
  });

  it("explains the support route when no recovery link can be minted", () => {
    renderBanner({ recoveryEligible: false });
    expect(screen.getByText(/Automatyczne próby zostały wyczerpane/)).toBeInTheDocument();
  });

  it("routes the CTA into the repair flow", () => {
    const { onRepair, onResumeAfterExpired } = renderBanner();
    fireEvent.click(screen.getByRole("button", { name: "Napraw płatność" }));
    expect(onRepair).toHaveBeenCalledTimes(1);
    expect(onResumeAfterExpired).not.toHaveBeenCalled();
  });

  // The two states share one red surface and must not share one promise. An
  // open case is still retrying; an expired one never will, and its way out is
  // the method update, not a wait.
  it("switches the promise, not the figures, for an expired case", () => {
    renderBanner({ nextRetryAt: null }, "expiring", "expired");
    expect(screen.getByText(/nie udało się pobrać opłaty/)).toBeInTheDocument();
    expect(screen.getByText(/Zaktualizuj płatność i wznów/)).toBeInTheDocument();
    expect(screen.queryByText(/Kolejna próba obciążenia/)).not.toBeInTheDocument();
    expect(screen.getByText(/137,02/)).toBeInTheDocument();
  });

  it("does not offer the open-case support note on an expired case", () => {
    renderBanner({ recoveryEligible: false, nextRetryAt: null }, undefined, "expired");
    expect(screen.queryByText(/Automatyczne próby zostały wyczerpane/)).not.toBeInTheDocument();
  });

  // The whole point of the wave: the expired case has no repair flow to start,
  // because the token issuer only ever looks at cases that are still open.
  it("sends the expired CTA to resume, never to the repair flow", () => {
    const { onRepair, onResumeAfterExpired } = renderBanner({ nextRetryAt: null }, "usable", "expired");
    fireEvent.click(screen.getByRole("button", { name: "Zaktualizuj płatność i wznów" }));
    expect(onResumeAfterExpired).toHaveBeenCalledTimes(1);
    expect(onRepair).not.toHaveBeenCalled();
  });

  // `expiring` is chargeable: the renewal lane still charges it, and the server
  // accepts the resume. The banner must not be stricter than the server.
  it("treats an expiring method as chargeable", () => {
    const { onResumeAfterExpired } = renderBanner({ nextRetryAt: null }, "expiring", "expired");
    fireEvent.click(screen.getByRole("button", { name: "Zaktualizuj płatność i wznów" }));
    expect(onResumeAfterExpired).toHaveBeenCalledTimes(1);
  });

  it("offers no control at all when the stored method cannot be charged", () => {
    const { onRepair, onResumeAfterExpired } = renderBanner({ nextRetryAt: null }, "revoked", "expired");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Dodaj metodę płatności, którą możemy obciążyć automatycznie/)).toBeInTheDocument();
    expect(onRepair).not.toHaveBeenCalled();
    expect(onResumeAfterExpired).not.toHaveBeenCalled();
  });

  it("keeps the blocked sentence off the open variant", () => {
    renderBanner({}, "revoked");
    expect(screen.getByRole("button", { name: "Napraw płatność" })).toBeInTheDocument();
    expect(screen.queryByText(/Dodaj metodę płatności, którą możemy obciążyć automatycznie/)).toBeNull();
  });
});
