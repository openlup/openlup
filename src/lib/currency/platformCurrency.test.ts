import { describe, expect, it } from "vitest";
import { COMMERCE_CURRENCIES } from "@/domains/commerce/types";
import { commerceCurrencySchema } from "@/domains/commerce/contractPrimitives";
import { CATALOG_CURRENCIES } from "@/domains/catalog/types";
import { catalogCurrencySchema } from "@/domains/catalog/contracts";
import {
  InvalidFiscalProfileError,
  InvalidMinimumProductPayableError,
  PLATFORM_DEFAULT_FISCAL_PROFILE,
} from "@/lib/currency/fiscalProfile";
import {
  createPlatformCurrencySchema,
  currencyExponent,
  InvalidSettlementCurrencyError,
  InvalidSettlementRegionError,
  isAcceptedPlatformCurrency,
  platformCurrencySchema,
  readSettlementProfile,
  PLATFORM_ACCEPTED_CURRENCIES,
  PLATFORM_DEFAULT_CURRENCY,
  PLATFORM_DEFAULT_REGION,
} from "@/lib/currency/platformCurrency";

// A currency this platform does not price in. Spelled once so the rejection
// cases below cannot drift apart from each other.
const FOREIGN_CODE = "EUR";

describe("platform currency policy", () => {
  it("accepts the platform's own currency", () => {
    expect(platformCurrencySchema.safeParse(PLATFORM_DEFAULT_CURRENCY).success).toBe(true);
    expect(isAcceptedPlatformCurrency(PLATFORM_DEFAULT_CURRENCY)).toBe(true);
  });

  it("rejects a well-formed but unaccepted currency", () => {
    const result = platformCurrencySchema.safeParse(FOREIGN_CODE);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("currency_not_settlement_currency");
    expect(isAcceptedPlatformCurrency(FOREIGN_CODE)).toBe(false);
  });

  it("accepts exactly the settlement profile's accepted set", () => {
    // Stated against the profile rather than against PLATFORM_ACCEPTED_CURRENCIES,
    // because the whole point of this wave is that those two are allowed to stop
    // agreeing: the constant keeps serving the four consumers that still read it,
    // while the schema follows configuration. This assertion has to keep holding
    // when they diverge, so it must not name either answer.
    const { acceptedCurrencies } = readSettlementProfile();
    for (const code of acceptedCurrencies) {
      expect(platformCurrencySchema.safeParse(code).success).toBe(true);
    }
    expect(acceptedCurrencies).not.toContain(FOREIGN_CODE);
    expect(platformCurrencySchema.safeParse(FOREIGN_CODE).success).toBe(false);
  });

  it("rejects malformed codes on shape, before acceptance", () => {
    for (const malformed of [FOREIGN_CODE.toLowerCase(), `${FOREIGN_CODE}O`, ""]) {
      expect(platformCurrencySchema.safeParse(malformed).success).toBe(false);
    }
  });

  it("accepts an injected currency set without touching the platform default", () => {
    // The later waves of this programme replace the accepted list with
    // configuration. The predicate already takes it as a parameter, so that is a
    // data change rather than a change to any call site.
    expect(isAcceptedPlatformCurrency(FOREIGN_CODE, [FOREIGN_CODE])).toBe(true);
    expect(isAcceptedPlatformCurrency(PLATFORM_DEFAULT_CURRENCY, [FOREIGN_CODE])).toBe(false);
    expect(PLATFORM_ACCEPTED_CURRENCIES).toEqual([PLATFORM_DEFAULT_CURRENCY]);
  });
});

describe("no domain keeps a private copy of the currency policy", () => {
  // Commerce and catalog each used to declare their own one-member list and
  // their own enum schema. Identity — not deep equality — is the assertion that
  // actually forbids the duplicate from growing back.
  it("shares one accepted-currency list across commerce and catalog", () => {
    expect(COMMERCE_CURRENCIES).toBe(PLATFORM_ACCEPTED_CURRENCIES);
    expect(CATALOG_CURRENCIES).toBe(PLATFORM_ACCEPTED_CURRENCIES);
  });

  it("shares one currency schema across commerce and catalog", () => {
    expect(commerceCurrencySchema).toBe(platformCurrencySchema);
    expect(catalogCurrencySchema).toBe(platformCurrencySchema);
  });
});

