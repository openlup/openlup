import { describe, expect, it } from "vitest";
import type { CommerceRecommendationSnapshot } from "@/domains/commerce/recommendationContracts";
import {
  changeConfiguratorPackageQuantity,
  resolveConfiguratorPackageQuantities,
} from "./configuratorPackageQuantities";

describe("configurator package quantities", () => {
  it("changes only the targeted line and keeps the server snapshot immutable", () => {
    const baseline = deepFreeze(snapshot([8, 6]));

    const increased = changeConfiguratorPackageQuantity(baseline, {}, "variant-beef", 1);
    expect(quantities(increased.snapshot)).toEqual({ lamb: 8, beef: 7 });
    expect(increased.totalUnits).toBe(15);
    expect(increased.overrides).toEqual({ "variant-beef": 7 });
    expect(baseline.lines.map((line) => line.qty)).toEqual([8, 6]);

    const decreased = changeConfiguratorPackageQuantity(
      baseline,
      increased.overrides,
      "variant-lamb",
      -1,
    );
    expect(quantities(decreased.snapshot)).toEqual({ lamb: 7, beef: 7 });
    expect(decreased.overrides).toEqual({ "variant-lamb": 7, "variant-beef": 7 });
  });

  it("supports a one-line package in both directions without crossing MOQ", () => {
    const baseline = snapshot([14]);
    const belowMinimum = changeConfiguratorPackageQuantity(baseline, {}, "variant-lamb", -1);
    expect(belowMinimum).toMatchObject({ changeApplied: false, blockReason: "minimum_order" });
    expect(belowMinimum.snapshot).toBe(baseline);

    const up = changeConfiguratorPackageQuantity(baseline, {}, "variant-lamb", 1);
    expect(up.snapshot.lines[0]?.qty).toBe(15);
    const restored = changeConfiguratorPackageQuantity(
      baseline,
      up.overrides,
      "variant-lamb",
      -1,
    );
    expect(restored.snapshot).toBe(baseline);
    expect(restored.overrides).toEqual({});
    expect(restored.customized).toBe(false);
  });

  it("blocks MOQ as a no-op without discarding other valid customizations", () => {
    const baseline = snapshot([8, 6]);
    const current = resolveConfiguratorPackageQuantities(baseline, {
      "variant-lamb": 7,
      "variant-beef": 7,
    });
    const blocked = changeConfiguratorPackageQuantity(
      baseline,
      current.overrides,
      "variant-lamb",
      -1,
    );

    expect(blocked).toMatchObject({ changeApplied: false, blockReason: "minimum_order" });
    expect(quantities(blocked.snapshot)).toEqual({ lamb: 7, beef: 7 });
    expect(blocked.overrides).toEqual(current.overrides);
  });

  it("ignores invalid, unknown, stale and ambiguous persisted overrides", () => {
    const baseline = snapshot([8, 6]);
    baseline.lines.push({ ...baseline.lines[0], slug: "turkey" });
    const resolved = resolveConfiguratorPackageQuantities(baseline, {
      "variant-beef": 7,
      "variant-lamb": 9,
      unknown: 20,
      zero: 0,
      decimal: 2.5,
      string: "10",
      huge: 100,
      nan: Number.NaN,
    });

    expect(resolved.overrides).toEqual({ "variant-beef": 7 });
    expect(resolved.snapshot.lines.map((line) => line.qty)).toEqual([8, 7, 8]);
  });

  it("falls back atomically to baseline when hydrated overrides would violate MOQ", () => {
    const baseline = snapshot([8, 6]);
    const resolved = resolveConfiguratorPackageQuantities(baseline, {
      "variant-lamb": 6,
      "variant-beef": 7,
    });

    expect(resolved.snapshot).toBe(baseline);
    expect(resolved.overrides).toEqual({});
    expect(resolved.totalUnits).toBe(14);
    expect(resolved.customized).toBe(false);
  });

  it.each([0, -1, 1.5, 100, Number.NaN, Number.POSITIVE_INFINITY, "7", null])(
    "ignores invalid quantity %s for an existing line",
    (invalid) => {
      const baseline = snapshot([8, 6]);
      const resolved = resolveConfiguratorPackageQuantities(baseline, {
        "variant-lamb": invalid,
      });

      expect(resolved.snapshot).toBe(baseline);
      expect(resolved.overrides).toEqual({});
    },
  );

  it("enforces line bounds and prunes values restored to baseline", () => {
    const baseline = snapshot([98, 6]);
    const atMax = changeConfiguratorPackageQuantity(baseline, {}, "variant-lamb", 1);
    expect(atMax.snapshot.lines[0]?.qty).toBe(99);
    expect(changeConfiguratorPackageQuantity(
      baseline,
      atMax.overrides,
      "variant-lamb",
      1,
    )).toMatchObject({ changeApplied: false, blockReason: "line_maximum" });

    const restored = changeConfiguratorPackageQuantity(
      baseline,
      atMax.overrides,
      "variant-lamb",
      -1,
    );
    expect(restored.overrides).toEqual({});
    expect(restored.snapshot).toBe(baseline);

    const oneCan = snapshot([13, 1]);
    expect(changeConfiguratorPackageQuantity(
      oneCan,
      {},
      "variant-beef",
      -1,
    )).toMatchObject({ changeApplied: false, blockReason: "line_minimum" });
  });

  it("applies sellableNow only to increases when stock bounding is enabled", () => {
    const baseline = snapshot([9, 6]);
    baseline.lines[0].sellableNow = 9;

    const capped = changeConfiguratorPackageQuantity(
      baseline,
      {},
      "variant-lamb",
      1,
      { stockBounded: true },
    );
    expect(capped).toMatchObject({ changeApplied: false, blockReason: "stock_limit" });

    const decrease = changeConfiguratorPackageQuantity(
      baseline,
      {},
      "variant-lamb",
      -1,
      { stockBounded: true },
    );
    expect(decrease.snapshot.lines[0]?.qty).toBe(8);

    const unbounded = changeConfiguratorPackageQuantity(
      baseline,
      {},
      "variant-lamb",
      1,
      { stockBounded: false },
    );
    expect(unbounded.snapshot.lines[0]?.qty).toBe(10);
  });

  it("recomputes nutritional totals and removes stale calculator quantity reasons", () => {
    const baseline = snapshot([8, 6]);
    baseline.reasonCodes = [
      "energy_policy_fediaf_2025",
      "preferred_flavors_used",
      "quantity_rounded_to_full_cans",
      "minimum_order_quantity_applied",
      "max_order_quantity_exceeded",
      "large_package_warning",
      "package_rebalanced_to_target_kcal",
      "stock_bounded_quantities_applied",
      "stock_limited_below_target",
    ];

    const result = resolveConfiguratorPackageQuantities(baseline, { "variant-beef": 7 });

    expect(result.snapshot.totalWeightG).toBe(6_000);
    expect(result.snapshot.feedingDays).toBe(24);
    expect(result.snapshot.dailyGrams).toBe(250);
    expect(result.snapshot.energy.dailyGrams).toBe(250);
    expect(result.snapshot.reasonCodes).toEqual([
      "energy_policy_fediaf_2025",
      "preferred_flavors_used",
    ]);
    expect(baseline.totalWeightG).toBe(5_600);
    expect(baseline.reasonCodes).toContain("minimum_order_quantity_applied");
  });

  it("keeps nullable nutrition evidence coherent when daily kcal is unavailable", () => {
    const baseline = snapshot([8, 6]);
    baseline.dailyKcal = null;
    baseline.dailyGrams = null;
    baseline.energy.dailyKcal = null;
    baseline.energy.dailyGrams = null;

    const result = resolveConfiguratorPackageQuantities(baseline, { "variant-beef": 7 });
    expect(result.snapshot).toMatchObject({ feedingDays: null, dailyGrams: null });
    expect(result.snapshot.energy.dailyGrams).toBeNull();
  });

  it("allows increases beyond 120 days of coverage without changing cadence policy", () => {
    const baseline = snapshot([37, 37]);
    const first = changeConfiguratorPackageQuantity(
      baseline,
      {},
      "variant-lamb",
      1,
    );
    expect(first).toMatchObject({ changeApplied: true, blockReason: null });

    const second = changeConfiguratorPackageQuantity(
      baseline,
      first.overrides,
      "variant-lamb",
      1,
    );
    expect(second).toMatchObject({ changeApplied: true, blockReason: null });
    expect(second.snapshot.lines.map((line) => line.qty)).toEqual([39, 37]);

    const persistedPackage = resolveConfiguratorPackageQuantities(
      baseline,
      { "variant-lamb": 39 },
    );
    expect(persistedPackage.customized).toBe(true);
    expect(persistedPackage.snapshot.lines.map((line) => line.qty)).toEqual([39, 37]);
    expect(Math.round(persistedPackage.snapshot.feedingDays ?? 0)).toBeGreaterThan(120);
  });

  it("preserves all invariants through a long mixed sequence", () => {
    const baseline = deepFreeze(snapshot([8, 6, 4]));
    const ids = baseline.lines.map((line) => line.variantId);
    let overrides: unknown = {};
    let seed = 17;

    for (let index = 0; index < 500; index += 1) {
      seed = (seed * 48_271) % 2_147_483_647;
      const targetId = ids[seed % ids.length] ?? "unknown";
      const delta = seed % 2 === 0 ? 1 : -1;
      const before = resolveConfiguratorPackageQuantities(baseline, overrides, {
        stockBounded: true,
      });
      const after = changeConfiguratorPackageQuantity(
        baseline,
        overrides,
        targetId,
        delta,
        { stockBounded: true },
      );

      expect(after.totalUnits).toBeGreaterThanOrEqual(14);
      expect(after.snapshot.lines.every((line) => line.qty >= 1 && line.qty <= 99)).toBe(true);
      if (after.changeApplied) {
        for (const line of after.snapshot.lines) {
          if (line.variantId === targetId) continue;
          expect(line.qty).toBe(
            before.snapshot.lines.find((candidate) => candidate.variantId === line.variantId)?.qty,
          );
        }
      }
      overrides = after.overrides;
    }

    expect(baseline.lines.map((line) => line.qty)).toEqual([8, 6, 4]);
  });
});

