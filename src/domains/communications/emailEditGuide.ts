import {
  EMAIL_CANON_DYNAMIC_PATTERNS,
  EMAIL_CANON_REGISTRY,
  findEmailCanonEntry,
  type EmailCanonDynamicPattern,
  type EmailCanonEntry,
} from "./emailCanon.js";
import { emailRegistryProjection, insertProjectedEntries } from "#email-registry-projection";
export type EmailEditSource =
  | `${string}.ts`
  | `${string}.tsx`
  | `${string}.sql`
  | `db:${string}`
  | `external:${string}`
  | "not_applicable";

export type EmailEditCategory =
  | "commerce_transactional"
  | "commerce_marketing"
  | "subscription_lifecycle"
  | "subscription_dunning"
  | "growth_edge"
  | "growth_bff"
  | "admin_internal"
  | "auth"
  | "planned"
  | (string & {});

export interface EmailEditGuideEntry {
  slug: string;
  category: EmailEditCategory;
  purpose: string;
  copySource: EmailEditSource;
  sendSource: EmailEditSource;
  producerSource: EmailEditSource;
  changeRecipe: string;
  verification: string;
  notes?: string;
}
const canonGuard = "npm run test -- src/domains/communications/emailCanon.test.ts";

const commerceTransactionalSendSource = "server/adapters/resend/transactionalEmailPort.ts";
const commerceMarketingSendSource = "server/adapters/resend/marketingEmailPort.ts";
const subscriptionLifecycleSendSource = "server/adapters/resend/subscriptionLifecycleEmailPort.ts";
const subscriptionDunningSendSource = "server/adapters/resend/subscriptionDunningEmailPort.ts";
// The dunning rail's SCAN-produced notices share one transport adapter: declared
// once, reached through senderAdapterNote like every other entry, so a rename
// moves both guides and no use site re-spells the path.
const subscriptionDunningScanSendSource = "server/adapters/resend/subscriptionDunningScanEmailPort.ts";
const retiredOperationalInventoryNote = "Logical app and matrix delivery is retired no-send. The hosted Edge sources some of these slugs once named were undeployed and then deleted on 2026-09-04, so no provider-capable inventory stands behind them any more.";
const senderAdapterNote = (adapterSource: EmailEditSource): string => `Sender adapter: ${adapterSource}.`;
const producerSourceFromTriggerRef = (triggerRef: EmailCanonEntry["triggerRef"]): EmailEditSource =>
  triggerRef === "not_applicable" ? "not_applicable" : triggerRef.replace(/:\d+$/, "") as EmailEditSource;

const commerceTransactionalEntries = [
  ["commerce-order-confirmation", "src/domains/commerce/emails/orderDraft.ts", "server/domains/commerce/outboxOrderDraftEmailHandler.ts"],
  ["commerce-order-paid", "src/domains/commerce/emails/orderPaid.ts", "server/domains/commerce/outboxOrderPaidEmailHandler.ts"],
  ["commerce-invoice-document", "server/adapters/resend/accountingInvoiceDeliveryPort.ts", "server/adapters/resend/accountingInvoiceDeliveryPort.ts"],
  ["commerce-payment-failed", "src/domains/commerce/emails/paymentFailed.ts", "server/domains/commerce/outboxPaymentFailedEmailHandler.ts"],
  ["commerce-checkout-expired", "src/domains/commerce/emails/checkoutExpired.ts", "server/domains/commerce/outboxCheckoutExpiredEmailHandler.ts"],
  ["commerce-order-canceled", "src/domains/commerce/emails/orderCanceled.ts", "server/domains/commerce/outboxOrderCanceledEmailHandler.ts"],
  ["commerce-order-refunded", "src/domains/commerce/emails/orderRefunded.ts", "server/domains/commerce/outboxOrderRefundedEmailHandler.ts"],
  ["commerce-shipment-dispatched", "src/domains/commerce/emails/shipmentDispatched.ts", "server/domains/commerce/outboxShipmentDispatchedEmailHandler.ts"],
  ["commerce-shipment-delivered", "src/domains/commerce/emails/shipmentDelivered.ts", "server/domains/commerce/outboxShipmentDeliveredEmailHandler.ts"],
  ["commerce-shipment-exception", "src/domains/commerce/emails/shipmentException.ts", "server/domains/commerce/outboxShipmentExceptionEmailHandler.ts"],
  ["commerce-checkout-recovery", "src/domains/commerce/emails/checkoutRecovery.ts", "server/domains/commerce/outboxCheckoutRecoveryEmailHandler.ts"],
  ["commerce-return-approved", "src/domains/commerce/emails/returnEmails.ts", "server/domains/commerce/outboxReturnEmailHandlers.ts"],
  ["commerce-return-rejected", "src/domains/commerce/emails/returnEmails.ts", "server/domains/commerce/outboxReturnEmailHandlers.ts"],
] as const satisfies readonly (readonly [string, EmailEditSource, EmailEditSource])[];

