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
  returnRequest: Object.freeze({
    id: 'returnRequest', actions: Object.freeze(["requestReturn"] as const), code: 'starter_return_request_unavailable',
    explanation: Object.freeze({ en: "Requesting a return is unavailable in this release.",
      pl: "Zgłoszenie zwrotu jest niedostępne w tym wydaniu." }),
  }),
  returnDecision: Object.freeze({
    id: 'returnDecision', actions: Object.freeze(["approveReturn", "rejectReturn"] as const), code: 'starter_return_decision_unavailable',
    explanation: Object.freeze({ en: "Approving and rejecting a return are unavailable in this release. These actions use the customer's return reference.",
      pl: "Zatwierdzanie i odrzucanie zwrotu są niedostępne w tym wydaniu. Te działania używają numeru zgłoszenia otrzymanego przez klienta." }),
  }),
  orderHold: Object.freeze({
    id: 'orderHold', actions: Object.freeze(["hold", "releaseHold"] as const), code: 'starter_order_hold_unavailable',
    explanation: Object.freeze({ en: "Placing and releasing an order hold are unavailable in this release.",
      pl: "Wstrzymanie i zwolnienie zamówienia są niedostępne w tym wydaniu." }),
  }),
  orderCancellation: Object.freeze({
    id: 'orderCancellation', actions: Object.freeze(["cancelUnpaid"] as const), code: 'starter_order_cancellation_unavailable',
    explanation: Object.freeze({ en: "Cancelling an unpaid order is unavailable in this release.",
      pl: "Anulowanie nieopłaconego zamówienia jest niedostępne w tym wydaniu." }),
  }),
  externalRefundMark: Object.freeze({
    id: 'externalRefundMark', actions: Object.freeze(["externalRefund"] as const), code: 'starter_external_refund_mark_unavailable',
    explanation: Object.freeze({ en: "Recording an external refund is unavailable in this release.",
      pl: "Zapisanie informacji o zwrocie środków wykonanym poza sklepem jest niedostępne w tym wydaniu." }),
  }),
  shipmentMutation: Object.freeze({
    id: 'shipmentMutation', actions: Object.freeze(["label", "handoff", "delivery"] as const), code: 'starter_shipment_mutation_unavailable',
    explanation: Object.freeze({ en: "Recording a label, handing over a parcel and recording delivery are unavailable in this release. Shipment reads remain available.",
      pl: "Zapisanie etykiety, przekazanie przesyłki i zapisanie doręczenia są niedostępne w tym wydaniu. Odczyt przesyłek pozostaje dostępny." }),
  }),
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
  'return.request': operationLimitDefinitions.returnRequest,
  'operator.returnApprove': operationLimitDefinitions.returnDecision,
  'operator.returnReject': operationLimitDefinitions.returnDecision,
  'operator.hold': operationLimitDefinitions.orderHold,
  'operator.release': operationLimitDefinitions.orderHold,
  'operator.cancelUnpaid': operationLimitDefinitions.orderCancellation,
  'operator.externalRefund': operationLimitDefinitions.externalRefundMark,
  'operator.label': operationLimitDefinitions.shipmentMutation,
  'operator.handoff': operationLimitDefinitions.shipmentMutation,
  'operator.delivery': operationLimitDefinitions.shipmentMutation,
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
