/**
 * How many minor units make one major unit, and the refusal when nobody knows.
 *
 * This is a self-contained question with one answer, one runtime source and one
 * failure mode, and it lives apart from {@link ../currency/platformCurrency.js}
 * for two reasons. The first is room: that module sits two lines under the
 * repository's 300-line source cap, and the settlement profile has two fields
 * still to arrive. The second is direction of dependency: the payable floor in
 * `fiscalProfile.ts` is *derived* from the exponent, so the exponent has to be
 * reachable from there without the fiscal module importing the currency module
 * that imports it back.
 *
 * `platformCurrency.ts` re-exports both names, so no existing importer moves.
 */

/**
 * The exponent lookup is pinned to one locale so the answer cannot depend on
 * who is asking. How many minor units a currency has is a property of the
 * currency, not of the reader's language, and a formatter that resolved a
 * different divisor for two readers of the same shop would be a bug that only
 * shows up for one of them.
 */
const EXPONENT_LOOKUP_LOCALE = "en-US";

/** Raised when the runtime cannot say how many minor units a currency has. */
export class UnresolvableCurrencyExponentError extends Error {
  readonly currency: string;

  constructor(currency: string, resolved: unknown) {
    super(
      `cannot resolve the minor-unit exponent for ${currency}: the runtime reported ` +
        `${String(resolved)}. Refusing to guess, because a wrong exponent misstates every ` +
        `amount in this currency by a power of ten.`,
    );
    this.name = "UnresolvableCurrencyExponentError";
    this.currency = currency;
  }
}

/**
 * How many minor units make one major unit, as a power of ten: 2 for most
 * currencies (100 cents to the euro or dollar), 0 for JPY and ISK, 3 for BHD.
 *
 * The value comes from the runtime's own currency data rather than a table in
 * this repository. ICU already ships ISO 4217's minor-unit list and keeps it
 * current; a copy here would be a second source of truth whose drift nothing
 * would detect. Unassigned-but-well-formed codes resolve to ISO's default of
 * 2, which is the same answer a hand-written table would have to give.
 *
 * Only codes that already passed `platformCurrencySchema`'s `/^[A-Z]{3}$/`
 * reach this function, so the `RangeError` `Intl` raises for a malformed code
 * is unreachable through the supported path. The explicit guard below exists
 * for the one outcome that would otherwise be silent: a non-integer reaching
 * `10 ** exponent` and rendering every amount as `NaN`.
 */
export function currencyExponent(code: string): number {
  const { minimumFractionDigits } = new Intl.NumberFormat(EXPONENT_LOOKUP_LOCALE, {
    style: "currency",
    currency: code,
  }).resolvedOptions();

  // `minimumFractionDigits` is optional in the DOM lib's ResolvedNumberFormatOptions
  // because it is only guaranteed for some option combinations. For a currency
  // style it is always present in practice — but "in practice" is what the guard
  // is here to stop relying on, since the value flows straight into an exponent.
  if (typeof minimumFractionDigits !== "number" || !Number.isInteger(minimumFractionDigits)
    || minimumFractionDigits < 0) {
    throw new UnresolvableCurrencyExponentError(code, minimumFractionDigits);
  }

  return minimumFractionDigits;
}
