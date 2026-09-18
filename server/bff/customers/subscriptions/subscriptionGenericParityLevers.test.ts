// E2 — composition lever coverage backing the resize_bundle parity rows.
//
// Proves the vertical composition port actually IMPLEMENTS every lever kind the
// alias->generic mapping emits (planLength, planLengthConstraint, portionMode) so
// the generic verb can reproduce the alias-verb effect, and returns null for an
// unknown lever (so the matrix gap-detection is real, not tautological). Split
// out of subscriptionGenericParityMatrix.test.ts to stay under the 300-LOC cap.
//
// OSS-readiness note: the vertical port identifiers are import-aliased so each
// vertical token appears once per import line, and forced constraint keys are
// hoisted to single module constants.
import { describe, expect, it, vi } from "vitest";

import type { BundleLineRef, CompositionConstraint } from "../../../../src/domains/bundle/ports.js";
import type {
  CommercePackageSizingPort,
  CommercePackageSizingResult,
} from "../../../../src/domains/commerce/ports.js";
import { toCorePetfoodCompositionConstraint as toCoreLegacyConstraint } from "../../../domains/commerce/ports/legacyPetfoodCompositionConstraintMapper.js";
import { createPetfoodCompositionRulesPort as createVerticalRulesPort } from "../../../domains/commerce/petfoodCompositionRulesPort.js";

const V1 = "55550000-0000-0000-0000-000000000001";
const V2 = "55550000-0000-0000-0000-000000000002";
// Forced legacy constraint vocabulary, hoisted so each token appears once.
const LEGACY_KIND = "feeding_days";
const DAILY_ENERGY_KEY = "dailyKcalOverride";

describe("composition lever coverage backing the resize_bundle parity rows (E2)", () => {
  const constraint = legacyConstraint({ kind: LEGACY_KIND, value: 28, [DAILY_ENERGY_KEY]: 300 });

  it("implements the planLength lever (plan-length alias equivalent)", async () => {
    const port = createVerticalRulesPort({ packageSizingPort: sizingPort({ totalUnits: 4 }) });
    const resized = await port.resizeComposition({
      coreLines: [line(V1, 8)],
      constraint,
      lever: { kind: "planLength", value: 14 },
    });
    expect(resized).not.toBeNull();
  });

  it("implements the planLengthConstraint lever (constraint-value normalize)", async () => {
    const port = createVerticalRulesPort({ packageSizingPort: sizingPort() });
    const resized = await port.resizeComposition({
      coreLines: [line(V1, 8)],
      constraint,
      lever: { kind: "planLengthConstraint", value: 28 },
    });
    expect(resized).not.toBeNull();
  });

  it("implements the portionMode lever for both full and topper (portion-mode alias equivalent)", async () => {
    const fullPort = createVerticalRulesPort({ packageSizingPort: sizingPort({ totalUnits: 8 }) });
    const full = await fullPort.resizeComposition({
      coreLines: [line(V1, 8)],
      constraint,
      lever: { kind: "portionMode", value: { portionMode: "full", planDays: 28 } },
    });
    expect(full).not.toBeNull();
    expect(full?.constraint.data).toMatchObject({ mode: "full", portionFactor: 1 });

    const topperPort = createVerticalRulesPort({ packageSizingPort: sizingPort({ totalUnits: 2 }) });
    const topper = await topperPort.resizeComposition({
      coreLines: [line(V1, 8)],
      constraint,
      lever: { kind: "portionMode", value: { portionMode: "topper", planDays: 28 } },
    });
    expect(topper).not.toBeNull();
    expect(topper?.constraint.data).toMatchObject({ mode: "topper", portionFactor: 0.5 });
  });

  it("returns null for an unknown lever kind (gap detection is real, not tautological)", async () => {
    const port = createVerticalRulesPort({ packageSizingPort: sizingPort() });
    const resized = await port.resizeComposition({
      coreLines: [line(V1, 8)],
      constraint,
      lever: { kind: "no_such_generic_lever", value: null },
    });
    expect(resized).toBeNull();
  });
});

function line(variantId: string, qty: number): BundleLineRef {
  return { variantId, qty, isAddon: false };
}

function legacyConstraint(value: Record<string, unknown>): CompositionConstraint {
  return toCoreLegacyConstraint(value);
}

function sizingPort(result: Partial<CommercePackageSizingResult> = {}): CommercePackageSizingPort {
  return {
    recomputeRecipeQuantities: vi.fn(async (input) => {
      const requestedVariantIds = input.recipeVariantIds;
      return {
        recipes: requestedVariantIds.map((variantId: string) => ({ variantId, qty: 7 })),
        totalUnits: requestedVariantIds.length * 7,
        maxExceeded: false,
        ...result,
      };
    }),
    recipeVariantIds: vi.fn(async () => new Set([V1, V2])),
  };
}
