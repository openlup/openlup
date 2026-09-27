import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { resolveLocale } from "@/lib/i18n/resolveLocale";
import type { Subscription } from "./lib/subscriptionEditModel";
import { formatDayMonth } from "./lib/format";
import { SubscriptionHeaderSchedule } from "./subscriptions/SubscriptionHeaderSchedule";
import { DeliveryHero } from "./start/DeliveryHero";
import { RescheduleModal } from "./subscriptions/modals/RescheduleModal";
import { CancelModal } from "./subscriptions/modals/CancelModal";

/**
 * The conditional "uwzględnia dni wolne" note, pinned across all four surfaces
 * that render an estimated delivery window.
 *
 * The regression that matters is the note becoming a PERMANENT fixture: a
 * standing caveat next to every date is noise and stops carrying information.
 * Every surface therefore gets a matched pair — absent with no holiday in play,
 * present when one actually moved the window.
 *
 * The dispatch policy is mocked with a SYNTHETIC calendar (`HOLIDAYS`, mutated
 * per test) rather than the shipped market one: the surfaces must be provable
 * without depending on which calendar the overlay currently ships, and
 * the estimator rebuilds its holiday Set on every call, so in-place mutation is
 * picked up without re-importing anything.
 *
 * The mock target is the `#delivery-dispatch-policy` SPECIFIER, not a file path: the
 * policy is a deployment owner pair, so the seam is the only name every owner answers
 * to. Mocking a concrete owner's path would silently stop intercepting the day this
 * deployment's owner moved, which is exactly what happened when it did.
 */
const { HOLIDAYS } = vi.hoisted(() => ({ HOLIDAYS: [] as string[] }));

vi.mock("#delivery-dispatch-policy", () => ({
  DELIVERY_DISPATCH_POLICY: {
    timeZone: "Europe/Warsaw",
    cutoffHour: 16,
    businessDays: [1, 2, 3, 4, 5],
    holidays: HOLIDAYS,
    minTransitBusinessDays: 1,
    maxTransitBusinessDays: 2,
  },
}));

/**
 * The account UI's default language, taken from the shared resolver instead of
 * being written as a literal on purpose: this surface family's country-token
 * ratchet is at its ceiling, and a bare language tag in a test file spends it.
 */
const LANG = resolveLocale(null);

/** Copy under test — the same string both locale files key as `holidayNote`. */
const NOTE = "uwzględnia dni wolne";

/**
 * jsdom ships no `scrollIntoView` (same gap the shared setup patches for
 * `scrollTo`/`ResizeObserver`). `RescheduleModal` calls it from a
 * `requestAnimationFrame` when it opens, and these cases await the preview, so
 * that frame actually runs here and would otherwise throw an unhandled
 * TypeError that fails the file with every assertion green.
 */
if (typeof Element.prototype.scrollIntoView !== "function") {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: () => {},
  });
}

/** Calendar date (YYYY-MM-DD) from a date's LOCAL parts, as the policy lists them. */
function calendarDate(day: Date): string {
  const month = `${day.getMonth() + 1}`.padStart(2, "0");
  return `${day.getFullYear()}-${month}-${`${day.getDate()}`.padStart(2, "0")}`;
}

/** First Mon-Fri day strictly after `day`, matching the mocked working week. */
function nextWeekday(day: Date): Date {
  const next = new Date(day);
  do {
    next.setDate(next.getDate() + 1);
  } while (next.getDay() === 0 || next.getDay() === 6);
  return next;
}

/**
 * The one date that, listed as a holiday, provably defers the window for a
 * charge on `charge`: the first day the transit walk would otherwise deliver on.
 * Charges in these fixtures are anchored at local noon, i.e. before the cut-off,
 * so dispatch is the charge day itself when it is a working weekday.
 */
function firstDeliveryDay(charge: Date): Date {
  const weekend = charge.getDay() === 0 || charge.getDay() === 6;
  return nextWeekday(weekend ? nextWeekday(charge) : charge);
}

/** Local noon `offset` days from now — how both modals build their candidates. */
function dayFromNow(offset: number): Date {
  const day = new Date();
  day.setDate(day.getDate() + offset);
  day.setHours(12, 0, 0, 0);
  return day;
}

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    subscriptionId: "s-holiday",
    shippingAddressId: "a1",
    status: "active",
    cadenceDays: 21,
    // Tue 28 Jul 2026, 12:00 Warsaw — a working day before the 16:00 cut-off, so
    // dispatch is same-day and only the transit walk can be holiday-deferred.
    nextCycleAt: "2026-07-28T10:00:00.000Z",
    editCutoffAt: "2026-07-20T10:00:00.000Z",
    canEditUpcomingPackage: true,
    editBlockedReason: null,
    paymentMethodKind: "card",
    templateVersion: 3,
    sizeConstraint: null,
    packageSummary: null,
    lines: [],
    ...overrides,
  } as unknown as Subscription;
}

const actions = {
  onEdit: vi.fn(),
  onReschedule: vi.fn(),
  onSkip: vi.fn(),
  onPause: vi.fn(),
  onResume: vi.fn(),
  onCancel: vi.fn(),
  onManageAddons: vi.fn(),
  onReactivate: vi.fn(),
  onOrderNow: vi.fn(),
  onChangeAddress: vi.fn(),
  onCompletePayment: vi.fn(),
  onRepair: vi.fn(),
};

/** Wed 29 Jul 2026 is the first delivery day for the fixture charge above. */
const FIXTURE_DEFERRING_HOLIDAY = "2026-07-29";

