import { describe, expect, it } from "vitest";

import type { SubscriptionCatalogProduct } from "@/domains/subscription/subscriptionCatalogContracts";
import {
  addRecipe,
  addonVariantIds,
  currentRecipeSlug,
  decrementRecipe,
  evenSplitMix,
  incrementRecipe,
  isRescheduleDateDisabled,
  MIX_LINE_MAX,
  petForSubscription,
  primaryRecipeLine,
  recipeMixFromSubscription,
  recipeMixTotal,
  removeRecipe,
  rescheduleLowerBound,
  rescheduleUpperBound,
  type Pet,
  type Subscription,
} from "./subscriptionEditModel";

const NOW = new Date("2026-06-12T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function line(overrides: Partial<Subscription["lines"][number]>) {
  return {
    lineId: "00000000-0000-0000-0000-000000000001",
    variantId: "var-beef",
    qty: 1,
    sortOrder: 0,
    isAddon: false,
    title: "Karma wolowa",
    sku: "dog-beef",
    recipeName: "wolowa",
    ...overrides,
  } as Subscription["lines"][number];
}

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    subscriptionId: "sub-1",
    petId: "pet-1",
    status: "active",
    cadenceDays: 28,
    nextCycleAt: "2026-06-20T10:00:00+00:00",
    editCutoffAt: "2026-06-18T10:00:00+00:00",
    canEditUpcomingPackage: true,
    editBlockedReason: null,
    paymentMethodKind: "card",
    templateVersion: 1,
    sizeConstraint: null,
    packageSummary: "1 recipe",
    lines: [line({})],
    ...overrides,
  } as Subscription;
}

const products: SubscriptionCatalogProduct[] = [
  { variantId: "var-beef", sku: "dog-beef", slug: "beef", selectable: true, conflictAllergenSlugs: [] },
  { variantId: "var-lamb", sku: "dog-lamb", slug: "lamb", selectable: true, conflictAllergenSlugs: [] },
];

describe("reschedule window", () => {
  it("lower bound is the 3-day operational floor even when the current cutoff is later", () => {
    expect(rescheduleLowerBound(NOW, "2026-06-18T10:00:00+00:00").toISOString()).toBe(
      "2026-06-15T12:00:00.000Z",
    );
  });

  it("lower bound falls back to now+3d when there is no cutoff", () => {
    expect(rescheduleLowerBound(NOW, null).getTime()).toBe(NOW.getTime() + 3 * DAY);
  });

  it("upper bound is now+60d", () => {
    expect(rescheduleUpperBound(NOW).getTime()).toBe(NOW.getTime() + 60 * DAY);
  });

  it("disables dates before the operational floor and beyond the horizon", () => {
    const disabled = isRescheduleDateDisabled(NOW, "2026-06-18T10:00:00+00:00");
    expect(disabled(new Date("2026-06-14T12:00:00Z"))).toBe(true);
    expect(disabled(new Date("2026-06-16T12:00:00Z"))).toBe(false);
    expect(disabled(new Date("2026-06-20T12:00:00Z"))).toBe(false);
    expect(disabled(new Date("2026-09-01T12:00:00Z"))).toBe(true);
  });
});

describe("recipe and addon mapping", () => {
  it("identifies the primary recipe line and its catalog slug", () => {
    const sub = subscription();
    expect(primaryRecipeLine(sub)?.variantId).toBe("var-beef");
    expect(currentRecipeSlug(sub, [...products])).toBe("beef");
  });

  it("collects addon variant ids", () => {
    const sub = subscription({
      lines: [line({}), line({ lineId: "l2", variantId: "var-salmon", isAddon: true })],
    });
    expect([...addonVariantIds(sub)]).toEqual(["var-salmon"]);
  });

  it("resolves the pet that gates compatibility", () => {
    const pet = { petId: "pet-1", breed: "beagle", allergies: ["chicken"] } as Pet;
    expect(petForSubscription(subscription(), [pet])?.petId).toBe("pet-1");
    expect(petForSubscription(subscription({ petId: null }), [pet])).toBeNull();
  });
});