describe("currencyExponent", () => {
  // This table is the whole reason the repository does not carry its own copy of
  // ISO 4217's minor-unit list: it asserts that the runtime's answer *is* that
  // list. If a future runtime disagrees, this fails at test time rather than
  // misstating an amount by a power of ten at request time.
  it.each([
    // The platform's own currency is asserted through the constant rather than
    // spelled again: this row is what the unmodified formatter characterization
    // rests on, and it must keep saying 2 for as long as those assertions do.
    [PLATFORM_DEFAULT_CURRENCY, 2],
    ["EUR", 2],
    ["CZK", 2],
    ["USD", 2],
    ["JPY", 0],
    ["ISK", 0],
    ["BHD", 3],
  ])("reports %s with exponent %i", (code, expected) => {
    expect(currencyExponent(code)).toBe(expected);
  });

  it("agrees with the fraction digits the formatter actually renders", () => {
    // The invariant that ties the divisor to the output: if the exponent said
    // two and the formatter printed three decimals, minor units and displayed
    // precision would disagree and the difference would land in the last digit
    // of a price. Checked against Intl's rendering rather than against the same
    // Intl call the implementation makes.
    for (const code of ["EUR", "JPY", "BHD"]) {
      const rendered = new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(1);
      expect(currencyExponent(code)).toBe(rendered.match(/[.,](\d+)$/)?.[1].length ?? 0);
    }
  });

  it("gives an unassigned but well-formed code the ISO default", () => {
    // Not a fallback: two decimal places is what ISO 4217 specifies for codes it
    // does not assign a minor unit to, so this is the answer a hand-written
    // table would also have to give.
    expect(currencyExponent("XYZ")).toBe(2);
  });
});

