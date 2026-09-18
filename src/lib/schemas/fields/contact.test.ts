import { describe, expect, it } from "vitest";
import {
  countryFieldSchema,
  countryLabelForIso,
  countryOptions,
  legacyCountryLabelForIso,
  isPolandCountry,
  formatPostalCodeForCountry,
  normalizeCountryIso,
  normalizePhoneToE164,
  normalizePostalCode,
  phoneFieldSchema,
  postalCodeFieldSchema,
  validateCountryField,
  validatePhoneField,
  validatePostalCodeField,
} from "./index";

describe("canonical contact field schemas", () => {
  it("canonicalizes ISO countries and legacy country labels", () => {
    expect(normalizeCountryIso("pl")).toBe("PL");
    expect(normalizeCountryIso("Polska")).toBe("PL");
    expect(normalizeCountryIso("Poland")).toBe("PL");
    expect(normalizeCountryIso("Germany")).toBe("DE");
    expect(countryFieldSchema().parse(" pl ")).toBe("PL");
    expect(isPolandCountry("Polska")).toBe(true);
    expect(countryFieldSchema().safeParse("ZZ").success).toBe(false);
  });

  it("exposes canonical country options for field components", () => {
    expect(countryOptions.map((option) => option.iso)).toContain("PL");
    expect(countryLabelForIso("PL", "pl")).toBe("Polska");
    expect(countryLabelForIso("Poland", "en")).toBe("Poland");
    expect(legacyCountryLabelForIso("Polska", "pl")).toBe("Polska");
    expect(legacyCountryLabelForIso("PL", "en")).toBe("Poland");
  });

  it("distinguishes strict country errors from legacy warnings", () => {
    expect(countryFieldSchema().safeParse("Atlantis").success).toBe(false);

    const legacy = validateCountryField("Atlantis", { mode: "legacyPermissive" });
    expect(legacy.success).toBe(true);
    expect(legacy.warnings[0]?.messageKey).toBe("forms:fields.country.invalid");
    expect(countryFieldSchema({ mode: "legacyPermissive" }).parse("Atlantis")).toBe("Atlantis");
  });

  it("normalizes PL, US and international phone numbers to E.164", () => {
    expect(normalizePhoneToE164("123 456 789", "Polska")).toBe("+48123456789");
    expect(phoneFieldSchema({ country: "PL" }).parse("+48 123 456 789")).toBe("+48123456789");
    expect(phoneFieldSchema({ country: "US" }).parse("(213) 373-4253")).toBe("+12133734253");
    expect(phoneFieldSchema().parse("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("keeps legacy invalid phones as warnings in non-blocking modes", () => {
    expect(phoneFieldSchema({ country: "PL" }).safeParse("123").success).toBe(false);

    const warning = validatePhoneField("123", { country: "PL", mode: "warningOnly" });
    expect(warning.success).toBe(true);
    expect(warning.value).toBe("123");
    expect(warning.warnings[0]?.messageKey).toBe("forms:fields.phone.invalid");
    expect(normalizePhoneToE164("123", "ZZ")).toBeNull();
  });

  it("validates postal codes by country with an international fallback", () => {
    expect(normalizePostalCode(" sw1a 1aa ")).toBe("SW1A 1AA");
    expect(postalCodeFieldSchema({ country: "PL" }).parse("00-001")).toBe("00-001");
    expect(postalCodeFieldSchema({ country: "US" }).parse("90210")).toBe("90210");
    expect(postalCodeFieldSchema({ country: "DE" }).parse("10115")).toBe("10115");
    expect(postalCodeFieldSchema({ country: "PL" }).safeParse("ABC").success).toBe(false);
  });

  it("auto-formats bare five-digit Polish codes to NN-NNN", () => {
    // The recurring `05074` case: accepted and canonicalised to `05-074`.
    expect(postalCodeFieldSchema({ country: "PL" }).parse("05074")).toBe("05-074");
    expect(postalCodeFieldSchema({ country: "PL" }).parse("05 074")).toBe("05-074");
    expect(postalCodeFieldSchema({ country: "PL" }).parse("05-074")).toBe("05-074");
    expect(formatPostalCodeForCountry("05074", "Polska")).toBe("05-074");
    // Wrong length or non-numeric still fails; non-PL is left untouched.
    expect(postalCodeFieldSchema({ country: "PL" }).safeParse("5074").success).toBe(false);
    expect(formatPostalCodeForCountry("90210", "US")).toBe("90210");
  });

  it("reports postal warnings without blocking warning-only flows", () => {
    const warning = validatePostalCodeField("ABC", {
      country: "PL",
      mode: "warningOnly",
    });

    expect(warning.success).toBe(true);
    expect(warning.warnings[0]?.messageKey).toBe("forms:fields.postalCode.invalid");
  });
});
