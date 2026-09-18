/**
 * Display-only money helpers. Transactional amounts always come from the live
 * commerce quote; this module deliberately contains no price constants or
 * bundle calculator.
 */

import {
  DEFAULT_MONEY_LANG,
  formatCurrencyMinor,
  moneyLang,
  type MoneyLang,
} from "@/lib/currency/formatMinor";
import { ambientSettlementProfile } from "@/lib/currency/platformCurrency";

/**
 * Re-exported rather than moved-and-forgotten: the display language is a money
 * concept, so it now lives beside the formatter in `src/lib/currency`, where the
 * order mails can reach it too. Storefront components keep importing it from
 * here because that is where they already look for money helpers.
 */
export { moneyLang, type MoneyLang };

/** Per-can price (minor units), rounded to nearest grosz. */
export function pricePerCanMinor(totalMinor: number, totalCans: number): number {
  if (totalCans <= 0) return 0;
  return Math.round(totalMinor / totalCans);
}

/**
 * One rendered amount for the whole storefront.
 *
 * Until E2-F5 this function had two asymmetric branches: the English one already
 * delegated to {@link formatCurrencyMinor}, and the default-language one
 * concatenated a hand-formatted number with a hard-coded symbol. The asymmetry was
 * a *byte* difference, not a design: the hand-rolled branch separated the amount
 * from the symbol with an ASCII space where `Intl` emits U+00A0. Nothing else
 * differed — the two agreed on the decimal separator, on grouping and on the
 * grouping threshold across all 400 102 amounts they were compared over, which is
 * one claim fewer than the comment this replaces used to make.
 *
 * With the divergence gone the language is just an argument, and the currency
 * comes from the deployment's settlement profile rather than from a literal, so
 * the storefront prices in whatever the platform settles in without any of these
 * call sites knowing what that is.
 */
export function formatMoney(amountMinor: number, lang: MoneyLang = DEFAULT_MONEY_LANG): string {
  return formatCurrencyMinor(amountMinor, {
    currency: ambientSettlementProfile.defaultCurrency,
    locale: lang,
  });
}
