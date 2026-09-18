import { describe, expect, it } from "vitest";

import type { CommerceTaxProfile } from "../../../src/domains/commerce/types.js";
import { CommerceQuoteError } from "../../../src/domains/commerce/ports.js";
import { assertSupportedCommerceTaxProfile } from "./commerceTaxProfileGuard.js";

const profile: CommerceTaxProfile = {
  included: true,
  country: "PL",
  category: "pet_food",
  vatRateBps: 800,
  legalBasis: "PL VAT Annex 3 item 10c",
};

describe("commerce tax profile guard", () => {
  it("accepts an exactly declared tax profile", () => {
    expect(() => assertSupportedCommerceTaxProfile(profile, [profile])).not.toThrow();
  });

  it.each([-1, 10_001, 800.5])(
    "rejects invalid VAT basis points with the canonical quote error: %s",
    (vatRateBps) => {
      expectQuoteError(
        () => assertSupportedCommerceTaxProfile({ ...profile, vatRateBps }, [profile]),
        { reason: "vatRateBps must be an integer between 0 and 10000", vatRateBps },
      );
    },
  );

  it("rejects a valid but undeclared profile with stable diagnostic details", () => {
    const undeclared = { ...profile, country: "DE" };
    expectQuoteError(
      () => assertSupportedCommerceTaxProfile(undeclared, [profile]),
      {
        country: "DE",
        category: "pet_food",
        vatRateBps: 800,
        reason: "taxProfile must be declared in supportedTaxProfiles",
      },
    );
  });
});

function expectQuoteError(operation: () => void, details: Record<string, unknown>): void {
  try {
    operation();
    throw new Error("expected CommerceQuoteError");
  } catch (error) {
    expect(error).toBeInstanceOf(CommerceQuoteError);
    expect(error).toMatchObject({
      code: "UNSUPPORTED_TAX_PROFILE",
      message: "Unsupported commerce tax profile",
      details,
    });
  }
}
