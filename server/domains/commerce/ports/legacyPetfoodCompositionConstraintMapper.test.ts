import { describe, expect, it } from "vitest";

import {
  PETFOOD_COMPOSITION_CONSTRAINT_KIND,
  PETFOOD_COMPOSITION_CONSTRAINT_VERSION,
  readLegacyPetfoodQuoteSizeConstraint,
  toCorePetfoodCompositionConstraint,
  toLegacyPetfoodCompositionConstraint,
  toLegacyPetfoodQuoteSizeConstraint,
} from "./legacyPetfoodCompositionConstraintMapper.js";

describe("legacy petfood composition constraint mapper", () => {
  it.each([
    ["full", {
      kind: "feeding_days",
      value: 28,
      dailyKcalOverride: 300,
      mode: "full",
      portionFactor: 1,
    }],
    ["topper", {
      kind: "feeding_days",
      value: 14,
      dailyKcalOverride: 420,
      mode: "topper",
      portionFactor: 0.5,
    }],
    ["unknown fields", {
      kind: "feeding_days",
      value: 21,
      dailyKcalOverride: 360,
      futureScalar: "preserve-me",
      futureNested: { flags: [true, false], note: null },
    }],
    ["opaque historical fields", {
      historicalKind: "pre-discriminator",
      arbitrary: { deeply: ["nested", 7, null] },
    }],
  ])("round-trips the %s persisted shape with deep equality", (_label, persisted) => {
    const envelope = toCorePetfoodCompositionConstraint(persisted);

    expect(envelope).toEqual({
      kind: PETFOOD_COMPOSITION_CONSTRAINT_KIND,
      version: PETFOOD_COMPOSITION_CONSTRAINT_VERSION,
      data: persisted,
    });
    expect(toLegacyPetfoodCompositionConstraint(envelope)).toEqual(persisted);
    expect(toLegacyPetfoodCompositionConstraint(envelope)).toBe(persisted);
    expect(toLegacyPetfoodQuoteSizeConstraint(envelope)).toBe(persisted);
  });

  it("maps absent legacy values to the historical empty-object constraint", () => {
    const envelope = toCorePetfoodCompositionConstraint(null);

    expect(envelope.data).toEqual({});
    expect(toLegacyPetfoodCompositionConstraint(envelope)).toEqual({});
    expect(readLegacyPetfoodQuoteSizeConstraint(null)).toBeUndefined();
  });

  it("rejects an envelope owned by another adapter or schema version", () => {
    expect(() => toLegacyPetfoodCompositionConstraint({
      kind: "fixed.catalog",
      version: 1,
      data: {},
    })).toThrow("subscription_reprice_invalid_composition_constraint_envelope");

    expect(() => toLegacyPetfoodCompositionConstraint({
      kind: PETFOOD_COMPOSITION_CONSTRAINT_KIND,
      version: 2,
      data: {},
    })).toThrow("subscription_reprice_invalid_composition_constraint_envelope");
  });
});
