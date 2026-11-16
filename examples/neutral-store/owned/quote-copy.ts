export const quoteCopy = {
  en: { loading: 'Refreshing the purchase price…', unavailable: 'A current purchase price is unavailable.',
    second: 'Second delivery', refresh: 'Review the refreshed terms and accept them before placing the order.' },
  pl: { loading: 'Odświeżanie ceny zakupu…', unavailable: 'Aktualna cena zakupu jest niedostępna.',
    second: 'Druga dostawa', refresh: 'Sprawdź odświeżone warunki i zaakceptuj je przed złożeniem zamówienia.' },
};

/** Exact display allowlist. Never interpolate server messages or error details. */
export const quoteRefusalCopy = {
  en: {
    host_binding_required: 'Subscription prices need the installed demonstration host. Run ./lifecycle up, then refresh.',
    purchase_mode_unavailable: 'This product is unavailable for the selected purchase mode. Choose another mode or product.',
    cadence_unavailable: 'This delivery interval is unavailable. Choose an interval offered by this store.',
    base_price_not_found: 'The base price is missing. Configure an effective one-time gross base price for this product and market, then refresh.',
    base_price_ambiguous: 'Base prices overlap. Keep one effective exact base entry for this product and market, then refresh.',
    base_price_amount_kind_invalid: 'The base price must be gross. Correct the stored base entry, then refresh.',
    active_price_list_not_found: 'No current price list is available. Configure an effective list for this market, currency and channel, then refresh.',
    active_price_list_ambiguous: 'Current price lists overlap. Keep one effective list for this market, currency and channel, then refresh.',
    legacy_subscription_price_not_found: 'The subscription price is missing. Configure the subscription price policy or the pre-policy legacy entry, then refresh.',
    legacy_subscription_price_ambiguous: 'Legacy subscription prices overlap. Correct the stored entries, then refresh.',
    subscription_price_policy_not_effective: 'No subscription price policy is currently effective. Correct its effective dates, then refresh.',
    subscription_price_policy_ambiguous: 'Subscription price policies overlap. Keep one effective revision, then refresh.',
    subscription_price_policy_invalid: 'The subscription price policy is invalid. Correct the stored policy revision, then refresh.',
    subscription_price_policy_digest_mismatch: 'The subscription price policy failed its integrity check. Repair the stored revision and digest, then refresh.',
    starter_quote_refresh_required: 'The purchase terms need refreshing. Refresh the price and review the terms before ordering.',
  },
  pl: {
    host_binding_required: 'Ceny subskrypcji wymagają zainstalowanego hosta demonstracyjnego. Uruchom ./lifecycle up i odśwież stronę.',
    purchase_mode_unavailable: 'Ten produkt jest niedostępny w wybranym trybie zakupu. Wybierz inny tryb lub produkt.',
    cadence_unavailable: 'Ten odstęp między dostawami jest niedostępny. Wybierz odstęp oferowany przez sklep.',
    base_price_not_found: 'Brakuje ceny bazowej. Skonfiguruj obowiązującą jednorazową cenę bazową brutto dla tego produktu i rynku, a następnie odśwież stronę.',
    base_price_ambiguous: 'Ceny bazowe nakładają się. Pozostaw jeden obowiązujący wpis bazowy dla tego produktu i rynku, a następnie odśwież stronę.',
    base_price_amount_kind_invalid: 'Cena bazowa musi być ceną brutto. Popraw zapisany wpis i odśwież stronę.',
    active_price_list_not_found: 'Brakuje aktualnego cennika. Skonfiguruj obowiązujący cennik dla tego rynku, waluty i kanału, a następnie odśwież stronę.',
    active_price_list_ambiguous: 'Aktualne cenniki nakładają się. Pozostaw jeden obowiązujący cennik dla tego rynku, waluty i kanału, a następnie odśwież stronę.',
    legacy_subscription_price_not_found: 'Brakuje ceny subskrypcji. Skonfiguruj politykę cen subskrypcji lub starszy wpis sprzed polityki, a następnie odśwież stronę.',
    legacy_subscription_price_ambiguous: 'Starsze ceny subskrypcji nakładają się. Popraw zapisane wpisy i odśwież stronę.',
    subscription_price_policy_not_effective: 'Żadna polityka cen subskrypcji obecnie nie obowiązuje. Popraw daty jej obowiązywania i odśwież stronę.',
    subscription_price_policy_ambiguous: 'Polityki cen subskrypcji nakładają się. Pozostaw jedną obowiązującą wersję i odśwież stronę.',
    subscription_price_policy_invalid: 'Polityka cen subskrypcji jest nieprawidłowa. Popraw zapisaną wersję i odśwież stronę.',
    subscription_price_policy_digest_mismatch: 'Kontrola integralności polityki cen subskrypcji nie powiodła się. Napraw zapisaną wersję i skrót, a następnie odśwież stronę.',
    starter_quote_refresh_required: 'Warunki zakupu wymagają odświeżenia. Odśwież cenę i sprawdź warunki przed zamówieniem.',
  },
};

export function isQuoteRefusalCode(code: unknown): code is keyof typeof quoteRefusalCopy.en {
  return typeof code === 'string' && Object.hasOwn(quoteRefusalCopy.en, code);
}

/** Browser-safe, case-sensitive display hints only; no payment or delivery authority. */
export const embeddedCheckoutBrowserMarkers = Object.freeze(['FBAN/', 'FB_IAB/', 'Instagram']);
