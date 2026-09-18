import { describe, expect, it } from "vitest";
import {
  kilogramsToPounds,
  petAgeFieldSchema,
  petNameFieldSchema,
  petTypeFieldSchema,
  petWeightKgFieldSchema,
  poundsToKilograms,
  publicPetAgeOptions,
  validatePetAgeField,
  validatePetWeightKgField,
} from "./index";

describe("canonical pet field schemas", () => {
  it("validates canonical public pet type and age enums", () => {
    expect(petTypeFieldSchema().parse(" DOG ")).toBe("dog");
    expect(petAgeFieldSchema().parse("young")).toBe("young");
    expect(petTypeFieldSchema().safeParse("rabbit").success).toBe(false);
    expect(petAgeFieldSchema().safeParse("12 years").success).toBe(false);
  });

  it("exposes canonical public pet age options", () => {
    expect(publicPetAgeOptions).toEqual([
      { value: "puppy", labelKey: "forms:fields.petAge.options.puppy" },
      { value: "young", labelKey: "forms:fields.petAge.options.young" },
      { value: "adult", labelKey: "forms:fields.petAge.options.adult" },
      { value: "senior", labelKey: "forms:fields.petAge.options.senior" },
    ]);
  });

  it("supports admin legacy text pet ages without making public enum looser", () => {
    expect(petAgeFieldSchema({ ageMode: "adminLegacyText" }).parse("  12 years ")).toBe(
      "12 years",
    );

    const legacy = validatePetAgeField("12 years", {
      mode: "legacyPermissive",
    });
    expect(legacy.success).toBe(true);
    expect(legacy.warnings[0]?.messageKey).toBe("forms:fields.petAge.invalid");
  });

  it("normalizes pet names and kg weights", () => {
    expect(petNameFieldSchema().parse("  Mr   Pickles ")).toBe("Mr Pickles");
    expect(petWeightKgFieldSchema().parse("12,5")).toBe(12.5);
    expect(petWeightKgFieldSchema().parse("")).toBeNull();
    expect(poundsToKilograms(22)).toBe(9.98);
    expect(kilogramsToPounds(9.98)).toBe(22);
  });

  it("rejects impossible strict weights but keeps warning-only compatibility", () => {
    expect(petWeightKgFieldSchema().safeParse("500").success).toBe(false);

    const warning = validatePetWeightKgField("500", { mode: "warningOnly" });
    expect(warning.success).toBe(true);
    expect(warning.value).toBe(500);
    expect(warning.warnings[0]?.messageKey).toBe("forms:fields.petWeight.invalid");
  });
});