const commerceMarketingEntries = [
  ["commerce-abandoned-cart-1h", "src/domains/commerce/emails/abandonedCart.ts", "server/domains/commerce/outboxAbandonedCartEmailHandler.ts"],
  ["commerce-abandoned-cart-24h", "src/domains/commerce/emails/abandonedCart.ts", "server/domains/commerce/outboxAbandonedCartEmailHandler.ts"],
  ["commerce-abandoned-cart-72h", "src/domains/commerce/emails/abandonedCart.ts", "server/domains/commerce/outboxAbandonedCartEmailHandler.ts"],
  ["commerce-reorder-reminder", "src/domains/commerce/emails/reorderReminder.ts", "server/domains/commerce/outboxReorderReminderEmailHandler.ts"],
  ["commerce-order-review-request", "src/domains/commerce/emails/reviewRequest.ts", "server/domains/commerce/outboxReviewRequestEmailHandler.ts"],
  ["commerce-back-in-stock", "src/domains/commerce/emails/backInStock.ts", "server/domains/commerce/outboxBackInStockEmailHandler.ts"],
  ["commerce-order-review-effects", "src/domains/commerce/emails/reviewEffects.ts", "server/domains/commerce/outboxReviewEffectsEmailHandler.ts"],
] as const satisfies readonly (readonly [string, EmailEditSource, EmailEditSource])[];

const subscriptionLifecycleEntries = [
  ["subscription-welcome", "src/domains/subscription/emails/subscriptionWelcome.ts", "server/domains/subscription/outboxSubscriptionCreatedEmailHandler.ts"],
  ["subscription-activation-action-required", "src/domains/subscription/emails/subscriptionActivationActionRequired.ts", "server/domains/subscription/outboxSubscriptionActivationActionRequiredEmailHandler.ts"],
  ["subscription-cancelled", "src/domains/subscription/emails/subscriptionCancelled.ts", "server/domains/subscription/outboxSubscriptionCancelledEmailHandler.ts"],
  ["subscription-paused", "src/domains/subscription/emails/subscriptionPaused.ts", "server/domains/subscription/outboxSubscriptionPausedEmailHandler.ts"],
  ["subscription-resumed", "src/domains/subscription/emails/subscriptionResumed.ts", "server/domains/subscription/outboxSubscriptionResumedEmailHandler.ts"],
  ["subscription-pause-reminder", "src/domains/subscription/emails/subscriptionPauseReminder.ts", "server/domains/subscription/outboxSubscriptionPauseReminderEmailHandler.ts"],
  ["subscription-renewal-upcoming", "src/domains/subscription/emails/subscriptionRenewalUpcoming.ts", "server/domains/subscription/outboxSubscriptionRenewalUpcomingEmailHandler.ts"],
  ["subscription-winback", "src/domains/subscription/emails/subscriptionWinback.ts", "api/_cron/subscriptionWinbackJob.ts"],
  ["subscription-delivery-rescheduled", "src/domains/subscription/emails/subscriptionDeliveryRescheduled.ts", "server/domains/subscription/outboxSubscriptionChangeEmailHandlers.ts"],
  ["subscription-cycle-skipped", "src/domains/subscription/emails/subscriptionCycleSkipped.ts", "server/domains/subscription/outboxSubscriptionChangeEmailHandlers.ts"],
  ["subscription-address-changed", "src/domains/subscription/emails/subscriptionAddressChanged.ts", "server/domains/subscription/outboxSubscriptionChangeEmailHandlers.ts"],
  ["subscription-package-changed", "src/domains/subscription/emails/subscriptionPackageChanged.ts", "server/domains/subscription/outboxSubscriptionChangeEmailHandlers.ts"],
] as const satisfies readonly (readonly [string, EmailEditSource, EmailEditSource])[];

