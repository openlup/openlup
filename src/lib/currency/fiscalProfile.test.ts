import { describe, expect, it } from "vitest";
import {
  InvalidFiscalProfileError,
  InvalidMinimumProductPayableError,
  PLATFORM_DEFAULT_FISCAL_PROFILE,
  readFiscalProfile,
  readMinimumProductPayableMinor,
} from "@/lib/currency/fiscalProfile";

describe("readFiscalProfile", () => {
  it("yields the documented default for an absent, empty or whitespace value", () => {
    expect(readFiscalProfile({})).toEqual(PLATFORM_DEFAULT_FISCAL_PROFILE);
    expect(readFiscalProfile()).toEqual(readFiscalProfile({}));
    for (const blank of ["", "   "]) {
      expect(readFiscalProfile({
        COMMERCE_FISCAL_COUNTRY: blank,
        COMMERCE_FISCAL_CATEGORY: blank,
        COMMERCE_FISCAL_VAT_RATE_BPS: blank,
        COMMERCE_FISCAL_LEGAL_BASIS: blank,
      })).toEqual(PLATFORM_DEFAULT_FISCAL_PROFILE);
    }
  });

  it("reads the four keys independently of one another", () => {
    // A deployment that keeps the rate but cites a different statute should not
    // have to restate the facts that did not move, so each key is read alone.
    expect(readFiscalProfile({ COMMERCE_FISCAL_VAT_RATE_BPS: "2300" })).toEqual({
      ...PLATFORM_DEFAULT_FISCAL_PROFILE,
      vatRateBps: 2300,
    });
    expect(readFiscalProfile({ COMMERCE_FISCAL_LEGAL_BASIS: "Example VAT rule" })).toEqual({
      ...PLATFORM_DEFAULT_FISCAL_PROFILE,
      legalBasis: "Example VAT rule",
    });
    expect(readFiscalProfile({ COMMERCE_FISCAL_CATEGORY: "standard" }).category).toBe("standard");
    expect(readFiscalProfile({ COMMERCE_FISCAL_COUNTRY: "CZ" }).country).toBe("CZ");
  });

  it("accepts the whole basis-point range and refuses everything outside it", () => {
    expect(readFiscalProfile({ COMMERCE_FISCAL_VAT_RATE_BPS: "0" }).vatRateBps).toBe(0);
    expect(readFiscalProfile({ COMMERCE_FISCAL_VAT_RATE_BPS: "10000" }).vatRateBps).toBe(10_000);
    for (const malformed of ["10001", "-1", "8.5", "0x08", " eight ", "١٠"]) {
      expect(() => readFiscalProfile({ COMMERCE_FISCAL_VAT_RATE_BPS: malformed }))
        .toThrow(InvalidFiscalProfileError);
    }
  });

  it("refuses a malformed jurisdiction rather than issuing under this one", () => {
    // The refusal exists because the silent alternative is the worst outcome in
    // this module: a document issued to a tax authority under a treatment nobody
    // chose is not something a later correction fully undoes.
    for (const malformed of ["cz", "CZE", "C", "12", "C1"]) {
      expect(() => readFiscalProfile({ COMMERCE_FISCAL_COUNTRY: malformed }))
        .toThrow(InvalidFiscalProfileError);
    }
  });

  it("names the offending key and value in the refusal", () => {
    try {
      readFiscalProfile({ COMMERCE_FISCAL_COUNTRY: "cz" });
      expect.unreachable("a malformed jurisdiction must not resolve to a profile");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidFiscalProfileError);
      expect((error as InvalidFiscalProfileError).envKey).toBe("COMMERCE_FISCAL_COUNTRY");
      expect((error as InvalidFiscalProfileError).configuredValue).toBe("cz");
      expect((error as Error).message).toContain("COMMERCE_FISCAL_COUNTRY");
    }
  });
});

describe("readMinimumProductPayableMinor", () => {
  it("derives one major unit, which is one minor unit where there are no hundredths", () => {
    // The bug this replaces: the floor was the literal 100 in four places, and
    // 100 is one major unit only at an exponent of two. A yen-settling shop
    // would have refused every sale under ¥100 believing its minimum was ¥1.
    expect(readMinimumProductPayableMinor({}, "JPY")).toBe(1);
    expect(readMinimumProductPayableMinor({}, "EUR")).toBe(100);
    expect(readMinimumProductPayableMinor({}, "BHD")).toBe(1000);
  });

  it("lets configuration state a floor the derivation would not have chosen", () => {
    expect(readMinimumProductPayableMinor({ COMMERCE_MIN_PRODUCT_PAYABLE_MINOR: "1" }, "EUR"))
      .toBe(1);
    expect(readMinimumProductPayableMinor({ COMMERCE_MIN_PRODUCT_PAYABLE_MINOR: "250" }, "JPY"))
      .toBe(250);
    for (const blank of ["", "   "]) {
      expect(readMinimumProductPayableMinor({ COMMERCE_MIN_PRODUCT_PAYABLE_MINOR: blank }, "EUR"))
        .toBe(100);
    }
  });

  it("refuses a floor it cannot read rather than treating it as zero", () => {
    // A value read as zero is the dangerous direction: the floor is what stops a
    // promotion driving a line to a price nobody approved, so silence here would
    // be a discount ceiling quietly removed.
    for (const malformed of ["0", "-1", "1.5", "1e2", "0x64", "one hundred"]) {
      expect(() => readMinimumProductPayableMinor(
        { COMMERCE_MIN_PRODUCT_PAYABLE_MINOR: malformed }, "EUR",
      )).toThrow(InvalidMinimumProductPayableError);
    }
  });
});
