import { catalogDomain } from "./catalog.js";
import { commerceDomain } from "./commerce.js";
import { communicationsDomain } from "./communications.js";
import { fulfillmentDomain } from "./fulfillment.js";
import { identityDomain } from "./identity.js";
import { invoicingDomain } from "./invoicing.js";
import { paymentsDomain } from "./payments.js";
import { platformControlDomain } from "./platformControl.js";
import { pricingAndPromotionsDomain } from "./pricingAndPromotions.js";
import { subscriptionsDomain } from "./subscriptions.js";
import { taxAndMoneyDomain } from "./taxAndMoney.js";

const outsideProfileRelations = {
  "acquisition_private.installation_key": { disposition: "new-target-installation-key", preserveTarget: true },
  "acquisition_private.address_references": { disposition: "target-address-references", preserveTarget: true },
  "public.platform_schema_migrations": { disposition: "target-migration-history", preserveTarget: true },
  "public.customer_identity_challenges": { disposition: "intentionally-not-carried", preserveTarget: false },
  "public.catalog_attribute_projection": { disposition: "rebuildable", preserveTarget: false },
  ...paymentsDomain.outsideProfile,
} as const;

type OutsideProfileRelation = typeof outsideProfileRelations[keyof typeof outsideProfileRelations];
export type ConnectedStoreOutsideProfileDisposition = OutsideProfileRelation["disposition"];
export const connectedStoreOutsideProfileRelations: ReadonlyMap<string, OutsideProfileRelation> =
  new Map(Object.entries(outsideProfileRelations));

/**
 * Finite native-profile owned table roster, composed from per-domain modules in
 * exact capture order. Adding a table to an existing domain edits only that
 * domain's module.
 */
export const connectedStoreOwnedTables = [
  ...taxAndMoneyDomain.owned.moneyAndTax,
  ...subscriptionsDomain.owned.cancelFeedback,
  ...taxAndMoneyDomain.owned.coverageRevisions,
  ...pricingAndPromotionsDomain.owned.promotionDefinitions,
  ...commerceDomain.owned.draftReceipts,
  ...fulfillmentDomain.owned.stockOperations,
  ...commerceDomain.owned.adjustments,
  ...pricingAndPromotionsDomain.owned.promotionClaims,
  ...subscriptionsDomain.owned.dunningAndRetry,
  ...commerceDomain.owned.recoveryAndReminders,
  ...subscriptionsDomain.owned.stockWaitAndLifecycle,
  ...paymentsDomain.owned.all,
  ...commerceDomain.owned.destinations,
  ...subscriptionsDomain.owned.destinationSelections,
  ...fulfillmentDomain.owned.contacts,
  ...subscriptionsDomain.owned.commandsQuotesAndSupport,
  ...identityDomain.owned.humanPrincipals,
  ...catalogDomain.owned.core,
  ...pricingAndPromotionsDomain.owned.priceListsAndPolicies,
  ...subscriptionsDomain.owned.lines,
  ...communicationsDomain.owned.bindingsConsentsAndNative,
  ...identityDomain.owned.customerConsents,
  ...identityDomain.owned.invitationsPrivacyAndCustomer,
  ...invoicingDomain.owned.buyerSnapshots,
  ...commerceDomain.owned.operatorsHoldsAndCompensations,
  ...fulfillmentDomain.owned.stockShipmentsAndOperations,
  ...subscriptionsDomain.owned.deliveryAlignmentAndProfiles,
  ...commerceDomain.owned.reviews,
  ...invoicingDomain.owned.cutoverAndDocuments,
  ...platformControlDomain.owned.controlsAndSettings,
  ...identityDomain.owned.settings,
  ...subscriptionsDomain.owned.settings,
  ...communicationsDomain.owned.dormantOutbox,
  ...subscriptionsDomain.owned.reminders,
  ...communicationsDomain.owned.transactionalReceipts,
  ...subscriptionsDomain.owned.noticeRefusals,
  ...pricingAndPromotionsDomain.owned.offerPolicy,
  ...catalogDomain.owned.priceSetup,
] as const;

export const connectedStoreSettingsTables = [
  ...fulfillmentDomain.settings,
  ...platformControlDomain.settings.salesAndCommerce,
  ...identityDomain.settings,
  ...platformControlDomain.settings.jobControls,
  ...subscriptionsDomain.settings,
  ...pricingAndPromotionsDomain.settings,
] as const;

