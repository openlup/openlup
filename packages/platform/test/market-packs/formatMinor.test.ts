import { describe, expect, it } from "vitest";
import { formatCurrencyMinor, currencySymbol } from "../../src/market-packs/index.js";
const NBSP = " ";
describe("formatCurrencyMinor", () => {
  it("formats caller currency with caller locale decimals and suffix", () => {
    expect(formatCurrencyMinor(1490, { currency: "EUR", locale: "de-DE" })).toBe(`14,90${NBSP}€`);
  });
  it("groups thousands for large amounts", () => {
    expect(formatCurrencyMinor(1234567, { currency: "EUR", locale: "de-DE" })).toBe(`12.345,67${NBSP}€`);
  });
  it("renders a currency code for English locales", () => {
    expect(formatCurrencyMinor(14900, { currency: "BHD", locale: "en-US" })).toBe(`BHD${NBSP}14.900`);
    expect(formatCurrencyMinor(14900, { currency: "BHD", locale: "en-GB" })).toBe(`BHD${NBSP}14.900`);
  });
  it("handles zero and negative amounts", () => {
    expect(formatCurrencyMinor(0, { currency: "EUR", locale: "de-DE" })).toBe(`0,00${NBSP}€`);
    expect(formatCurrencyMinor(-500, { currency: "EUR", locale: "de-DE" })).toBe(`-5,00${NBSP}€`);
  });
  it("treats a JPY minor unit as one yen, not one hundredth of one", () => {
    expect(formatCurrencyMinor(1000, { currency: "JPY", locale: "en-US" })).toBe("¥1,000");
  });
  it("treats a BHD minor unit as one fils (one thousandth)", () => {
    expect(formatCurrencyMinor(1500, { currency: "BHD", locale: "en-US" })).toBe(`BHD${NBSP}1.500`);
  });
  it("keeps hundredth-based currencies on the old divisor", () => {
    expect(formatCurrencyMinor(1490, { currency: "EUR", locale: "en-US" })).toBe("€14.90");
    expect(formatCurrencyMinor(1490, { currency: "USD", locale: "en-US" })).toBe("$14.90");
  });
  it("resolves the symbol for the explicit reader and currency", () => {
    expect(currencySymbol("USD", "en-US")).toBe("$");
    expect(currencySymbol("EUR", "de-DE")).toBe("€");
  });
});
