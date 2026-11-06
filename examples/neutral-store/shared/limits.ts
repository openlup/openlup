import type { Localized } from './config.ts';
import type { CopyKey } from '../owned/copy.ts';

export interface NativeLimit {
  id: string;
  actions: readonly CopyKey[];
  code: string;
  explanation: Localized;
}

/** Application refusals name unavailable composition without claiming new package capabilities. */
export const nativeLimits: readonly NativeLimit[] = [
  {
    id: 'N1', actions: ['promotion', 'promotionAdmin'], code: 'starter_promotion_write_unavailable',
    explanation: {
      en: 'Live products, SKUs, price lists, price entries and promotions are seed data: one owned demo-seed step with the install connection, no runtime writer for them and no checkout promotion codes. Bundle drafts, compositions, target prices and activation, and catalogue drafts, are administered by a native human operator through their native writers.',
      pl: 'Produkty, SKU, cenniki, pozycje cenowe i promocje katalogu bieżącego są danymi początkowymi: jeden własny krok demo-seed połączeniem instalacyjnym, bez zapisu tych danych w czasie działania i bez kodów promocyjnych przy zakupie. Wersjami roboczymi pakietów, ich składem, cenami docelowymi i aktywacją oraz wersjami roboczymi katalogu zarządza natywny operator będący człowiekiem przez natywne mechanizmy zapisu.',
    },
  },
  {
    id: 'N2', actions: ['correctEmail', 'correctPhone', 'linkAccount'], code: 'operator_subscription_authority_unavailable',
    explanation: {
      en: 'The native operator authority does not provide these identity corrections.',
      pl: 'Natywne uprawnienia operatora nie obsługują tych poprawek tożsamości.',
    },
  },
  {
    id: 'N3', actions: ['addNote', 'correctOrderAddress'], code: 'starter_order_correction_unavailable',
    explanation: {
      en: 'Native order notes and order address correction are unavailable. A subscription destination is a separate action.',
      pl: 'Natywne notatki i poprawianie adresu zamówienia są niedostępne. Adres subskrypcji to osobne działanie.',
    },
  },
  {
    id: 'N4', actions: ['requestReplacement', 'cancelFulfillment'], code: 'host_binding_required',
    explanation: {
      en: 'Replacement requests and complete fulfillment cancellation are unavailable. Undelivered replacement confirmation is never exposed.',
      pl: 'Przesyłki zastępcze i pełne anulowanie realizacji są niedostępne. Nie udostępniamy potwierdzania niedoręczonej przesyłki zastępczej.',
    },
  },
  {
    id: 'N5', actions: ['savedAddresses', 'billing', 'deliveryPreference', 'paymentPreference', 'privateProfile', 'profileViews'], code: 'starter_account_preferences_unavailable',
    explanation: {
      en: 'Saved addresses, billing profiles, delivery preferences, payment preferences, private-profile views and profile/address/billing/private-profile views are unavailable on the portable rail.',
      pl: 'Ścieżka przenośna nie obsługuje zapisanych adresów, profili rozliczeniowych, preferencji dostawy i płatności, widoków profilu prywatnego ani widoków profilu, adresów, rozliczeń i profilu prywatnego.',
    },
  },
  {
    id: 'N6', actions: ['realPayment', 'setupPaymentMethod', 'replaceCard'], code: 'native_prepared_attempt_store_unsupported',
    explanation: {
      en: 'Sandbox payments only. Real PSP attempts, method setup, card replacement, cumulative refunds and absence reopen are unsupported on this rail.',
      pl: 'Wyłącznie płatności testowe. Ta ścieżka nie obsługuje rzeczywistych prób PSP, konfiguracji metod, zmiany karty, zwrotów skumulowanych ani wznowienia po braku próby.',
    },
  },
  {
    id: 'N7', actions: ['editProfile'], code: 'starter_profile_edit_unavailable',
    explanation: {
      en: 'Customer profile editing is unavailable on the portable rail.',
      pl: 'Edycja profilu klienta jest niedostępna na ścieżce przenośnej.',
    },
  },
  {
    id: 'N8', actions: ['subscriptionResize'], code: 'starter_subscription_resize_unconfigured',
    explanation: {
      en: 'Seven exact edit verbs are available through the customer-session API only. Demand-driven plan-length and portion resizing remain unconfigured and refuse. Classic plan choices and sized cadence choices preserve explicit counts.',
      pl: 'Siedem dokładnych poleceń edycji jest dostępnych wyłącznie przez API sesji klienta. Zmiana wielkości według zapotrzebowania przy zmianie okresu lub proporcji pozostaje nieskonfigurowana i jest odrzucana. Klasyczne wybory okresu i częstotliwość w edytorze rozmiarów zachowują jawne ilości.',
    },
  },
  {
    id: 'N11', actions: ['sizedAcquisition'], code: 'starter_sized_acquisition_unavailable',
    explanation: {
      en: 'A new purchase starts classic. Size-aware servicing begins only after a reviewed, explicitly accepted classic opt-in.',
      pl: 'Nowy zakup rozpoczyna się w ofercie klasycznej. Obsługa z rozmiarami zaczyna się dopiero po przeglądzie i wyraźnej zgodzie na zmianę.',
    },
  },
  {
    id: 'N12', actions: ['publicationFence'], code: 'starter_sized_publication_fence_unavailable',
    explanation: {
      en: 'New or increased sized lines check current active and subscription-sellable state in the apply transaction. Publication-head and offer-membership fencing is not supplied.',
      pl: 'Nowe lub zwiększone pozycje sprawdzają bieżącą aktywność i możliwość sprzedaży w subskrypcji w transakcji zapisu. Kontrola wersji publikacji i przynależności do oferty nie jest dostarczana.',
    },
  },
  {
    id: 'N9', actions: ['richOms', 'paymentLink', 'resumeAccountDraft'], code: 'starter_rich_oms_unavailable',
    explanation: {
      en: 'Reduced OMS reads do not provide rich reports, analytics, document guidance, operator payment links or saved account draft resume.',
      pl: 'Ograniczone odczyty OMS nie zapewniają rozbudowanych raportów, analityki, instrukcji dokumentów, linków płatności operatora ani wznawiania wersji roboczych konta.',
    },
  },
  {
    id: 'N10', actions: ['google'], code: 'oauth_not_supported',
    explanation: {
      en: 'Google sign-in is unavailable. The separate native magic-link and OTP bindings retain their own authority requirements.',
      pl: 'Logowanie Google jest niedostępne. Osobne natywne powiązania linków jednorazowych i OTP zachowują własne wymagania uprawnień.',
    },
  },
];

export const otherLimits = {
  receiveReturn: 'starter_return_receive_unavailable',
  restockReturn: 'starter_return_restock_unavailable',
  refundReturn: 'starter_monetary_refund_unavailable',
  publishCatalog: 'starter_catalog_publication_unavailable',
  lotTraceability: 'starter_inventory_traceability_unavailable',
  reviewMedia: 'host_binding_required',
  legacyUnsubscribe: 'native_legacy_tester_source_unavailable',
} as const;

export function limitFor(action: CopyKey): NativeLimit | undefined {
  return nativeLimits.find(limit => limit.actions.includes(action));
}

/** Release boundaries rendered from the same localized copy as checkout. */
export const releaseLimits = ['attemptLimitsInterim', 'localDatabaseOnly', 'bundlePurchaseLater', 'zeroShipping', 'renewalShippingInterim', 'acquisitionInterim', 'guestPurchase', 'guestRecovery'] as const satisfies readonly CopyKey[];