// Explicit owner order, not schema discovery or a general FK/translation engine.
export const connectedStoreRestoreOrder = [
  ...taxAndMoneyDomain.restore.coverageRevisions,
  ...identityDomain.restore.humanPrincipals,
  ...platformControlDomain.restore.controlOperators,
  ...commerceDomain.restore.operators,
  ...identityDomain.restore.clientsAndMemberships,
  ...platformControlDomain.restore.communicationOperators,
  ...identityDomain.restore.invitationsPrivacyAndCustomer,
  ...platformControlDomain.restore.controlsAlertsAndJobs,
  ...catalogDomain.restore.core,
  ...pricingAndPromotionsDomain.restore.priceListsPoliciesAndPromotions,
  ...catalogDomain.restore.priceSetup,
  ...subscriptionsDomain.restore.root,
  ...pricingAndPromotionsDomain.restore.offerPolicyBaselines,
  ...subscriptionsDomain.restore.eventsQuotesAndTerms,
  ...paymentsDomain.restore.methodRefs,
  ...subscriptionsDomain.restore.methodStates,
  ...subscriptionsDomain.restore.operationsLinesAndCycles,
  ...commerceDomain.restore.orders,
  ...taxAndMoneyDomain.restore.orderLineSources,
  ...commerceDomain.restore.orderItemsAndDraftReceipts,
  ...fulfillmentDomain.restore.stockOperations,
  ...commerceDomain.restore.adjustments,
  ...pricingAndPromotionsDomain.restore.promotionClaims,
  ...subscriptionsDomain.restore.activationsAndMethodEvents,
  ...commerceDomain.restore.checkoutLedgerAndCompensations,
  ...fulfillmentDomain.restore.stockAndReservations,
  ...commerceDomain.restore.settlements,
  ...subscriptionsDomain.restore.reminders,
  ...communicationsDomain.restore.transactionalReceipts,
  ...subscriptionsDomain.restore.noticeRefusals,
  ...paymentsDomain.restore.simulatorProviderAndTruth,
  ...subscriptionsDomain.restore.renewalOutcomes,
  ...communicationsDomain.restore.outboxAndNative,
  ...identityDomain.restore.customerConsents,
  ...fulfillmentDomain.restore.portsShipmentsAndCommands,
  ...commerceDomain.restore.destinations,
  ...subscriptionsDomain.restore.destinationSelections,
  ...fulfillmentDomain.restore.contacts,
  ...taxAndMoneyDomain.restore.postOrders,
  ...subscriptionsDomain.restore.supportCommands,
  ...fulfillmentDomain.restore.dispatchParcelsAndEvidence,
  ...commerceDomain.restore.holdsAndOperations,
  ...subscriptionsDomain.restore.deliveryAlignment,
  ...subscriptionsDomain.restore.dunning,
  ...commerceDomain.restore.recoveryAndReminders,
  ...paymentsDomain.restore.recoveryAuthorities,
  ...subscriptionsDomain.restore.retry,
  ...paymentsDomain.restore.reconciliationAndEvidence,
  ...subscriptionsDomain.restore.stockWaitAndProfiles,
  ...commerceDomain.restore.reviews,
  ...invoicingDomain.restore.all,
] as const;

export function mergeAllowedInsertTriggers(
  domains: readonly Readonly<Record<string, readonly string[]>>[],
): Readonly<Record<string, readonly string[]>> {
  const merged: Record<string, readonly string[]> = Object.create(null) as Record<string, readonly string[]>;
  for (const domain of domains) {
    for (const [table, triggers] of Object.entries(domain)) {
      if (Object.hasOwn(merged, table)) {
        throw new Error(`Duplicate connected-store insert trigger domain entry for table: ${table}`);
      }
      merged[table] = triggers;
    }
  }
  return Object.freeze(merged);
}

export const connectedStoreAllowedInsertTriggers: Readonly<Record<string, readonly string[]>> = mergeAllowedInsertTriggers([
  catalogDomain.allowedInsertTriggers,
  pricingAndPromotionsDomain.allowedInsertTriggers,
  identityDomain.allowedInsertTriggers,
  taxAndMoneyDomain.allowedInsertTriggers,
  subscriptionsDomain.allowedInsertTriggers,
  commerceDomain.allowedInsertTriggers,
  fulfillmentDomain.allowedInsertTriggers,
  communicationsDomain.allowedInsertTriggers,
  platformControlDomain.allowedInsertTriggers,
  paymentsDomain.allowedInsertTriggers,
  invoicingDomain.allowedInsertTriggers,
]);