const growthEntries = [
  ["b2b_confirmation", "growth_bff", "server/adapters/email/privateLabelB2BInquiryPresenter.ts", "server/adapters/email/privateLabelB2BInquiryPresenter.ts"],
] as const satisfies readonly (readonly [string, EmailEditCategory, EmailEditSource, EmailEditSource])[];

const adminEntries = [
  ["b2b_admin_notification", "admin_internal", "server/adapters/email/privateLabelB2BInquiryPresenter.ts", "server/adapters/email/privateLabelB2BInquiryPresenter.ts"],
  ["admin-user-role-granted", "admin_internal", "server/adapters/email/adminRoleNotificationPort.ts", "server/adapters/email/adminRoleNotificationPort.ts"],
  ["daily-report", "admin_internal", "not_applicable", "not_applicable"],
] as const satisfies readonly (readonly [string, EmailEditCategory, EmailEditSource, EmailEditSource])[];

const plannedEntries = ["account-deletion-confirmation", "subscription-card-expiring", "subscription-dunning-admin-escalation"] as const;

const EMAIL_EDIT_GUIDE_BASE = [
  ...commerceTransactionalEntries.map(([slug, copySource, handlerSource]) =>
    staticGuide(slug, "commerce_transactional", copySource, handlerSource, {
      producerSource: slug === "commerce-invoice-document" ? "server/domains/accounting/accountingInvoiceDeliveryJob.ts" : undefined,
      notes: senderAdapterNote(slug === "commerce-invoice-document" ? "server/adapters/resend/accountingInvoiceDeliveryPort.ts" : commerceTransactionalSendSource),
      verification: slug === "commerce-invoice-document" ? `${canonGuard} plus server/adapters/resend/accountingInvoiceDeliveryPort.test.ts and server/domains/accounting/accountingJobService.test.ts` : `${canonGuard} plus the nearest ${copySource} and ${handlerSource} tests`,
    }),
  ),
  ...commerceMarketingEntries.map(([slug, copySource, handlerSource]) =>
    staticGuide(slug, "commerce_marketing", copySource, handlerSource, {
      producerSource: slug === "commerce-order-review-effects"
        ? "supabase/migrations/20260826170002_email_timing_windows.sql"
        : undefined,
      notes: senderAdapterNote(commerceMarketingSendSource),
      verification: `${canonGuard} plus the nearest ${copySource} and ${handlerSource} tests`,
    }),
  ),
  ...subscriptionLifecycleEntries.map(([slug, copySource, handlerSource]) =>
    staticGuide(slug, "subscription_lifecycle", copySource, handlerSource, {
      producerSource: slug === "subscription-winback" ? "api/_cron/subscriptionWinbackJob.ts" : undefined,
      notes: senderAdapterNote(subscriptionLifecycleSendSource),
      verification: `${canonGuard} plus the nearest ${copySource} and ${handlerSource} tests`,
    }),
  ),
  staticGuide("subscription-payment-recovered", "subscription_dunning", "src/domains/subscription/emails/subscriptionPaymentRecovered.ts", "server/domains/subscription/subscriptionPaymentRecoveredWorker.ts", {
    producerSource: "api/_cron/subscriptionDunningDispatchJob.ts",
    notes: `${senderAdapterNote(subscriptionDunningScanSendSource)} Dedupe is the dunning case id in the email_sends ledger — one send per case, ever.`,
    verification: `${canonGuard} plus src/domains/subscription/emails/subscriptionPaymentRecovered.test.ts and server/domains/subscription/subscriptionPaymentRecoveredWorker.test.ts`,
  }),
  staticGuide("subscription-renewal-at-risk", "subscription_dunning", "src/domains/subscription/emails/subscriptionRenewalAtRisk.ts", "server/domains/subscription/subscriptionRenewalAtRiskWorker.ts", {
    producerSource: "api/_cron/subscriptionDunningDispatchJob.ts",
    notes: `${senderAdapterNote(subscriptionDunningScanSendSource)} Dedupe AND the two-send cap are one email_sends key: <subscriptionId>:<cause>:<renewalDayUTC>. Changing its shape retroactively resets every cap. The cause sentence is shared with the other dunning notices and lives in src/domains/subscription/subscriptionPaymentCauseCopy.ts.`,
    verification: `${canonGuard} plus src/domains/subscription/emails/subscriptionRenewalAtRisk.test.ts and server/domains/subscription/subscriptionRenewalAtRiskWorker.test.ts`,
  }),
  staticGuide("subscription-payment-expired", "subscription_dunning", "src/domains/subscription/emails/subscriptionPaymentExpired.ts", "server/domains/subscription/subscriptionDunningDispatchWorker.ts", {
    producerSource: "api/_cron/subscriptionDunningDispatchJob.ts",
    notes: `${senderAdapterNote(subscriptionDunningSendSource)} The cause sentence is shared with the other dunning notices and lives in src/domains/subscription/subscriptionPaymentCauseCopy.ts.`,
    verification: `${canonGuard} plus src/domains/subscription/emails/subscriptionPaymentExpired.test.ts and server/domains/subscription/subscriptionDunningDispatchWorker.test.ts`,
  }),
  ...growthEntries.map(([slug, category, copySource, sendSource]) =>
    staticGuide(slug, category, copySource, sendSource, {
      verification: `${canonGuard} plus the nearest ${sendSource} test`,
      notes: undefined,
    }),
  ),
  ...plannedEntries.map((slug) =>
    staticGuide(slug, "planned", "not_applicable", "not_applicable", {
      changeRecipe: "This is a planned send contract. Add copy, sender, route, trigger evidence, and tests before treating it as active.",
      verification: canonGuard,
      notes: "Planned only; no runtime send path is present.",
    }),
  ),
  ...adminEntries.map(([slug, category, copySource, sendSource]) =>
    staticGuide(slug, category, copySource, sendSource, {
      producerSource: sendSource === "not_applicable" ? undefined : sendSource,
      verification: sendSource === "not_applicable" ? canonGuard : `${canonGuard} plus the nearest ${sendSource} test`,
      notes: sendSource === "not_applicable" ? retiredOperationalInventoryNote : undefined,
    }),
  ),
] as const satisfies readonly EmailEditGuideEntry[];
export const EMAIL_EDIT_GUIDE = insertProjectedEntries(
  EMAIL_EDIT_GUIDE_BASE,
  emailRegistryProjection.staticEditGuideInsertions,
  (entry) => entry.slug,
);

