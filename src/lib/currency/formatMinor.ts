/**
 * Single place for turning a minor-unit amount (grosze) into a localized currency
 * string. Several admin/account/configurator surfaces had each hand-rolled the
 * same `new Intl.NumberFormat(...).format(x / 100)` (and a few `toFixed(2)`
 * variants that drifted on decimal separator/grouping). New money display should
 * call this instead of re-deriving the formatting.
 *
 * Callers pass their own locale + currency so output stays byte-identical to
 * their previous inline formatter; this only removes the duplicated mechanic.
 *
 * The divisor is derived from the currency rather than fixed at 100. "One
 * hundred minor units to the major unit" is true of the euro and the dollar and
 * false of JPY (1) and BHD (1000), and getting it wrong does not throw — it
 * renders a price that is wrong by a power of ten. Since the exponent comes from the
 * `currency` the caller already passes, no call site had to change, and every
 * currency this platform can currently reach has exponent 2, so no rendered
 * string moved.
 */
import { currencyExponent } from "./platformCurrency.js";

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
 * The language money is written in when the surface has no reader to ask.
 *
 * Order mails and the un-internationalised admin cards both format amounts with
 * nobody's language available - a mail is composed by a worker, and an admin card
 * is untranslated prose with no `t()` in it. Both used to answer that question
 * with their own inline literal, which is how the mail and the storefront came to
 * disagree in the first place. One answer, named once, is what makes "the
 * confirmation matches the cart" a property of the code rather than a
 * coincidence.
 *
 * It is a bare *language* subtag, not a language-plus-region tag: `Intl` resolves
 * both to the same currency formatting, and naming a region as well would state a
 * second fact that nothing reads and that the ratchet would count twice.
 */
export const DEFAULT_MONEY_LANG = "pl";

/** The display languages the money formatter is driven with. */
export type MoneyLang = typeof DEFAULT_MONEY_LANG | "en";

/**
 * The display language, resolved from an i18n language tag.
 *
 * One helper instead of the `i18n.language === "en" ? "en" : …` ternary repeated
 * at every money call site: each copy of that ternary is a locale literal the OSS
 * neutrality ratchet counts, and the storefront family has no slack to spend on
 * restating the market at every price.
 */
export function moneyLang(language: string | undefined): MoneyLang {
  return language === "en" ? "en" : DEFAULT_MONEY_LANG;
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
