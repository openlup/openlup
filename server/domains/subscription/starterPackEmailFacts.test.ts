import { describe, expect, it } from "vitest";
import { createStarterPackMoneyLabel } from "../../adapters/supabase/subscription/starterPackContext.js";
import { resolveLocale } from "../../../src/lib/i18n/resolveLocale.js";
import type { StarterPackMarker } from "./starterPackCycle.js";
import {
  starterRenewalEmailFields,
  starterWelcomeEmailFields,
} from "./starterPackEmailFacts.js";

/**
 * Delivery 1 was 14 cans; delivery 2 repeats the same template with the frozen
 * 3150 gr discount (16800 -> 13650); delivery 3 graduates to 28 units at 28000.
 *
 * The money label is now injected; these goldens keep pinning the MANAGED
 * formatter (`createStarterPackMoneyLabel`), so every expected string below is
 * the pre-split one.
 */
const DEFAULT_LOCALE = resolveLocale(null);

const MARKER: StarterPackMarker = {
  schemaVersion: "1",
  starterIntervalDays: 14,
  basisTemplateVersion: 1,
  delivery2: { discountBps: 3_500, discountMinor: 3_150, basisSubtotalMinor: 16_800 },
  graduation: {
    cadenceDays: 28,
    lines: [
      {
        sku: "opaque:lamb-launch.v1",
        qty: 20,
        sortOrder: 0,
        isAddon: false,
        quoteLine: { lineSubtotalGross: { amountMinor: 20_000, currency: "PLN" } },
      },
      {
        sku: "opaque:beef-launch.v1",
        qty: 8,
        sortOrder: 1,
        isAddon: false,
        quoteLine: { lineSubtotalGross: { amountMinor: 8_000, currency: "PLN" } },
      },
    ],
  },
};

function context(overrides?: Partial<Parameters<typeof starterRenewalEmailFields>[0]>) {
  return {
    marker: MARKER,
    templateVersion: 1,
    upcomingCycleNumber: 2,
    // The subscription's own currency travels with the context; the module
    // formats what the row says rather than naming one merchant's currency.
    currency: "PLN",
    ...overrides,
  };
}

describe("starterRenewalEmailFields", () => {
  it("(a) delivery 2: frozen basis minus the frozen discount", () => {
    expect(starterRenewalEmailFields(context(), createStarterPackMoneyLabel("pl"))).toEqual({
      starterStage: "delivery2",
      starterAmountLabel: expect.stringContaining("136,50"),
    });
  });

  it("(b) delivery 3: totals and can count come from the frozen graduation lines", () => {
    expect(starterRenewalEmailFields(context({ upcomingCycleNumber: 3 }), createStarterPackMoneyLabel("pl"))).toEqual({
      starterStage: "graduation",
      starterAmountLabel: expect.stringContaining("280,00"),
      starterSteadyUnitCount: 28,
      starterSteadyCadenceDays: 28,
    });
  });

  it("(c) no marker: nothing at all", () => {
    expect(starterRenewalEmailFields(null, createStarterPackMoneyLabel("pl"))).toEqual({});
  });

  it("says nothing once the template has moved away from the frozen basis", () => {
    expect(starterRenewalEmailFields(context({ templateVersion: 2 }), createStarterPackMoneyLabel("pl"))).toEqual({});
    expect(
      starterRenewalEmailFields(context({ templateVersion: 2, upcomingCycleNumber: 3 }), createStarterPackMoneyLabel("pl")),
    ).toEqual({});
  });

  it("says nothing from delivery 4 on — the subscription is an ordinary one by then", () => {
    expect(starterRenewalEmailFields(context({ upcomingCycleNumber: 4 }), createStarterPackMoneyLabel("pl"))).toEqual({});
    expect(starterRenewalEmailFields(context({ upcomingCycleNumber: 1 }), createStarterPackMoneyLabel("pl"))).toEqual({});
  });

  it("drops the graduation amount rather than guessing when a frozen line has no subtotal", () => {
    const broken = {
      ...MARKER,
      graduation: {
        ...MARKER.graduation,
        lines: [{ ...MARKER.graduation.lines[0], quoteLine: {} }],
      },
    };
    expect(
      starterRenewalEmailFields(context({ marker: broken, upcomingCycleNumber: 3 }), createStarterPackMoneyLabel("pl")),
    ).toEqual({});
  });

  it("formats English amounts in the English locale", () => {
    const fields = starterRenewalEmailFields(context(), createStarterPackMoneyLabel("en"));
    expect(fields.starterAmountLabel).toContain("136.50");
  });
});

describe("starterWelcomeEmailFields", () => {
  it("states the delivery-2 amount and the steady plan", () => {
    expect(starterWelcomeEmailFields(context(), createStarterPackMoneyLabel("pl"))).toEqual({
      starterStage: "delivery2",
      starterAmountLabel: expect.stringContaining("136,50"),
      starterSteadyUnitCount: 28,
      starterSteadyCadenceDays: 28,
    });
  });

  it("is empty without a marker", () => {
    expect(starterWelcomeEmailFields(null, createStarterPackMoneyLabel("pl"))).toEqual({});
  });

  /**
   * P1-3: an outbox row can be delayed or retried, so the welcome send can land
   * after a customer edit. Every frozen number then describes a package that no
   * longer exists, and the e-mail must say nothing rather than quote an amount
   * the customer will never be charged.
   */
  it("says nothing once the template has moved off the frozen basis", () => {
    // Locale from the shared resolver, not a bare language tag: this surface
    // family's country-token ratchet is at its ceiling and a literal spends it.
    expect(starterWelcomeEmailFields(context({ templateVersion: 2 }), createStarterPackMoneyLabel(DEFAULT_LOCALE))).toEqual({});
  });

  it("is unaffected by the upcoming cycle number", () => {
    expect(starterWelcomeEmailFields(context({ upcomingCycleNumber: 9 }), createStarterPackMoneyLabel(DEFAULT_LOCALE))).toEqual(
      starterWelcomeEmailFields(context(), createStarterPackMoneyLabel(DEFAULT_LOCALE)),
    );
  });
});