export const EMAIL_DYNAMIC_EDIT_GUIDE = [
  dynamicGuide("auth-actions", "auth", "server/runtime/authEmailContentBinding.ts", "server/domains/auth/authSendEmailHook.ts", {
    producerSource: "server/domains/auth/authSendEmailHook.ts",
    changeRecipe: "Edit the auth content table the `#auth-email-content` condition resolves to, then keep the signed Supabase Auth hook and redirect-origin tests green.",
    verification: `${canonGuard} plus the signed-hook suite that ships beside that content table`,
    notes: "Auth copy is deployment-owned. `copySource` names the portable default, which refuses a signed request with a retryable 503; package.json maps `#auth-email-content` to the deployment's own table, and the hook suite lives beside it.",
  }),
  dynamicGuide("subscription-payment-failed-attempts", "subscription_dunning", "src/domains/subscription/emails/subscriptionPaymentFailed.ts", "server/domains/subscription/subscriptionDunningDispatchWorker.ts", {
    producerSource: "api/_cron/subscriptionDunningDispatchJob.ts",
    notes: `Runtime slugs are subscription-payment-failed-1/2/3 and share ${subscriptionDunningSendSource}. The cause sentence is shared with the other dunning notices and lives in src/domains/subscription/subscriptionPaymentCauseCopy.ts.`,
    verification: `${canonGuard} plus src/domains/subscription/emails/subscriptionPaymentFailed.test.ts and server/domains/subscription/subscriptionDunningDispatchWorker.test.ts`,
  }),
  ...emailRegistryProjection.dynamicEditGuideEntries,
] as const satisfies readonly EmailEditGuideEntry[];
export const EMAIL_EDIT_GUIDE_BY_SLUG = Object.freeze(
  Object.fromEntries(EMAIL_EDIT_GUIDE.map((entry) => [entry.slug, entry])),
) as Readonly<Record<string, EmailEditGuideEntry>>;

export const EMAIL_DYNAMIC_EDIT_GUIDE_BY_ID = Object.freeze(
  Object.fromEntries(EMAIL_DYNAMIC_EDIT_GUIDE.map((entry) => [entry.slug, entry])),
) as Readonly<Record<string, EmailEditGuideEntry>>;

