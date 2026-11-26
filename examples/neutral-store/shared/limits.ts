import type { Localized } from './config.ts';
import type { Operation } from './api.ts';
import type { CopyKey } from '../owned/copy.ts';

export interface NativeLimit {
  id: string;
  actions: readonly CopyKey[];
  code: string;
  explanation: Localized;
}


/** One immutable catalogue for unmounted operations and their visible explanations. */
export const operationLimitDefinitions = Object.freeze({
  trackingAccess: Object.freeze({
    id: 'trackingAccess', actions: Object.freeze(["tracking"] as const), code: 'starter_tracking_access_unavailable',
    explanation: Object.freeze({ en: "Public tracking lookup is unavailable.",
      pl: "Publiczne wyszukiwanie przesyłki jest niedostępne." }),
  }),
  returnsReader: Object.freeze({
    id: 'returnsReader', actions: Object.freeze(["returns"] as const), code: 'starter_operation_unknown',
    explanation: Object.freeze({ en: "No operator returns list or detail; the operator approves or rejects by the return reference the customer receives.",
      pl: "Nie ma listy ani szczegółów zwrotów dla operatora; operator zatwierdza lub odrzuca zwrot na podstawie numeru zgłoszenia otrzymanego przez klienta." }),
  }),
  researchAuthority: Object.freeze({
    id: 'researchAuthority', actions: Object.freeze(["research"] as const), code: 'host_binding_required',
    explanation: Object.freeze({ en: "Research submission is unavailable until the host can verify access to the research case.",
      pl: "Przesłanie odpowiedzi badawczej jest niedostępne, dopóki aplikacja nie może potwierdzić uprawnień do danej sprawy." }),
  }),
  ingestBinding: Object.freeze({
    id: 'ingestBinding', actions: Object.freeze(["ingest"] as const), code: 'host_binding_required',
    explanation: Object.freeze({ en: "Order import is unavailable until the host supplies the complete trusted import binding.",
      pl: "Import zamówień jest niedostępny, dopóki aplikacja nie udostępni kompletnego, zaufanego mechanizmu importu." }),
  }),
} satisfies Record<string, NativeLimit>);

export const operationLimits: Readonly<Partial<Record<Operation, NativeLimit>>> = Object.freeze({
  'tracking.read': operationLimitDefinitions.trackingAccess,
  'research.submit': operationLimitDefinitions.researchAuthority,
  'ingest.submit': operationLimitDefinitions.ingestBinding,
});