describe("readSettlementProfile", () => {
  it("defaults to the platform currency when nothing is configured", () => {
    expect(readSettlementProfile({})).toEqual({
      defaultCurrency: PLATFORM_DEFAULT_CURRENCY,
      acceptedCurrencies: [PLATFORM_DEFAULT_CURRENCY],
      exponent: 2,
      regionCode: PLATFORM_DEFAULT_REGION,
      minimumProductPayableMinor: 100,
      fiscalProfile: PLATFORM_DEFAULT_FISCAL_PROFILE,
    });
    expect(readSettlementProfile()).toEqual(readSettlementProfile({}));
  });

  it("treats an empty or whitespace value as unconfigured", () => {
    for (const blank of ["", "   "]) {
      expect(readSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: blank }).defaultCurrency).toBe(
        PLATFORM_DEFAULT_CURRENCY,
      );
    }
  });

  it("carries a configured currency and its own exponent", () => {
    expect(readSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: FOREIGN_CODE })).toEqual({
      defaultCurrency: FOREIGN_CODE,
      acceptedCurrencies: [FOREIGN_CODE],
      exponent: 2,
      // The region does not move with the currency: configuring one says nothing
      // about the other, which is why they are two keys and not a derivation.
      regionCode: PLATFORM_DEFAULT_REGION,
      // Same exponent, so the same floor. The currency that changes this one is
      // the zero-exponent case below.
      minimumProductPayableMinor: 100,
      fiscalProfile: PLATFORM_DEFAULT_FISCAL_PROFILE,
    });
    // The exponent travels with the currency rather than being assumed, which is
    // the point of reading it here instead of at the formatter's call sites.
    expect(readSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: "JPY" }).exponent).toBe(0);
  });

  it("gives a currency without hundredths a floor of one minor unit, not a hundred", () => {
    // The defect this wave removes, stated as an assertion. The floor used to be
    // the literal 100 everywhere, which is one major unit only where a major
    // unit is a hundred minor ones. Reading it back at 100 here would mean a
    // yen-settling shop refusing to sell anything under ¥100 while believing it
    // had set a ¥1 minimum.
    expect(readSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: "JPY" })
      .minimumProductPayableMinor).toBe(1);
    // Not a special case for zero: the rule is one major unit, whatever that is.
    expect(readSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: "BHD" })
      .minimumProductPayableMinor).toBe(1000);
    expect(readSettlementProfile({}).minimumProductPayableMinor).toBe(100);
  });

  it("lets configuration state a floor, and refuses one it cannot read", () => {
    expect(readSettlementProfile({ COMMERCE_MIN_PRODUCT_PAYABLE_MINOR: "250" })
      .minimumProductPayableMinor).toBe(250);
    // A configured floor wins over the derivation in both directions, including
    // the one minor unit a zero-exponent currency would otherwise get.
    expect(readSettlementProfile({
      COMMERCE_SETTLEMENT_CURRENCY: "JPY",
      COMMERCE_MIN_PRODUCT_PAYABLE_MINOR: "500",
    }).minimumProductPayableMinor).toBe(500);
    for (const malformed of ["0", "-1", "1.5", "1e2", "lots"]) {
      expect(() => readSettlementProfile({ COMMERCE_MIN_PRODUCT_PAYABLE_MINOR: malformed }))
        .toThrow(InvalidMinimumProductPayableError);
    }
  });

  it("carries a configured fiscal profile and refuses a malformed one", () => {
    const profile = readSettlementProfile({
      COMMERCE_FISCAL_COUNTRY: "CZ",
      COMMERCE_FISCAL_CATEGORY: "standard",
      COMMERCE_FISCAL_VAT_RATE_BPS: "2100",
      COMMERCE_FISCAL_LEGAL_BASIS: "Example VAT rule",
    }).fiscalProfile;

    expect(profile).toEqual({
      included: true,
      country: "CZ",
      category: "standard",
      vatRateBps: 2100,
      legalBasis: "Example VAT rule",
    });
    // The fiscal country is a stated fact, not a lookup from the settlement
    // region: configuring one moves neither the other nor the currency.
    expect(readSettlementProfile({ COMMERCE_SETTLEMENT_REGION: "CZ" }).fiscalProfile)
      .toEqual(PLATFORM_DEFAULT_FISCAL_PROFILE);
    for (const malformed of ["cz", "CZE", "1"]) {
      expect(() => readSettlementProfile({ COMMERCE_FISCAL_COUNTRY: malformed }))
        .toThrow(InvalidFiscalProfileError);
    }
    for (const malformed of ["10001", "-1", "8.5", "eight"]) {
      expect(() => readSettlementProfile({ COMMERCE_FISCAL_VAT_RATE_BPS: malformed }))
        .toThrow(InvalidFiscalProfileError);
    }
  });

  it("refuses a malformed configured currency instead of falling back", () => {
    // The failure this forbids is Vendure GHSA-wm63-7627's shape: a currency
    // nobody validated becoming the price a customer is charged. Correcting a
    // typo to the default would hide the misconfiguration behind plausible
    // output.
    for (const malformed of [FOREIGN_CODE.toLowerCase(), `${FOREIGN_CODE}O`, "12"]) {
      expect(() => readSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: malformed })).toThrow(
        InvalidSettlementCurrencyError,
      );
    }
  });

  it("names the offending value in the refusal", () => {
    const failure = (() => {
      try {
        readSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: "eur" });
        return null;
      } catch (error) {
        return error as InvalidSettlementCurrencyError;
      }
    })();

    expect(failure?.name).toBe("InvalidSettlementCurrencyError");
    expect(failure?.configuredValue).toBe("eur");
    expect(failure?.message).toContain("COMMERCE_SETTLEMENT_CURRENCY");
  });

  it("carries a configured region, unconfigured or blank yielding the platform default", () => {
    expect(readSettlementProfile({ COMMERCE_SETTLEMENT_REGION: "CZ" }).regionCode).toBe("CZ");
    for (const blank of ["", "   "]) {
      expect(readSettlementProfile({ COMMERCE_SETTLEMENT_REGION: blank }).regionCode).toBe(
        PLATFORM_DEFAULT_REGION,
      );
    }
  });

  it("refuses a malformed configured region instead of falling back", () => {
    // Same rule as the currency, one layer down: the region selects which price
    // list the resolver reads, so a typo either prices from the wrong list or
    // from none. Correcting it to the default would hide which of the two
    // happened behind a plausible-looking price.
    for (const malformed of ["cz", "CZE", "C", "C1", "  cz  "]) {
      expect(() => readSettlementProfile({ COMMERCE_SETTLEMENT_REGION: malformed })).toThrow(
        InvalidSettlementRegionError,
      );
    }

    const failure = (() => {
      try {
        readSettlementProfile({ COMMERCE_SETTLEMENT_REGION: "cz" });
        return null;
      } catch (error) {
        return error as InvalidSettlementRegionError;
      }
    })();

    expect(failure?.name).toBe("InvalidSettlementRegionError");
    expect(failure?.configuredValue).toBe("cz");
    expect(failure?.message).toContain("COMMERCE_SETTLEMENT_REGION");
  });

  it("builds a schema that accepts exactly what the given profile settles in", () => {
    // The falsifier for "the predicate follows configuration": a schema built
    // from a profile in another currency must accept that currency and refuse
    // the platform default, which is the inverse of the ambient schema's answer.
    const schema = createPlatformCurrencySchema(
      readSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: FOREIGN_CODE }),
    );

    expect(schema.safeParse(FOREIGN_CODE).success).toBe(true);
    expect(schema.safeParse(PLATFORM_DEFAULT_CURRENCY).success).toBe(false);
    expect(platformCurrencySchema.safeParse(FOREIGN_CODE).success).toBe(false);
    // Format is still checked before membership, so a malformed code is refused
    // as malformed rather than as unaccepted.
    expect(schema.safeParse("eur").success).toBe(false);
  });

  it("reads the two keys independently of each other", () => {
    const profile = readSettlementProfile({
      COMMERCE_SETTLEMENT_CURRENCY: FOREIGN_CODE,
      COMMERCE_SETTLEMENT_REGION: "CZ",
    });

    expect(profile.defaultCurrency).toBe(FOREIGN_CODE);
    expect(profile.regionCode).toBe("CZ");
  });
});