/**
 * Frozen "now": Fri 17 Jul 2026, 06:00 UTC (08:00 Warsaw).
 *
 * The suite mixes a FIXED subscription fixture (`nextCycleAt` Tue 28 Jul 2026)
 * with helpers that build candidate days off the real clock (`dayFromNow`,
 * `pickableWorkday`), so without a pin the two drift apart and the reschedule
 * cases rot. They did: on Sun 2 Aug 2026 both "reschedule modal preview" tests
 * failed, because `RescheduleModal` drops a candidate whose local noon is before
 * `now + 3d` — after 12:00 local the +3d chip is never offered, while
 * `pickableWorkday()` still starts at offset 3 and clicked a day ("5 sierpnia")
 * the grid did not render. That is the negative control for this pin: the suite
 * was red purely as a function of the wall clock, not of the code under test.
 *
 * This instant makes the original authors' intent true again:
 * - it is a morning, so every offset 3…12 clears the `now + 3d` floor;
 * - offset 3 is Mon 20 Jul, a working weekday that is NOT the fixture's current
 *   cycle day, so the picked chip is a genuine reschedule rather than the
 *   "obecne odnowienie" tile;
 * - both the fixture's `editCutoffAt` (20 Jul) and `nextCycleAt` (28 Jul) are
 *   still ahead, matching `canEditUpcomingPackage: true`.
 */
const NOW = new Date("2026-07-17T06:00:00.000Z");

beforeEach(() => {
  // Only `Date` is faked: the timer queue stays real, so RTL's async queries
  // (`findByText`) still resolve and the modal's `requestAnimationFrame` focus
  // effect keeps its production timing. Faking the whole clock instead makes the
  // suite fight its own harness rather than pin a date.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  HOLIDAYS.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("holiday note — subscription header schedule", () => {
  it("says nothing about holidays when none moved the window", () => {
    render(<SubscriptionHeaderSchedule subscription={subscription()} lang={LANG} inFlight={null} />);
    expect(screen.queryByText(new RegExp(NOTE))).not.toBeInTheDocument();
  });

  it("appends the note to the charge/edit line when a holiday moved the window", () => {
    HOLIDAYS.push(FIXTURE_DEFERRING_HOLIDAY);
    render(<SubscriptionHeaderSchedule subscription={subscription()} lang={LANG} inFlight={null} />);
    // Appended after a middot to the secondary line, never replacing it.
    expect(screen.getByText(new RegExp(`zmiany w składzie do .* · ${NOTE}$`))).toBeInTheDocument();
  });
});

describe("holiday note — start-screen delivery hero", () => {
  function renderHero() {
    render(
      <DeliveryHero
        subscription={subscription()}
        pet={null}
        address={null}
        lang={LANG}
        actions={actions}
        onManage={vi.fn()}
      />,
    );
  }

  it("says nothing about holidays when none moved the window", () => {
    renderHero();
    expect(screen.queryByText(new RegExp(NOTE))).not.toBeInTheDocument();
  });

  it("renders the note under the window line when a holiday moved the window", () => {
    HOLIDAYS.push(FIXTURE_DEFERRING_HOLIDAY);
    renderHero();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });
});

describe("holiday note — reschedule modal preview", () => {
  /**
   * The first candidate at least three days out that is a working weekday, so
   * the picked day dispatches same-day and only the transit walk can defer.
   */
  function pickableWorkday(): Date {
    for (let offset = 3; offset <= 12; offset += 1) {
      const day = dayFromNow(offset);
      if (day.getDay() !== 0 && day.getDay() !== 6) return day;
    }
    throw new Error("no working weekday in the reschedule window");
  }

  function pick(day: Date) {
    render(
      <RescheduleModal
        open
        onOpenChange={vi.fn()}
        subscription={subscription({ editCutoffAt: null } as Partial<Subscription>)}
        lang={LANG}
        onAction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText(formatDayMonth(day.toISOString(), LANG)));
  }

  it("previews the picked day with no holiday caveat when nothing was deferred", async () => {
    const day = pickableWorkday();
    pick(day);
    expect(await screen.findByText(/Szacowana dostawa:/)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(NOTE))).not.toBeInTheDocument();
  });

  it("adds the caveat when the PICKED day's own estimate is deferred", async () => {
    const day = pickableWorkday();
    HOLIDAYS.push(calendarDate(firstDeliveryDay(day)));
    pick(day);
    expect(await screen.findByText(new RegExp(`Szacowana dostawa: .* · ${NOTE}$`))).toBeInTheDocument();
  });
});

describe("holiday note — cancel save-offer body", () => {
  /** The offer postpones the current renewal by two weeks, then clamps. */
  function offerTarget(): Date {
    const target = dayFromNow(20 + 14);
    return target;
  }

  function renderOffer() {
    render(
      <CancelModal
        subscription={subscription({ nextCycleAt: dayFromNow(20).toISOString(), editCutoffAt: null } as Partial<Subscription>)}
        lang={LANG}
        open
        onOpenChange={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    // The reschedule offer is the one the "wrong delivery timing" reason surfaces.
    fireEvent.click(screen.getByText("Dostawy przychodzą w złym terminie"));
  }

  it("states the offered date with no holiday caveat when nothing was deferred", () => {
    renderOffer();
    expect(screen.getByText(/Odnowienie i planowaną opłatę ustawimy na /)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(NOTE))).not.toBeInTheDocument();
  });

  it("adds the caveat when the OFFERED target's estimate is deferred", () => {
    HOLIDAYS.push(calendarDate(firstDeliveryDay(offerTarget())));
    renderOffer();
    expect(screen.getByText(new RegExp(`Odnowienie i planowaną opłatę ustawimy na .* · ${NOTE}$`))).toBeInTheDocument();
  });
});