function snapshot(quantities: number[]): CommerceRecommendationSnapshot {
  const slugs = ["lamb", "beef", "turkey"];
  const lines = quantities.map((qty, index) => ({
    variantId: `variant-${slugs[index]}`,
    sku: `SKU-${slugs[index]}`,
    slug: slugs[index] ?? `flavor-${index}`,
    qty,
    netWeightG: 400,
    kcalPerUnit: 320,
    allergenSlugs: [],
    purchaseAvailability: "available" as const,
    sellableNow: null,
  }));
  const totalWeightG = quantities.reduce((sum, qty) => sum + qty * 400, 0);
  const totalKcal = quantities.reduce((sum, qty) => sum + qty * 320, 0);

  return {
    version: "commerce-recommendation.v2",
    status: "ready_to_buy",
    reasonCodes: ["energy_policy_fediaf_2025", "quantity_rounded_to_full_cans"],
    energy: {
      policyVersion: "commerce.energy_policy.fediaf_2025_adult_dog_mer.v2",
      source: "fediaf_2025_adult_dog_mer",
      ageBand: "adult",
      activityLevel: "normal",
      bcs: "ideal",
      kcalPerKgBodyWeight075: 95,
      dailyKcal: 200,
      dailyGrams: 250,
    },
    dailyKcal: 200,
    dailyGrams: 250,
    totalWeightG,
    feedingDays: Math.round((totalKcal / 200) * 10) / 10,
    desiredSizeKind: "feeding_days",
    cadenceDays: 14,
    lines,
    allergenConflicts: [],
    excludedProducts: [],
    allergenOverrideRecorded: false,
  };
}

function quantities(snapshot: CommerceRecommendationSnapshot): Record<string, number> {
  return Object.fromEntries(snapshot.lines.map((line) => [line.slug, line.qty]));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
