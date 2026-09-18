import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PackageCardHeader } from "./PackageCardHeader";
import type { StarterPlanView } from "@/checkout/machine/quoteBandPricing";

/**
 * CL2 proof for `step6-stat-bar-reuses-starter-plan-view`.
 *
 * The stat bar must read its feeding figure and per-day price off the SAME
 * {@link StarterPlanView} the offer step priced from. `starterTermsFromCoverage`
 * clamps the interval (here 28 days for a 34-day package), so dividing by the
 * package's coverage days would print a different per-day price than the step
 * before it. This file pins the clamped case explicitly.
 */

const clampedPlan: StarterPlanView = {
  cans: 34, intervalDays: 28, steadyCadenceDays: 28, steadyCans: 35,
  firstPerDayMinor: 745, firstAnchorPerDayMinor: 1_490, firstDiscountPercent: 50,
  delivery2TotalMinor: 32_929, delivery2EstimateIso: "2026-09-02T09:00:00.000Z",
  steadyPerDayMinor: 1_676, steadyDiscountPercent: 10,
};

function renderHeader(props: Partial<Parameters<typeof PackageCardHeader>[0]> = {}) {
  return render(
    <PackageCardHeader
      totalCans={34}
      feedingDays={34}
      dailyKcal={613}
      dailyGrams={400}
      isMobile={false}
      {...props}
    />,
  );
}

describe("PackageCardHeader stat bar", () => {
  it("uses the plan's clamped interval, not the package's coverage days", () => {
    renderHeader({ starterPlan: clampedPlan });

    const stats = screen.getByTestId("package-stat-bar");
    // Coverage is 34 days; the plan's charged interval is 28. The customer must
    // read the interval — the same denominator behind 7,45 zł.
    expect(stats).toHaveTextContent("~28 dni");
    expect(stats).not.toHaveTextContent("~34 dni");
    expect(stats).toHaveTextContent("7,45 zł");
    expect(stats).toHaveTextContent("za dzień na start");
  });

  it("drops the per-day cell outside the starter offer instead of inventing one", () => {
    renderHeader();

    const stats = screen.getByTestId("package-stat-bar");
    expect(stats).toHaveTextContent("~34 dni");
    expect(stats).not.toHaveTextContent("za dzień na start");
    expect(stats).not.toHaveTextContent("zł");
    expect(screen.queryByTestId("package-starter-pill")).toBeNull();
  });

  it("omits the discount pill when the quote resolved no first-delivery discount", () => {
    renderHeader({ starterPlan: { ...clampedPlan, firstDiscountPercent: null } });

    expect(screen.queryByTestId("package-starter-pill")).toBeNull();
    expect(screen.getByTestId("package-stat-bar")).toHaveTextContent("7,45 zł");
  });

  it("shows numbers only on mobile — no mix text, no method", () => {
    renderHeader({ isMobile: true, starterPlan: clampedPlan });

    // Two columns, as the makieta draws them: „34 puszek" over „~28 dni
    // karmienia" on the left, the per-day rate on the right.
    const stats = screen.getByTestId("package-stat-bar");
    expect(stats).toHaveTextContent("34 puszek");
    expect(stats).toHaveTextContent("~28 dni karmienia");
    expect(stats).toHaveTextContent("7,45 zł");
    // The text summary of the mix is gone: a closed editor now says
    // „Zmień smaki i ilości" and nothing else, so the header does not restate
    // what the closed list contains.
    expect(screen.queryByText(/Jagnięcina ×/)).toBeNull();
    // The portion disclosure is desktop-only — mobile shows numbers, not method.
    expect(screen.queryByTestId("package-portion-disclosure-toggle")).toBeNull();
  });

  it("hangs the portion sentence off the days figure instead of the card head", () => {
    renderHeader({ isMobile: true, starterPlan: clampedPlan });

    // Was a paragraph under the title, read on arrival whether or not it was
    // wanted. It is now a tip on the one number it explains.
    expect(screen.queryByText("Porcję dopasowaliśmy na podstawie Twojej ankiety.")).toBeNull();
    expect(screen.getByTestId("package-portion-tip")).toHaveAttribute(
      "aria-label",
      "Porcję dopasowaliśmy na podstawie Twojej ankiety.",
    );
  });
});


describe("optional portion tip", () => {
  it("opens on first activation, restores focus after Escape, and opens again", async () => {
    renderHeader({ isMobile: true });
    fireEvent.click(screen.getByTestId("package-portion-tip"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Porcję dopasowaliśmy na podstawie Twojej ankiety.");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("package-portion-tip")).toHaveFocus());
    fireEvent.click(screen.getByTestId("package-portion-tip"));
    expect(await screen.findByRole("dialog")).toBeVisible();
  });

  it("keeps the header and explanation available when the optional chunk fails", async () => {
    vi.resetModules();
    vi.doMock("@/components/ui/popover", () => { throw new Error("optional chunk unavailable"); });
    try {
      const { PackageCardHeader: HeaderWithFailedTip } = await import("./PackageCardHeader");
      render(<HeaderWithFailedTip totalCans={34} feedingDays={34} dailyKcal={null} dailyGrams={null} isMobile />);
      fireEvent.click(screen.getByTestId("package-portion-tip"));
      expect(await screen.findByRole("status")).toHaveTextContent("Porcję dopasowaliśmy na podstawie Twojej ankiety.");
      const stats = screen.getByTestId("package-stat-bar");
      expect(stats).toHaveTextContent("34 puszek");
      expect(stats).toHaveTextContent("~34 dni karmienia");
      expect(screen.getByTestId("package-portion-tip")).toHaveFocus();
    } finally {
      vi.doUnmock("@/components/ui/popover");
    }
  });
});
