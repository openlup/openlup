import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { createReferenceI18n } from "@/public-reference/subscriptionMessages";
import type { Subscription } from "./lib/subscriptionEditModel";
import { formatDayMonth } from "./lib/format";
import { RescheduleModal } from "./subscriptions/modals/RescheduleModal";

const { HOLIDAYS } = vi.hoisted(() => ({ HOLIDAYS: [] as string[] }));
vi.mock("#delivery-dispatch-policy", () => ({
  DELIVERY_DISPATCH_POLICY: {
    timeZone: "Europe/Warsaw", cutoffHour: 16, businessDays: [1, 2, 3, 4, 5],
    holidays: HOLIDAYS, minTransitBusinessDays: 1, maxTransitBusinessDays: 2,
  },
}));
const NOW = new Date("2026-07-17T06:00:00.000Z");
const PICKED = "2026-07-20T10:00:00.000Z";
const NOTE = "A public holiday may move this estimate later.";
const testI18n = createReferenceI18n();
if (typeof Element.prototype.scrollIntoView !== "function") {
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, writable: true, value: () => {} });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  HOLIDAYS.length = 0;
});
afterEach(() => { vi.useRealTimers(); });
function pick() {
  const subscription = {
    subscriptionId: "synthetic-subscription", status: "active", cadenceDays: 21,
    nextCycleAt: "2026-07-28T10:00:00.000Z", editCutoffAt: null,
    canEditUpcomingPackage: true, editBlockedReason: null,
  } as unknown as Subscription;
  render(<I18nextProvider i18n={testI18n}><RescheduleModal open onOpenChange={vi.fn()} subscription={subscription} lang="en" onAction={vi.fn()} /></I18nextProvider>);
  fireEvent.click(screen.getByText(formatDayMonth(PICKED, "en")));
}
describe("selected renewal modal delivery estimate", () => {
  it("separates renewal and charge from the estimate without a permanent holiday caveat", async () => {
    pick();
    expect(await screen.findByText(/Planned renewal and charge:/)).toBeInTheDocument();
    expect(screen.getByText(/Estimated delivery window, not guaranteed:/)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(NOTE))).not.toBeInTheDocument();
  });
  it("adds the caveat only when the picked date's own delivery estimate is deferred", async () => {
    HOLIDAYS.push("2026-07-21");
    pick();
    expect(await screen.findByText(new RegExp(`Estimated delivery window, not guaranteed: .* · ${NOTE}$`))).toBeInTheDocument();
    expect(screen.getByText(/Planned renewal and charge:/)).toBeInTheDocument();
  });
});