export function findEmailEditGuide(slugOrPatternId: string): EmailEditGuideEntry | null {
  const staticEntry = EMAIL_EDIT_GUIDE_BY_SLUG[slugOrPatternId];
  if (staticEntry) return staticEntry;
  const dynamicEntry = EMAIL_DYNAMIC_EDIT_GUIDE_BY_ID[slugOrPatternId];
  if (dynamicEntry) return dynamicEntry;
  const pattern = EMAIL_CANON_DYNAMIC_PATTERNS.find((entry) => entry.pattern.test(slugOrPatternId));
  return pattern ? EMAIL_DYNAMIC_EDIT_GUIDE_BY_ID[pattern.id] ?? null : null;
}

function staticGuide(
  slug: string,
  category: EmailEditCategory,
  copySource: EmailEditSource,
  sendSource: EmailEditSource,
  options: Partial<Pick<EmailEditGuideEntry, "producerSource" | "changeRecipe" | "verification" | "notes">> = {},
): EmailEditGuideEntry {
  const entry = mustStaticCanonEntry(slug);
  return {
    slug,
    category,
    purpose: `${entry.triggerEvent}; ${entry.timing}`,
    copySource,
    sendSource,
    producerSource: options.producerSource ?? producerSourceFromTriggerRef(entry.triggerRef),
    changeRecipe: options.changeRecipe ?? defaultChangeRecipe(entry, copySource, sendSource),
    verification: options.verification ?? canonGuard,
    ...(options.notes ? { notes: options.notes } : {}),
  };
}

function dynamicGuide(
  id: string,
  category: EmailEditCategory,
  copySource: EmailEditSource,
  sendSource: EmailEditSource,
  options: Partial<Pick<EmailEditGuideEntry, "producerSource" | "changeRecipe" | "verification" | "notes">> = {},
): EmailEditGuideEntry {
  const entry = mustDynamicCanonEntry(id);
  return {
    slug: id,
    category,
    purpose: `${entry.triggerEvent}; ${entry.timing}`,
    copySource,
    sendSource,
    producerSource: options.producerSource ?? producerSourceFromTriggerRef(entry.triggerRef),
    changeRecipe: options.changeRecipe ?? defaultChangeRecipe(entry, copySource, sendSource),
    verification: options.verification ?? canonGuard,
    ...(options.notes ? { notes: options.notes } : {}),
  };
}

function defaultChangeRecipe(
  entry: EmailCanonEntry | EmailCanonDynamicPattern,
  copySource: EmailEditSource,
  sendSource: EmailEditSource,
): string {
  if (copySource === "not_applicable" || sendSource === "not_applicable") {
    return "Treat as non-runtime/planned until canon status, routing, sender, and trigger evidence are updated together.";
  }
  if (copySource.startsWith("db:")) {
    return "Change copy through a Supabase migration for the DB template row; do not hand-edit production data.";
  }
  if (entry.deliveryStatus !== "implemented") {
    return "Edit copy only as part of activating the contract; update routing policy and runtime tests in the same change.";
  }
  return "Edit the copy source first; touch sender/producer only when payload, timing, routing, or delivery policy changes.";
}

function mustStaticCanonEntry(slug: string): EmailCanonEntry {
  const entry = findEmailCanonEntry(slug);
  if (!entry || !("slug" in entry)) throw new Error(`Missing static email canon entry for ${slug}`);
  return entry;
}

function mustDynamicCanonEntry(id: string): EmailCanonDynamicPattern {
  const entry = EMAIL_CANON_DYNAMIC_PATTERNS.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Missing dynamic email canon entry for ${id}`);
  return entry;
}

// Force evaluation during module import so a deleted canon entry fails early.
for (const entry of EMAIL_CANON_REGISTRY) {
  if (!EMAIL_EDIT_GUIDE_BY_SLUG[entry.slug]) throw new Error(`Missing email edit guide entry for ${entry.slug}`);
}
for (const entry of EMAIL_CANON_DYNAMIC_PATTERNS) {
  if (!EMAIL_DYNAMIC_EDIT_GUIDE_BY_ID[entry.id]) throw new Error(`Missing dynamic email edit guide entry for ${entry.id}`);
}
