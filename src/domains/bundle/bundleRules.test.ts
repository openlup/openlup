import { describe, expect, it } from "vitest";

import {
  BUNDLE_ALLOCATION_RULE_CODE,
  BUNDLE_RULE_CODES,
  BUNDLE_RULE_ENFORCEMENT,
} from "./bundleRuleCodes.js";
import {
  evaluateBundleComposition,
  evaluateBundleCompositionConstraint,
  evaluateBundleFulfillmentMode,
  evaluateBundleTargetPrice,
  evaluateBundleWriteRules,
  isEmptyCompositionConstraint,
} from "./bundleRules.js";

const CORE = { sku: "UNIT-A", quantity: 1, isAddon: false };
const ADDON = { sku: "UNIT-B", quantity: 1, isAddon: true };

describe("bundle rule registry", () => {
  it("classifies every declared rule as request-, port- or boundary-enforced", () => {
    for (const code of BUNDLE_RULE_CODES) {
      expect(BUNDLE_RULE_ENFORCEMENT[code]).toMatch(/^(request|port|rpc)$/);
    }
    expect(Object.keys(BUNDLE_RULE_ENFORCEMENT).sort()).toEqual([...BUNDLE_RULE_CODES].sort());
  });

  it("maps every kernel allocation failure onto a declared rule code", () => {
    for (const mapped of Object.values(BUNDLE_ALLOCATION_RULE_CODE)) {
      expect(BUNDLE_RULE_CODES).toContain(mapped);
    }
  });
});

describe("evaluateBundleWriteRules — the actor gate", () => {
  it("confines a machine actor to drafts: neither publish nor unpublish", () => {
    expect(evaluateBundleWriteRules({ operation: "activate", actorKind: "machine" })).toEqual({
      ok: false,
      violations: ["DRAFT_ONLY_FOR_MACHINE"],
    });
    expect(evaluateBundleWriteRules({ operation: "deactivate", actorKind: "machine" })).toEqual({
      ok: false,
      violations: ["DRAFT_ONLY_FOR_MACHINE"],
    });
  });

  it("lets a machine actor compose, price, archive, restore and clone", () => {
    for (const operation of [
      "create_draft",
      "update_draft",
      "set_composition",
      "set_target_price",
      "archive",
      "restore",
      "clone_draft",
    ]) {
      expect(evaluateBundleWriteRules({ operation, actorKind: "machine" }).ok).toBe(true);
    }
  });

  it("lets a human perform both publish-state transitions at this layer", () => {
    expect(evaluateBundleWriteRules({ operation: "activate", actorKind: "human" }).ok).toBe(true);
    expect(evaluateBundleWriteRules({ operation: "deactivate", actorKind: "human" }).ok).toBe(true);
  });
});

describe("evaluateBundleComposition — properties of the whole set", () => {
  it("accepts a set with at least one component that is not an add-on", () => {
    expect(evaluateBundleComposition([CORE, ADDON])).toEqual({ ok: true, violations: [] });
  });

  it("refuses an empty set", () => {
    expect(evaluateBundleComposition([]).violations).toEqual(["MIN_COMPONENTS"]);
  });

  it("refuses a set that is nothing but optional extras", () => {
    expect(evaluateBundleComposition([ADDON]).violations).toEqual(["ADDON_ONLY_COMPOSITION"]);
  });

  it("refuses a unit named twice: multiplicity is the quantity, not a repeated row", () => {
    expect(
      evaluateBundleComposition([CORE, { ...CORE, quantity: 2 }]).violations,
    ).toEqual(["DUPLICATE_COMPONENT"]);
  });

  it("reports the duplicate once, however many times the unit repeats", () => {
    const result = evaluateBundleComposition([CORE, CORE, CORE]);
    expect(result.violations).toEqual(["DUPLICATE_COMPONENT"]);
  });
});

describe("evaluateBundleFulfillmentMode — the runtime refusal the column cannot make", () => {
  it("accepts the exploded mode", () => {
    expect(evaluateBundleFulfillmentMode("virtual").ok).toBe(true);
  });

  it("refuses the pre-packed mode the column admits but no code honours", () => {
    expect(evaluateBundleFulfillmentMode("kitted").violations).toEqual([
      "FULFILLMENT_MODE_UNSUPPORTED",
    ]);
  });
});

describe("evaluateBundleTargetPrice — the kernel allocator's decision, projected", () => {
  const components = [
    { sku: "UNIT-A", unitPriceMinor: 1000, quantity: 2 },
    { sku: "UNIT-B", unitPriceMinor: 500, quantity: 1 },
  ];

  it("accepts a target below the component sum", () => {
    expect(evaluateBundleTargetPrice({ components, targetPriceMinor: 2000 }).ok).toBe(true);
  });

  it("refuses a target above the component sum, and calls it by that name", () => {
    expect(
      evaluateBundleTargetPrice({ components, targetPriceMinor: 2600 }).violations,
    ).toEqual(["TARGET_ABOVE_COMPONENT_SUM"]);
  });

  it("refuses a target that cannot cover every unit's minimum payable amount", () => {
    expect(
      evaluateBundleTargetPrice({
        components,
        targetPriceMinor: 1,
        minimumUnitPayableMinor: 100,
      }).violations,
    ).toEqual(["TARGET_BELOW_FLOOR"]);
  });

  it("reports a weightless composition as the same condition the request layer names", () => {
    expect(
      evaluateBundleTargetPrice({
        components: [{ sku: "UNIT-A", unitPriceMinor: 0, quantity: 1 }],
        targetPriceMinor: 0,
      }).violations,
    ).toEqual(["MIN_COMPONENTS"]);
  });
});

describe("evaluateBundleCompositionConstraint — delegation, never interpretation", () => {
  const constraint = { kind: "fixed.catalog", version: 1, data: { slots: 2 } };

  it("treats a missing or empty envelope as unconstrained", async () => {
    expect(isEmptyCompositionConstraint(null)).toBe(true);
    expect(isEmptyCompositionConstraint({ kind: "  ", version: 1, data: {} })).toBe(true);
    await expect(
      evaluateBundleCompositionConstraint(undefined, { components: [CORE], constraint: null }),
    ).resolves.toEqual({ ok: true, violations: [] });
  });

  it("stores an envelope unvalidated when no rules port is supplied", async () => {
    await expect(
      evaluateBundleCompositionConstraint(undefined, { components: [CORE], constraint }),
    ).resolves.toEqual({ ok: true, violations: [] });
  });

  it("splits core and add-on lines for the port and reports its refusal under one code", async () => {
    const seen: unknown[] = [];
    const port = {
      validateComposition: async (input: unknown) => {
        seen.push(input);
        return { ok: false as const, code: "slots_exceeded" };
      },
      resizeComposition: async () => null,
    };
    await expect(
      evaluateBundleCompositionConstraint(port, { components: [CORE, ADDON], constraint }),
    ).resolves.toEqual({ ok: false, violations: ["CONSTRAINT_VALIDATION_FAILED"] });
    expect(seen).toEqual([
      {
        coreLines: [{ variantId: "UNIT-A", qty: 1, isAddon: false }],
        addonLines: [{ variantId: "UNIT-B", qty: 1, isAddon: true }],
        constraint,
      },
    ]);
  });

  it("passes when the port accepts the set", async () => {
    const port = {
      validateComposition: async () => ({ ok: true as const }),
      resizeComposition: async () => null,
    };
    await expect(
      evaluateBundleCompositionConstraint(port, { components: [CORE], constraint }),
    ).resolves.toEqual({ ok: true, violations: [] });
  });
});
