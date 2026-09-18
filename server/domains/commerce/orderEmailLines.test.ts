import { describe, expect, it } from "vitest";
import { DEFAULT_MONEY_LANG, formatCurrencyMinor } from "../../../src/lib/currency/formatMinor.js";
import { buildItems, formatMoney, type RawLine } from "./orderEmailLines.js";

// The currency code the mails carry today. Named once so the pins below read the
// concept, not the market.
const MAIL_CURRENCY = "PLN";

// U+00A0, spelled as an escape at every use. A literal one is indistinguishable
// from a space in a diff, and "two strings that differ only by an invisible
// character" is exactly how a wrong money re-baseline hides.
const NBSP = "\u00a0";

describe("formatMoney", () => {
  it("renders the settlement currency's symbol and pads minor units", () => {
    expect(formatMoney(10000, MAIL_CURRENCY)).toBe(`100,00${NBSP}z\u0142`);
    expect(formatMoney(2345, MAIL_CURRENCY)).toBe(`23,45${NBSP}z\u0142`);
    expect(formatMoney(2305, MAIL_CURRENCY)).toBe(`23,05${NBSP}z\u0142`);
    // The exact byte the dunning notices carry: the shipped cron injects THIS
    // rule, and its own suite pins that injection by identity, so the value
    // itself is pinned once, here, where the rule is written.
    expect(formatMoney(12999, MAIL_CURRENCY)).toBe(`129,99${NBSP}z\u0142`);
  });

  it("keeps two minor digits at both ends of the range", () => {
    expect(formatMoney(5, MAIL_CURRENCY)).toBe(`0,05${NBSP}z\u0142`);
    expect(formatMoney(0, MAIL_CURRENCY)).toBe(`0,00${NBSP}z\u0142`);
  });
});

// This block used to pin the mail formatter's *divergence* from the storefront as
// a characterization, with an instruction not to "fix" it as a drive-by. E2-F5 is
// the deliberate pass that block was waiting for, so it now pins the convergence:
// the same amounts and the same shapes, the opposite claim. The five cases below
// are the four differences that were removed plus the defect that went with them,
// each asserted against the shared formatter as well as against literal bytes so
// that neither side can drift back alone.
describe("formatMoney agrees with the storefront formatter", () => {
  const storefront = (amountMinor: number, currency = MAIL_CURRENCY) =>
    formatCurrencyMinor(amountMinor, { currency, locale: DEFAULT_MONEY_LANG });

  it("groups thousands the way the storefront always has", () => {
    expect(formatMoney(1234567, MAIL_CURRENCY)).toBe(`12${NBSP}345,67${NBSP}z\u0142`);
    expect(formatMoney(1234567, MAIL_CURRENCY)).toBe(storefront(1234567));
    expect(formatMoney(99999999, MAIL_CURRENCY)).toBe(`999${NBSP}999,99${NBSP}z\u0142`);
  });

  it("separates amount and symbol with the no-break space Intl emits", () => {
    expect(formatMoney(1490, MAIL_CURRENCY)).toBe(`14,90${NBSP}z\u0142`);
    expect(formatMoney(1490, MAIL_CURRENCY)).not.toContain("14,90 z\u0142");
  });

  it("renders a localized display for another currency instead of its bare code", () => {
    expect(formatMoney(1599, "EUR")).toBe(`15,99${NBSP}\u20ac`);
    expect(formatMoney(1599, "EUR")).toBe(storefront(1599, "EUR"));
    // Not every code has a symbol in every language, and where ICU has none the
    // code IS the display - so this row is convergence, not a leftover.
    expect(formatMoney(1599, "USD")).toBe(`15,99${NBSP}USD`);
  });

  it("divides by the currency's own minor unit rather than by a fixed hundred", () => {
    // The hand-rolled `/100` rendered 12999 minor units of a zero-exponent
    // currency as "129,99 JPY" - a hundredth of the real amount.
    expect(formatMoney(12999, "JPY")).toBe(`12${NBSP}999${NBSP}JPY`);
    expect(formatMoney(12999, "JPY")).toBe(storefront(12999, "JPY"));
  });

  it("renders a negative amount as a negative amount", () => {
    // The defect this convergence removed: `Math.floor(-2050 / 100)` is -21 and
    // `-2050 % 100` is -50, so the old formatter emitted "-21,-50 z\u0142".
    expect(formatMoney(-2050, MAIL_CURRENCY)).toBe(`-20,50${NBSP}z\u0142`);
    expect(formatMoney(-2050, MAIL_CURRENCY)).toBe(storefront(-2050));
  });
});

describe("buildItems", () => {
  const line = (over: Partial<RawLine>): RawLine => ({
    label: null,
    quantity: 1,
    lineSubtotalMinor: null,
    currency: null,
    ...over,
  });

  it("uses a frozen snapshot label and formats the line total", () => {
    const items = buildItems(
      [line({ label: "Karma sucha Jagnięcina", quantity: 2, lineSubtotalMinor: 10000, currency: "PLN" })],
      "pl",
    );
    expect(items).toEqual([
      { name: "Karma sucha Jagnięcina", quantity: 2, lineTotalLabel: `100,00${NBSP}z\u0142` },
    ]);
  });

  it("degrades to a localized generic label when the historical snapshot is sparse", () => {
    const lines = [
      line({ quantity: 1 }),
      line({ quantity: 3 }),
    ];
    const pl = buildItems(lines, "pl");
    expect(pl.map((i) => i.name)).toEqual(["Produkt", "Produkt"]);

    const en = buildItems(lines, "en");
    expect(en.map((i) => i.name)).toEqual(["Product", "Product"]);
  });

  it("leaves the line total blank when amount/currency are unknown", () => {
    const items = buildItems([line({ label: "Jagnięcina" })], "pl");
    expect(items[0].lineTotalLabel).toBe("");
  });
});
