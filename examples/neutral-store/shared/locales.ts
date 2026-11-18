import type { Locale as PlatformLocale } from '@openlup/platform/communications/contracts';
import { market } from '../owned/market.config.ts';

export type Locale = typeof market.locales[number];
/** Inactive platform translations may be retained; configured ones are required. */
export type LocaleCopy<T> = Record<Locale, T> & Partial<Record<PlatformLocale, T>>;
export type Localized = LocaleCopy<string>;
export interface LocaleMarket { locales: readonly Locale[]; defaultLocale: Locale }

// Step 1 stays inside the platform contract; widening it needs a separate SQL audit.
export const supportedLocales = ['en', 'pl'] as const satisfies readonly PlatformLocale[];
export const configuredLocales = market.locales;

export function assertLocaleMarket(market: LocaleMarket): void {
  if (!Array.isArray(market.locales) || !market.locales.length
    || new Set(market.locales).size !== market.locales.length) throw new Error('starter_locales_invalid');
  for (const locale of market.locales) {
    if (!supportedLocales.some(supported => supported === locale)) {
      throw new Error(`starter_locale_unsupported: ${String(locale)}`);
    }
  }
  if (!market.locales.includes(market.defaultLocale)) throw new Error('starter_default_locale_invalid');
}

export function isConfiguredLocale(value: unknown, market: Pick<LocaleMarket, 'locales'>): value is Locale {
  return market.locales.some(locale => locale === value);
}

export function resolveLocale(value: unknown, market: LocaleMarket): Locale {
  return isConfiguredLocale(value, market) ? value : market.defaultLocale;
}

export function assertLocalized(value: unknown, locales: readonly Locale[], path: string): void {
  for (const locale of locales) {
    const text = value && typeof value === 'object' ? (value as Record<string, unknown>)[locale] : undefined;
    if (typeof text !== 'string' || !text.trim()) throw new Error(`starter_locale_copy_missing: ${path} (${locale})`);
  }
}

/** Check every string leaf across translations, including nested email copy. */
export function assertLocaleCopy(copy: unknown, locales: readonly Locale[], path: string, requiredKeys: readonly string[] = []): void {
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const registry = record(copy);
  const keys = new Set(requiredKeys);
  function collect(value: unknown, prefix: string): void {
    for (const [key, item] of Object.entries(record(value))) {
      const next = prefix ? `${prefix}.${key}` : key;
      if (item && typeof item === 'object') collect(item, next);
      else keys.add(next);
    }
  }
  for (const translation of Object.values(registry)) collect(translation, '');
  for (const locale of locales) {
    if (!registry[locale] || !keys.size) throw new Error(`starter_locale_copy_missing: ${path} (${locale})`);
    for (const key of keys) {
      const text = key.split('.').reduce<unknown>((value, part) => record(value)[part], registry[locale]);
      if (typeof text !== 'string' || !text.trim()) throw new Error(`starter_locale_copy_missing: ${path}.${key} (${locale})`);
    }
  }
}
