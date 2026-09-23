import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import type { ReactElement } from "react";

import type { Subscription } from "../../lib/subscriptionEditModel";
import { RescheduleModal } from "./RescheduleModal";

// Frozen "now" so the candidate-date window is deterministic.
const NOW = new Date("2026-06-01T09:00:00.000Z");

// The public package has no application-wide account i18n bootstrap. Keep
// these legacy Polish assertions backed by a test-local translation instance.
const testI18n = i18next.createInstance();
void testI18n.init({
  lng: "pl",
  fallbackLng: "pl",
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: {
    pl: {
      account: {
        dashboard: {
          subscriptionV2: {
            holidayNote: "Święto może przesunąć szacowany termin dostawy.",
            modals: {
              reschedule: {
                title: "Zmień termin odnowienia",
                description: "Dostępne terminy: {{from}}–{{to}}",
                summaryTitle: "Po zmianie",
                renewalAndCharge: "Planowane odnowienie i opłata: {{date}}",
                estimatedDelivery: "Szacowana dostawa: {{window}}",
                futureCadence: "Planowane kolejne odnowienia: co {{days}} dni od {{date}}",
                protectedAlignment: "Przy opóźnionej dostawie ten termin może automatycznie przesunąć się tylko na później.",
                confirm: "Zapisz nowy termin",
                noDates: "Brak dostępnych terminów.",
                impact: "Zmiana planowanego terminu odnowienia i opłaty.",
                gridLabel: "Dzień odnowienia i planowanej opłaty",
                current: "obecne odnowienie",
                inDays: "Za {{days}} dni",
              },
            },
          },
        },
      },
    },
  },
});

function renderModal(element: ReactElement) {
  return render(<I18nextProvider i18n={testI18n}>{element}</I18nextProvider>);
}

/**
 * Regression guard for the single-chip bug: a 21-day cadence put the next
 * renewal at the very top of a 21-day grid, collapsing the picker to one option.
 * The modal must instead offer the whole operational window, from the +3d floor
 * through the +60d horizon.
 */
function makeSubscription(): Subscription {
  return {
    subscriptionId: "s1",
    // Next renewal 21 days out; edit cutoff the day before it.
    nextCycleAt: "2026-06-22T10:00:00.000Z",
    editCutoffAt: "2026-06-21T10:00:00.000Z",
  } as unknown as Subscription;
}

describe("RescheduleModal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers the whole edit window, not just the current date", () => {
    renderModal(
      <RescheduleModal
        subscription={makeSubscription()}
        lang="pl"
        open
        onOpenChange={vi.fn()}
        onAction={vi.fn()}
      />,
    );

    // Every chip is a radio. Pre-fix this was 1–2; the full operational window
    // is almost 60 days.
    const chips = screen.getAllByRole("radio");
    expect(chips.length).toBeGreaterThan(20);

    // The current renewal date is labelled, and dates *after* it are offered
    // (postponing was impossible before — the grid stopped at the current day).
    expect(screen.getByText("obecne odnowienie")).toBeInTheDocument();
    expect(screen.getByText("15 lipca")).toBeInTheDocument(); // 23 days out
    expect(
      screen.getByRole("radiogroup", { name: "Dzień odnowienia i planowanej opłaty" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Dostępne terminy: 4 czerwca–30 lipca/)).toBeInTheDocument();
  });

  it("keeps the confirm button disabled when the current term is (re)selected", () => {
    const onAction = vi.fn();
    renderModal(
      <RescheduleModal
        subscription={makeSubscription()}
        lang="pl"
        open
        onOpenChange={vi.fn()}
        onAction={onAction}
      />,
    );

    // CJ56-1 regression: clicking the current-renewal tile must NOT enable the
    // confirm button. Re-selecting the same renewal is a no-op that would
    // otherwise bump state and send a spurious reschedule email.
    const confirm = screen.getByRole("button", { name: "Zapisz nowy termin" });
    expect(confirm).toBeDisabled();

    const currentChip = screen.getByText("obecne odnowienie").closest("button");
    expect(currentChip).not.toBeNull();
    expect(currentChip).toHaveAttribute("aria-checked", "true");
    fireEvent.click(currentChip!);
    expect(confirm).toBeDisabled();
    expect(screen.queryByText("Po zmianie")).toBeNull();

    // A different day still enables it (and submits).
    const otherChip = screen.getByText("15 lipca").closest("button");
    fireEvent.click(otherChip!);
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("explains that delivery protection may move a selected renewal later", () => {
    renderModal(
      <RescheduleModal
        subscription={{
          ...makeSubscription(),
          deliveryAlignment: { state: "protected" },
        } as Subscription}
        lang="pl"
        open
        onOpenChange={vi.fn()}
        onAction={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("15 lipca").closest("button")!);
    expect(
      screen.getByText(/ten termin może automatycznie przesunąć się tylko na później/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Planowane kolejne odnowienia: co/)).toBeInTheDocument();
  });

  it("fires a single reschedule when the confirm button is double-clicked", () => {
    // CJ64-1 regression: rapidly multi-clicking the save button before the modal
    // closes must not dispatch a second modification request — two requests for
    // one intent produced two "delivery rescheduled" confirmation emails.
    // onAction stays pending (mimics an in-flight request), so the submitting
    // guard remains engaged across both clicks.
    const onAction = vi.fn(() => new Promise<void>(() => {}));
    renderModal(
      <RescheduleModal
        subscription={makeSubscription()}
        lang="pl"
        open
        onOpenChange={vi.fn()}
        onAction={onAction}
      />,
    );

    const otherChip = screen.getByText("15 lipca").closest("button");
    fireEvent.click(otherChip!);

    const confirm = screen.getByRole("button", { name: "Zapisz nowy termin" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(confirm).toBeDisabled();
  });

  it("moves focus across the 3-column grid with the arrow keys", () => {
    renderModal(
      <RescheduleModal
        subscription={makeSubscription()}
        lang="pl"
        open
        onOpenChange={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    const chips = screen.getAllByRole("radio");
    expect(chips.filter((chip) => chip.tabIndex === 0)).toHaveLength(1);

    chips[0].focus();
    fireEvent.keyDown(chips[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(chips[1]); // next column
    expect(chips[1]).toHaveAttribute("aria-checked", "true");
    expect(chips[1]).toHaveAttribute("tabindex", "0");
    expect(chips[0]).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(chips[1], { key: "ArrowDown" });
    expect(document.activeElement).toBe(chips[4]); // down one row (3 columns)

    fireEvent.keyDown(chips[4], { key: "ArrowUp" });
    expect(document.activeElement).toBe(chips[1]); // back up one row

    fireEvent.keyDown(chips[1], { key: "End" });
    expect(document.activeElement).toBe(chips[chips.length - 1]);
  });
});
