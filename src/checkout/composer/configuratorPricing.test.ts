import { describe, expect, it } from "vitest";

import { DEFAULT_MONEY_LANG, formatCurrencyMinor } from "@/lib/currency/formatMinor";
import { ambientSettlementProfile } from "@/lib/currency/platformCurrency";

import { formatMoney, pricePerCanMinor } from "./configuratorPricing";

describe("pricePerCanMinor", () => {
  it("divides the order total by the can count, rounded", () => {
    expect(pricePerCanMinor(28140, 21)).toBe(Math.round(28140 / 21));
  });

  it("returns 0 for zero cans (guard)", () => {
    expect(pricePerCanMinor(28140, 0)).toBe(0);
  });
});

// U+00A0. Spelled as an escape at every use below, because a literal one in a
// test file is indistinguishable from a space to the person reviewing the diff -
// which is exactly the failure mode a money re-baseline hides behind.
const NBSP = "\u00a0";

describe("formatMoney", () => {
  it("writes the settlement currency the reader's way in each language", () => {
    expect(formatMoney(1490, DEFAULT_MONEY_LANG)).toBe(`14,90${NBSP}zł`);
    expect(formatMoney(1490, "en")).toBe(`PLN${NBSP}14.90`);
  });

  // E1-F5 left the default-language branch hand-rolled and pinned the divergence
  // rather than fixing it, so that the storefront and the order mails could be
  // re-baselined together in one reviewable pass. This is that pass, and this is
  // its proof: both languages are now the shared formatter, checked twice per
  // amount - once against the formatter, so a drift on either side fails here
  // instead of on screen, and once against the literal bytes, so a change to BOTH
  // sides at once still fails. The amounts span the shapes that break naive
  // formatters: zero, a single minor unit, a whole unit, values on either side of
  // the four-to-five digit grouping threshold, and a negative.
  it.each([
    [0, `0,00${NBSP}zł`, `PLN${NBSP}0.00`],
    [1, `0,01${NBSP}zł`, `PLN${NBSP}0.01`],
    [100, `1,00${NBSP}zł`, `PLN${NBSP}1.00`],
    [123456, `1234,56${NBSP}zł`, `PLN${NBSP}1,234.56`],
    [1234567, `12${NBSP}345,67${NBSP}zł`, `PLN${NBSP}12,345.67`],
    [99999999, `999${NBSP}999,99${NBSP}zł`, `PLN${NBSP}999,999.99`],
    [-12345, `-123,45${NBSP}zł`, `-PLN${NBSP}123.45`],
  ])("renders %i byte for byte as the shared formatter does", (amountMinor, pl, en) => {
    const currency = ambientSettlementProfile.defaultCurrency;
    expect(formatMoney(amountMinor, DEFAULT_MONEY_LANG)).toBe(formatCurrencyMinor(amountMinor, { currency, locale: DEFAULT_MONEY_LANG }));
    expect(formatMoney(amountMinor, "en")).toBe(formatCurrencyMinor(amountMinor, { currency, locale: "en" }));
    expect(formatMoney(amountMinor, DEFAULT_MONEY_LANG)).toBe(pl);
    expect(formatMoney(amountMinor, "en")).toBe(en);
  });

  it("takes its currency from the settlement profile, not from a literal", () => {
    // The falsifier for "the storefront prices in whatever the platform settles
    // in": the rendered symbol has to be the one the profile's currency resolves
    // to. A re-introduced hard-coded currency passes the byte assertions above
    // and fails this one the moment the profile moves.
    expect(formatMoney(1490, DEFAULT_MONEY_LANG)).toBe(
      formatCurrencyMinor(1490, { currency: ambientSettlementProfile.defaultCurrency, locale: DEFAULT_MONEY_LANG }),
    );
  });
});
