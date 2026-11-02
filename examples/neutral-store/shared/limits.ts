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
      en: 'Catalogues, prices and promotions are seed data on the portable rail. lifecycle up applies owned/demo-seed.ts once at install, with the install connection in a marked demonstration database. No runtime catalog/price writer or promotion administration and checkout codes are available.',
      pl: 'Katalogi, ceny i promocje są danymi początkowymi ścieżki przenośnej. lifecycle up stosuje owned/demo-seed.ts raz przy instalacji, połączeniem instalacyjnym w oznaczonej bazie demonstracyjnej. Brak zapisu katalogu/cen w czasie działania, zarządzania promocjami i kodów przy zakupie.',
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
    id: 'N8', actions: ['swapRecipe', 'recipeMix', 'portion'], code: 'subscription_command_unsupported_action',
    explanation: {
      en: 'These exact generic verbs are unsupported. Full-bundle updates use their existing distinct command.',
      pl: 'Te konkretne polecenia ogólne są nieobsługiwane. Zmiana całego pakietu używa istniejącego osobnego polecenia.',
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