/** Application refusals name unavailable composition without claiming new package capabilities. */
export const nativeLimits: readonly NativeLimit[] = [
  {
    id: 'N1', actions: ['promotion', 'promotionAdmin'], code: 'starter_promotion_write_unavailable',
    explanation: {
      en: 'Live products, SKUs, price lists, price entries and promotions are seed data: one owned demo-seed step with the install connection, no runtime writer for them and no checkout promotion codes. Bundle drafts, compositions, target prices and activation, and catalogue drafts, are administered by a native human operator through their native writers. An activated bundle is not purchasable in this release.',
      pl: 'Produkty, SKU, cenniki, pozycje cenowe i promocje katalogu bieżącego są danymi początkowymi: jeden własny krok demo-seed połączeniem instalacyjnym, bez zapisu tych danych w czasie działania i bez kodów promocyjnych przy zakupie. Wersjami roboczymi pakietów, ich składem, cenami docelowymi i aktywacją oraz wersjami roboczymi katalogu zarządza natywny operator będący człowiekiem przez natywne mechanizmy zapisu. Aktywowanego pakietu nie można kupić w tym wydaniu.',
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
    id: 'N5', actions: ['privateProfile', 'profileViews'], code: 'starter_account_preferences_unavailable',
    explanation: {
      en: 'Private-profile views and complete profile views remain unavailable. Billing profiles, saved addresses and scoped delivery/payment preferences are bound separately.',
      pl: 'Widoki profilu prywatnego i pełne widoki profilu pozostają niedostępne. Profile rozliczeniowe, zapisane adresy oraz preferencje dostawy i płatności są obsługiwane osobno.',
    },
  },
  {
    id: 'N6', actions: ['realPayment', 'setupPaymentMethod', 'replaceCard'], code: 'native_prepared_attempt_store_unsupported',
    explanation: {
      en: 'This starter selects sandbox payments. Native card provider payments and method setup require the complete database catalogue and explicit host composition; these starter actions remain unconfigured.',
      pl: 'Ten starter wybiera płatności testowe. Natywne płatności kartą i konfiguracja metod wymagają pełnego katalogu bazy i jawnej kompozycji hosta; te akcje startera pozostają nieskonfigurowane.',
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
    id: 'N9', actions: ['richOms', 'resumeAccountDraft'], code: 'starter_rich_oms_unavailable',
    explanation: {
      en: 'Reduced OMS reads do not provide rich reports, analytics, document guidance or saved account draft resume.',
      pl: 'Ograniczone odczyty OMS nie zapewniają rozbudowanych raportów, analityki, instrukcji dokumentów ani wznawiania wersji roboczych konta.',
    },
  },
  {
    id: 'N10', actions: ['google'], code: 'oauth_not_supported',
    explanation: {
      en: 'Google sign-in is unavailable. The separate native magic-link and OTP bindings retain their own authority requirements.',
      pl: 'Logowanie Google jest niedostępne. Osobne natywne powiązania linków jednorazowych i OTP zachowują własne wymagania uprawnień.',
    },
  },
  ...Object.values(operationLimitDefinitions),
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
export const releaseLimits = ['attemptLimitsInterim', 'localDatabaseOnly', 'bundlePurchaseLater', 'acquisitionInterim', 'guestPurchase', 'guestRecovery'] as const satisfies readonly CopyKey[];

/** Managed buyer texts of the checkout continuation panel and its answers. Panel texts are keyed by name, answers by code.
 * `{minutes}` is the request-limit window, rounded up. A store that customises them re-applies them on upgrade. */
export const checkoutContinuationCopy = Object.freeze({
  heading: { en: 'Earlier order of this purchase', pl: 'Wcześniejsze zamówienie tego zakupu' },
  intro: {
    en: 'An earlier submit of this purchase created, or may have created, an order. Choose what happens to it before you submit different details.',
    pl: 'Wcześniejsze wysłanie formularza tego zakupu utworzyło lub mogło utworzyć zamówienie. Zanim wyślesz inne dane, wybierz, co ma się z nim stać.',
  },
  resume: { en: 'Complete payment for the earlier order', pl: 'Dokończ płatność za wcześniejsze zamówienie' },
  abandon: { en: 'Cancel the earlier order and start over', pl: 'Anuluj wcześniejsze zamówienie i zacznij od nowa' },
  abandonDetail: {
    en: 'Cancels the earlier unpaid order and releases its stock. Then submit the form again.',
    pl: 'Anuluje wcześniejsze nieopłacone zamówienie i zwalnia zarezerwowany towar. Potem wyślij formularz ponownie.',
  },
  different: { en: 'Start a different purchase', pl: 'Rozpocznij inny zakup' },
  differentDetail: {
    en: 'Your next submit places a new order. The earlier order stays open until the store settles it, and a payment already started for it may still complete.',
    pl: 'Następne wysłanie utworzy nowe zamówienie. Wcześniejsze zamówienie pozostaje otwarte, dopóki sklep go nie rozliczy, a rozpoczęta już płatność za nie może jeszcze zostać zrealizowana.',
  },
  limited: {
    en: 'The store returned the order without a payment link because of its request limit. Try again in {minutes} min.',
    pl: 'Sklep zwrócił zamówienie bez linku do płatności z powodu limitu żądań. Spróbuj ponownie za {minutes} min.',
  },
  differentStarted: {
    en: 'A different purchase was started. Your next submit places a new order.',
    pl: 'Rozpoczęto inny zakup. Następne wysłanie formularza złoży nowe zamówienie.',
  },
  abandoned: {
    en: 'The earlier order was cancelled and its stock released. Submit the form to place a new order.',
    pl: 'Wcześniejsze zamówienie zostało anulowane, a towar zwolniony. Wyślij formularz, aby złożyć nowe zamówienie.',
  },
  changedUnconfirmed: {
    en: 'Your changed details were not sent. An earlier submit of this purchase may have created an order: complete its payment as first submitted, cancel it and start over, or choose "Start a different purchase" to place a new order with these details.',
    pl: 'Zmienione dane nie zostały wysłane. Wcześniejsze wysłanie formularza tego zakupu mogło utworzyć zamówienie: dokończ jego płatność w pierwotnej postaci, anuluj je i zacznij od nowa albo wybierz „Rozpocznij inny zakup”, aby złożyć nowe zamówienie z tymi danymi.',
  },
  resumeNotFound: {
    en: 'No earlier order of this purchase was found yet. Submitting the details you first sent continues this purchase; to place an order with other details, choose "Start a different purchase".',
    pl: 'Nie znaleziono jeszcze wcześniejszego zamówienia tego zakupu. Wysłanie pierwotnie podanych danych kontynuuje ten zakup; aby złożyć zamówienie z innymi danymi, wybierz „Rozpocznij inny zakup”.',
  },
  starter_checkout_changed: {
    en: 'Your changed details were not applied and no second order was created. An earlier order of this purchase is unpaid: complete its payment as first submitted, or cancel it and start over.',
    pl: 'Zmienione dane nie zostały zastosowane i nie utworzono drugiego zamówienia. Wcześniejsze zamówienie tego zakupu jest nieopłacone: dokończ jego płatność w pierwotnej postaci albo anuluj je i zacznij od nowa.',
  },
  starter_checkout_paid: {
    en: 'The earlier order of this purchase is already paid, so nothing new was placed. Choose "Start a different purchase" to buy again.',
    pl: 'Wcześniejsze zamówienie tego zakupu jest już opłacone, więc nic nowego nie zostało złożone. Wybierz „Rozpocznij inny zakup”, aby kupić ponownie.',
  },
  starter_checkout_not_payable: {
    en: 'The earlier order of this purchase is closed or expired and cannot be paid here. A recovery e-mail sent earlier may still lead to it; the store handles any duplicate. Choose "Start a different purchase" to place a new order.',
    pl: 'Wcześniejsze zamówienie tego zakupu jest zamknięte lub wygasło i nie można go tu opłacić. Wysłany wcześniej e-mail z linkiem może jeszcze do niego prowadzić; ewentualnym duplikatem zajmie się sklep. Wybierz „Rozpocznij inny zakup”, aby złożyć nowe zamówienie.',
  },
  starter_checkout_request_stale: {
    en: 'The store was busy and placed nothing. Submit the same details again.',
    pl: 'Sklep był zajęty i niczego nie zapisał. Wyślij te same dane ponownie.',
  },
  starter_checkout_not_found: {
    en: 'No earlier order of this purchase exists, so nothing was continued or cancelled. Submit the form to place your order.',
    pl: 'Nie ma wcześniejszego zamówienia tego zakupu, więc niczego nie kontynuowano ani nie anulowano. Wyślij formularz, aby złożyć zamówienie.',
  },
  starter_checkout_in_progress: {
    en: 'The earlier submit may still be creating its order. Wait a moment and choose again, or submit the original details again to complete it.',
    pl: 'Wcześniejsze wysłanie może nadal tworzyć zamówienie. Poczekaj chwilę i wybierz ponownie albo wyślij pierwotne dane jeszcze raz, aby je dokończyć.',
  },
  starter_checkout_not_abandonable: {
    en: 'The earlier order cannot be cancelled here because a payment was started for it. Complete its payment, or start a different purchase.',
    pl: 'Wcześniejszego zamówienia nie można tu anulować, ponieważ rozpoczęto jego płatność. Dokończ płatność albo rozpocznij inny zakup.',
  },
  starter_checkout_expired: {
    en: 'To buy now, choose "Start a different purchase". The earlier order is older than its 24-hour payment link and gets no new link here. If no payment was ever started for it, "Cancel the earlier order and start over" cancels it instead.',
    pl: 'Aby kupić teraz, wybierz „Rozpocznij inny zakup”. Wcześniejsze zamówienie jest starsze niż 24-godzinny link do płatności i nie otrzyma tu nowego linku. Jeśli nigdy nie rozpoczęto jego płatności, możesz zamiast tego wybrać „Anuluj wcześniejsze zamówienie i zacznij od nowa”.',
  },
  starter_command_conflict: {
    en: 'Another request for this purchase was being saved at the same moment; nothing changed. Submit again in a moment. If this repeats after you started a different purchase of a first subscription, the earlier unpaid order still holds it: ask the store to cancel that order.',
    pl: 'W tej samej chwili zapisywano inne żądanie tego zakupu; nic się nie zmieniło. Wyślij ponownie za chwilę. Jeśli powtarza się to po rozpoczęciu innego zakupu pierwszej subskrypcji, blokuje ją wcześniejsze nieopłacone zamówienie: poproś sklep o jego anulowanie.',
  },
  starter_attempt_limited: {
    en: 'Too many checkout requests in a short time. Try again in {minutes} min.',
    pl: 'Zbyt wiele żądań zamówienia w krótkim czasie. Spróbuj ponownie za {minutes} min.',
  },
  starter_storage_unavailable: {
    en: 'This browser does not let the page keep your purchase in tab storage, so this page keeps it until a reload: submitting the form again continues the same purchase. A reload loses it and may create a second order, so do not reload before the order is placed. "Start a new action" starts a new purchase.',
    pl: 'Ta przeglądarka nie pozwala stronie zachować zakupu w pamięci karty, więc strona przechowuje go do przeładowania: ponowne wysłanie formularza kontynuuje ten sam zakup. Przeładowanie go utraci i może utworzyć drugie zamówienie, więc nie przeładowuj strony przed złożeniem zamówienia. „Rozpocznij nowe działanie” rozpoczyna nowy zakup.',
  },
  starter_checkout_storage_unavailable: {
    en: 'This browser refused to keep the details of this order in tab storage, so nothing was sent.',
    pl: 'Przeglądarka odmówiła zachowania danych tego zamówienia w pamięci karty, więc niczego nie wysłano.',
  },
  starter_checkout_session_changed: {
    en: 'The earlier order of this purchase was placed while you were signed in differently, so it cannot be reached now. Sign in or out as you were when you placed it, then choose again.',
    pl: 'Wcześniejsze zamówienie tego zakupu złożono przy innym stanie logowania, więc teraz nie można do niego dotrzeć. Zaloguj się lub wyloguj się tak, jak przy jego składaniu, a potem wybierz ponownie.',
  },
} satisfies Record<string, Localized>);

/** Managed text of the checkout and payment-status status lines, one per storefront state anchor they carry. */
export const checkoutStateCopy = Object.freeze({
  awaiting_payment: { en: 'Waiting for payment', pl: 'Oczekuje na płatność' },
  details_changed: { en: 'Details changed: nothing was sent', pl: 'Dane zmienione: niczego nie wysłano' },
  awaiting_authority: { en: 'Waiting for the payment outcome', pl: 'Oczekuje na wynik płatności' },
  declined: { en: 'Payment declined', pl: 'Płatność odrzucona' },
  paid: { en: 'Paid', pl: 'Opłacone' },
  paid_pending_activation: { en: 'Paid; activation pending', pl: 'Opłacone; aktywacja w toku' },
} satisfies Record<string, Localized>);
