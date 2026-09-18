import { describe, expect, it } from "vitest";

import { formatCurrencyMinor } from "@/lib/currency/formatMinor";

// Non-breaking space is what Intl currency formatting emits between the grouped
// amount and the currency symbol/code for pl-PL.
const NBSP = " ";

describe("formatCurrencyMinor", () => {
  it("formats PLN in Polish with comma decimals and a zł suffix", () => {
    expect(formatCurrencyMinor(1490, { currency: "PLN", locale: "pl-PL" })).toBe(`14,90${NBSP}zł`);
  });

  it("groups thousands (NBSP) for large PLN amounts", () => {
    expect(formatCurrencyMinor(1234567, { currency: "PLN", locale: "pl-PL" })).toBe(
      `12${NBSP}345,67${NBSP}zł`,
    );
  });

  it("renders the PLN code for English locales", () => {
    expect(formatCurrencyMinor(1490, { currency: "PLN", locale: "en-US" })).toBe("PLN 14.90");
    expect(formatCurrencyMinor(1490, { currency: "PLN", locale: "en-GB" })).toBe("PLN 14.90");
  });

  it("handles zero and negative amounts", () => {
    expect(formatCurrencyMinor(0, { currency: "PLN", locale: "pl-PL" })).toBe(`0,00${NBSP}zł`);
    expect(formatCurrencyMinor(-500, { currency: "PLN", locale: "pl-PL" })).toBe(`-5,00${NBSP}zł`);
  });
});

describe("formatCurrencyMinor divides by the currency's own minor unit", () => {
  // The four assertions above are the characterization proof that this stayed a
  // no-op for the platform's own currency: they were written against the
  // hard-coded /100 divisor and are unmodified. The cases here are the ones
  // that divisor got wrong.

  it("treats a JPY minor unit as one yen, not one hundredth of one", () => {
    // The bug this replaces: 1000 / 100 renders ten yen for a thousand-yen amount.
    expect(formatCurrencyMinor(1000, { currency: "JPY", locale: "ja-JP" })).toBe("￥1,000");
  });

  it("treats a BHD minor unit as one fils (one thousandth)", () => {
    expect(formatCurrencyMinor(1500, { currency: "BHD", locale: "en-US" })).toBe(
      `BHD${NBSP}1.500`,
    );
  });

  it("keeps hundredth-based currencies on the old divisor", () => {
    // EUR and CZK are the currencies the next waves of this programme reach
    // first; both must be unaffected by the exponent lookup.
    expect(formatCurrencyMinor(1490, { currency: "EUR", locale: "en-US" })).toBe("€14.90");
    expect(formatCurrencyMinor(1490, { currency: "USD", locale: "en-US" })).toBe("$14.90");
  });
});
