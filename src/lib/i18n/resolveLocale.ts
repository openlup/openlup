/**
 * Rozstrzyganie języka. Miało bliźniaka w wyciętym drzewie Edge; od
 * 2026-09-04 to jedyna kopia, więc obowiązek ręcznej synchronizacji zniknął.
 *
 * Używana przez FeedbackRedirect (decider component dla legacy
 * /feedback/:hash) żeby zdecydować czy redirect na /moja-opinia/:hash
 * (PL) czy /my-opinion/:hash (EN). Logika MUSI być spójna z nadawcą maila,
 * inaczej tester dostanie EN maila z linkiem który redirectuje na PL stronę.
 *
 * Jak coś tu zmieniasz — zmień też _shared/locale.ts (i odwrotnie).
 */
const EN_VARIANTS = new Set([
  // ISO alpha-2
  "GB", "US", "IE", "AU", "CA", "NZ",
  // English names
  "UNITED KINGDOM", "UNITED STATES", "IRELAND", "AUSTRALIA", "CANADA", "NEW ZEALAND",
  // Polish names (gdy PL UI tłumaczy country labels)
  "WIELKA BRYTANIA", "STANY ZJEDNOCZONE", "IRLANDIA", "KANADA", "NOWA ZELANDIA",
]);

export type Locale = "pl" | "en";

export function resolveLocale(country: string | null | undefined): Locale {
  if (!country) return "pl";
  return EN_VARIANTS.has(country.trim().toUpperCase()) ? "en" : "pl";
}
