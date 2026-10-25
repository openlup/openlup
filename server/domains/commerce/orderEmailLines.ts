import { buildItems as buildNeutralItems, type RawLine } from "@openlup/platform/commerce";
import { DEFAULT_MONEY_LANG, formatCurrencyMinor } from "../../../src/lib/currency/formatMinor.js";
import type { Locale } from "../../../src/lib/i18n/resolveLocale.js";
export type { RawLine } from "@openlup/platform/commerce";
export function formatMoney(amountMinor: number, currency: string): string {
  return formatCurrencyMinor(amountMinor, { currency, locale: DEFAULT_MONEY_LANG });
}
export const genericItemLabel = (locale: Locale): string => ({ pl: "Produkt", en: "Product" })[locale];
export function buildItems(lines: RawLine[], locale: Locale) {
  return buildNeutralItems(lines, locale, { formatMoney, genericItemLabel });
}
