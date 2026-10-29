/** Render an amount in its own currency with an explicit display locale. */
import { currencyExponent } from "./currencyExponent.js";

export function formatCurrencyMinor(
  amountMinor: number,
  options: { currency: string; locale: string },
): string {
  return new Intl.NumberFormat(options.locale, {
    style: "currency",
    currency: options.currency,
  }).format(amountMinor / 10 ** currencyExponent(options.currency));
}

/**
 * How this currency is written *as a symbol* for this reader - which is not the
 * same string for every reader: the same code renders as a local symbol in one
 * language and as its bare code in another.
 *
 * It exists so a translated label can carry a currency without containing one.
 * A label that spells the symbol has the market welded into every translation of
 * it; `"Kwota ({{currency}})"` filled from here renders the identical bytes in
 * each language while leaving a translator nothing to get wrong. Asking `Intl`
 * for the currency part of a formatted zero is the only way to get the reader's
 * own display without a symbol table - and a symbol table in this repository
 * would be a second source of truth against ICU's, drifting silently.
 */
export function currencySymbol(currency: string, locale: string): string {
  const parts = new Intl.NumberFormat(locale, { style: "currency", currency }).formatToParts(0);
  return parts.find((part) => part.type === "currency")?.value ?? currency;
}
