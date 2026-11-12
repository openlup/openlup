export const quoteCopy = {
  en: { loading: 'Refreshing the purchase price…', unavailable: 'A current purchase price is unavailable.',
    second: 'Second delivery', refresh: 'Review the refreshed terms and accept them before placing the order.' },
  pl: { loading: 'Odświeżanie ceny zakupu…', unavailable: 'Aktualna cena zakupu jest niedostępna.',
    second: 'Druga dostawa', refresh: 'Sprawdź odświeżone warunki i zaakceptuj je przed złożeniem zamówienia.' },
};

/** Browser-safe, case-sensitive display hints only; no payment or delivery authority. */
export const embeddedCheckoutBrowserMarkers = Object.freeze(['FBAN/', 'FB_IAB/', 'Instagram']);
