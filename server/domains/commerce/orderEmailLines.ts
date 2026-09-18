// Shared money + line-item formatting for order emails. Both the order-draft
// handler (items from the event snapshot) and the order-paid read port (items
// from commerce_order_items) produce RawLine[] then format them identically, so
// the formatting lives here once. Pure TS.

import {
  DEFAULT_MONEY_LANG,
  formatCurrencyMinor,
} from "../../../src/lib/currency/formatMinor.js";
import type { Locale } from "../../../src/lib/i18n/resolveLocale.js";
import type { OrderEmailLineItem } from "./outboxOrderDraftEmailPorts.js";

export interface RawLine {
  /** Frozen customer-facing label; draft snapshots deliberately carry none. */
  label: string | null;
  quantity: number;
  /** Gross line total in minor units, or null when unknown. */
  lineSubtotalMinor: number | null;
  currency: string | null;
}

// Shown when a historical snapshot has no customer-facing label. A raw slug or
// SKU must never surface in a customer-facing order email.
const GENERIC_ITEM_LABEL: Record<Locale, string> = {
  pl: "Produkt",
  en: "Product",
};

// How an amount is written to a customer, answered in exactly one place for the
// mails and the storefront alike.
//
// This used to be four lines of hand-rolled arithmetic that disagreed with what
// the same customer had just seen in the cart. E2-F5 converged it; the four
// differences it removed are worth naming, because three of them were byte
// re-baselines and one was a defect:
//
//   * an ASCII space (U+0020) before the symbol where `Intl` emits U+00A0;
//   * no thousands grouping, where the storefront has always grouped with U+00A0
//     from five integer digits up;
//   * every non-settlement currency degraded to a bare ISO code, where `Intl`
//     renders the reader's own display for it;
//   * `Math.floor(amountMinor / 100)` against `amountMinor % 100` rendered a
//     negative amount as garbage — -2050 came out as "-21,-50". No caller passes
//     a negative magnitude today, which was the only thing standing between that
//     and a customer's inbox.
//
// The fixed `/100` went with them: `formatCurrencyMinor` derives the divisor from
// the currency, so a zero-exponent currency is no longer misstated by two orders
// of magnitude.
//
// The mail deliberately renders at `DEFAULT_MONEY_LANG` rather than at the
// recipient's locale — it always has, and making it recipient-aware would move a
// second, independent set of customer-visible bytes that E2-F5's enumeration does
// not cover. Named debt, not an oversight.
export function formatMoney(amountMinor: number, currency: string): string {
  return formatCurrencyMinor(amountMinor, { currency, locale: DEFAULT_MONEY_LANG });
}

export function buildItems(
  lines: RawLine[],
  locale: Locale,
): OrderEmailLineItem[] {
  return lines.map((line) => {
    const name = line.label ?? GENERIC_ITEM_LABEL[locale];
    const lineTotalLabel =
      line.lineSubtotalMinor !== null && line.currency !== null
        ? formatMoney(line.lineSubtotalMinor, line.currency)
        : "";
    return { name, quantity: line.quantity, lineTotalLabel };
  });
}