describe("mix with independent line quantities", () => {
  const A = "var-a";
  const B = "var-b";
  const C = "var-c";
  const total = (mix: ReturnType<typeof recipeMixFromSubscription>) =>
    mix.reduce((sum, entry) => sum + entry.qty, 0);

  it("increments only the target line and grows the total", () => {
    const next = incrementRecipe([{ variantId: A, qty: 2 }, { variantId: B, qty: 6 }], A);
    expect(next).toEqual([{ variantId: A, qty: 3 }, { variantId: B, qty: 6 }]);
    expect(recipeMixTotal(next)).toBe(9);
  });

  it("caps a line at the per-line maximum", () => {
    const mix = [{ variantId: A, qty: MIX_LINE_MAX }, { variantId: B, qty: 1 }];
    expect(incrementRecipe(mix, A)).toBe(mix);
  });

  it("decrements only the target line and shrinks the total", () => {
    const next = decrementRecipe([{ variantId: A, qty: 5 }, { variantId: B, qty: 3 }], A);
    expect(next).toEqual([{ variantId: A, qty: 4 }, { variantId: B, qty: 3 }]);
    expect(recipeMixTotal(next)).toBe(7);
  });

  it("removes the line when decrementing it from qty 1", () => {
    const next = decrementRecipe([{ variantId: A, qty: 1 }, { variantId: B, qty: 7 }], A);
    expect(next).toEqual([{ variantId: B, qty: 7 }]);
  });

  it("refuses to decrement away the last remaining line", () => {
    const mix = [{ variantId: A, qty: 1 }];
    expect(decrementRecipe(mix, A)).toBe(mix);
  });

  it("appends a new line at qty 1 without a donor", () => {
    const next = addRecipe([{ variantId: A, qty: 5 }, { variantId: B, qty: 3 }], C);
    expect(next).toEqual([
      { variantId: A, qty: 5 },
      { variantId: B, qty: 3 },
      { variantId: C, qty: 1 },
    ]);
    expect(total(next)).toBe(9);
  });

  it("removes a line without redistributing its cans", () => {
    const next = removeRecipe([{ variantId: A, qty: 2 }, { variantId: B, qty: 3 }, { variantId: C, qty: 3 }], C);
    expect(next).toEqual([{ variantId: A, qty: 2 }, { variantId: B, qty: 3 }]);
    expect(total(next)).toBe(5);
  });

  it("refuses to remove the last recipe", () => {
    const mix = [{ variantId: A, qty: 8 }];
    expect(removeRecipe(mix, A)).toBe(mix);
  });

  it("never stores a qty of 0 or above the per-line maximum", () => {
    let mix = [{ variantId: A, qty: 3 }, { variantId: B, qty: 2 }, { variantId: C, qty: 1 }];
    const ops = [
      () => { mix = decrementRecipe(mix, C); },
      () => { mix = decrementRecipe(mix, B); },
      () => { mix = decrementRecipe(mix, B); },
      () => { mix = decrementRecipe(mix, A); },
      () => { mix = decrementRecipe(mix, A); },
      () => { mix = decrementRecipe(mix, A); },
      () => { mix = addRecipe(mix, C); },
      () => { mix = incrementRecipe(mix, C); },
      () => { mix = removeRecipe(mix, A); },
    ];
    for (const op of ops) {
      op();
      expect(mix.length).toBeGreaterThanOrEqual(1);
      for (const entry of mix) {
        expect(entry.qty).toBeGreaterThanOrEqual(1);
        expect(entry.qty).toBeLessThanOrEqual(MIX_LINE_MAX);
      }
    }
  });

  it("splits a total evenly with the remainder on the first recipes", () => {
    expect(evenSplitMix(8, [A, B, C])).toEqual([
      { variantId: A, qty: 3 },
      { variantId: B, qty: 3 },
      { variantId: C, qty: 2 },
    ]);
  });
});
