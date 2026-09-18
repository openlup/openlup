import { EMAIL_LIFECYCLE_PLANNED_CANON_ENTRIES } from "./emailLifecycleCanonEntries.js";
import { applyEmailCanonDynamicVerification, applyEmailCanonVerification } from "./emailCanonVerification.js";
import { emailRegistryProjection, insertProjectedEntries } from "#email-registry-projection";

export type EmailCanonRecipientKind = "customer" | "lead" | "admin_internal" | "partner" | "system" | (string & {});
export type EmailCanonRenderer = "canonical_renderer" | "db_template" | "legacy_inline" | "operational_variant" | "provider_external" | "no_send_decision";
export type EmailCanonOriginPolicy = "app_origin_required" | "db_template_origin" | "customer_auth_origin" | "no_customer_cta" | "provider_external" | "not_applicable";
export type EmailCanonStatus = "canonical" | "legacy_inline" | "admin_internal" | "db_template_harden_pending" | "external_provider" | "planned_send" | "planned_no_send";
// The legend is the type. Every value carries the sentence that explains it, so
// a new locale policy cannot be added without saying what it means, and
// `docs/EMAIL_CATALOG.md` renders these notes instead of keeping a second copy
// that could drift. The values name this deployment's launch market; an adopter
// maps them to their own (see the Part II note the catalog renders below them).
export const EMAIL_CANON_LOCALE_POLICY_LEGEND = [
  { value: "pl_en", note: "both locales are maintained for this email; `resolveLocale(country)` picks one at send time." },
  { value: "pl_active_en_fallback", note: "the launch-market copy is the active one and the English variant is the fallback when no launch-market variant resolves." },
  { value: "pl_only_launch_market", note: "launch-market language only, because the email is scoped to that market or to internal operators inside it." },
  { value: "not_applicable", note: "there is no repo-owned copy to localize: a provider-rendered, inactive, or no-send row." },
] as const;
export type EmailCanonLocalePolicy = (typeof EMAIL_CANON_LOCALE_POLICY_LEGEND)[number]["value"];
export type EmailCanonInventoryStatus = "runtime" | "dynamic_runtime" | "legacy_inline" | "planned" | "contract_only" | "no_send" | "fixture_only" | "admin_only" | "external_provider";
export type EmailCanonDeliveryStatus = "implemented" | "contract_only" | "planned" | "no_send" | "external_provider";
export type EmailCanonPolicyFailureMode = "fail_closed" | "fail_open_with_audit" | "not_applicable";
export type EmailCanonMechanism =
  | "outbox_event"
  | "outbox_scan"
  | "dunning_worker"
  | "renewal_worker"
  | "scheduled_worker"
  | "node_action"
  | "edge_function"
  | "bff_route"
  | "supabase_auth"
  | "admin_direct";
export type EmailCanonTriggerRef = `${string}:${number}` | "not_applicable";
export type EmailCanonVerifiedFlag = "green" | "yellow" | "red";

export interface EmailCanonEntry {
  slug: string;
  owner: string;
  recipientKind: EmailCanonRecipientKind;
  customerFacing: boolean;
  triggerSource: string;
  triggerEvent: string;
  renderer: EmailCanonRenderer;
  originPolicy: EmailCanonOriginPolicy;
  ledgerSource: string;
  timing: string;
  idempotencyPolicy: string;
  testCoverage: string;
  status: EmailCanonStatus;
  localePolicy: EmailCanonLocalePolicy;
  inventoryStatus: EmailCanonInventoryStatus;
  deliveryStatus: EmailCanonDeliveryStatus;
  policyFailureMode: EmailCanonPolicyFailureMode;
  mechanism: EmailCanonMechanism;
  triggerRef: EmailCanonTriggerRef;
  verifiedFlag: EmailCanonVerifiedFlag;
  verifiedAt: "2026-07-03";
}

export interface EmailCanonDynamicPattern extends Omit<EmailCanonEntry, "slug"> {
  id: string;
  pattern: RegExp;
  notificationControlKey: string;
}

export { EMAIL_CANON_LIFECYCLE_DECISIONS, type EmailLifecycleDecision } from "./emailLifecycleDecisions.js";

const customerBase = {
  owner: "communications",
  recipientKind: "customer",
  customerFacing: true,
  renderer: "canonical_renderer",
  originPolicy: "app_origin_required",
  ledgerSource: "email_sends + delivery_timeline",
  idempotencyPolicy: "event/outbox dedupe key",
  testCoverage: "registry guard + sender tests",
  status: "canonical",
  localePolicy: "pl_en",
  inventoryStatus: "runtime",
  deliveryStatus: "implemented",
  policyFailureMode: "fail_closed",
} as const;

const adminBase = {
  owner: "operations",
  recipientKind: "admin_internal",
  customerFacing: false,
  originPolicy: "no_customer_cta",
  ledgerSource: "email_sends + delivery_timeline",
  timing: "on trigger",
  idempotencyPolicy: "source event id or per-run guard",
  testCoverage: "registry guard + sender tests",
  status: "admin_internal",
  localePolicy: "pl_only_launch_market",
  inventoryStatus: "admin_only",
  deliveryStatus: "implemented",
  policyFailureMode: "fail_open_with_audit",
} as const;

const commerceRows = [
  ["commerce-order-confirmation", "commerce outbox", "saved order draft", "immediate after order-draft save event"],
  ["commerce-order-paid", "commerce outbox", "payment captured", "immediate after payment success"],
  ["commerce-invoice-document", "accounting invoice delivery", "invoice PDF issued by the configured document provider", "immediate after the issued PDF is ready for customer delivery"],
  ["commerce-payment-failed", "commerce outbox", "recoverable payment decline", "immediate after recoverable decline while order context is active"],
  ["commerce-checkout-expired", "commerce outbox", "checkout payment incomplete after terminal one-time checkout expiry", "payload carries checkout-recovery token when recoverable, otherwise truthful compose fallback"],
  ["commerce-order-canceled", "commerce outbox", "order canceled", "immediate after cancellation"],
  ["commerce-order-refunded", "commerce outbox", "refund recorded", "immediate after refund event"],
  ["commerce-shipment-dispatched", "fulfillment outbox", "shipment dispatched", "immediate after carrier handoff"],
  ["commerce-shipment-delivered", "fulfillment outbox", "shipment delivered", "immediate after delivered status"],
  [
    "commerce-shipment-exception",
    "fulfillment outbox",
    "Omnipack provider exception hold placed",
    "immediate after verified live provider-exception hold",
  ],
  ["commerce-abandoned-cart-1h", "marketing automation", "cart abandoned", "1 hour after eligible abandonment"],
  ["commerce-abandoned-cart-24h", "marketing automation", "cart abandoned", "24 hours after eligible abandonment"],
  ["commerce-abandoned-cart-72h", "marketing automation", "cart abandoned", "72 hours after eligible abandonment"],
  ["commerce-reorder-reminder", "marketing automation", "reorder window reached", "configured reorder cadence"],
  ["commerce-checkout-recovery", "commerce outbox", "checkout payment not completed", "1h/20h after an unpaid order, within the 24h window"],
  ["commerce-return-approved", "commerce outbox", "return request approved", "immediate after return approval"],
  ["commerce-return-rejected", "commerce outbox", "return request rejected", "immediate after return rejection"],
  ["commerce-order-review-request", "marketing automation", "review request window reached", "configured post-delivery review cadence"],
  ["commerce-back-in-stock", "inventory notification", "dormant notify-me/restock producer absent", "dormant until public notify-me UI and restock producer exist"],
  ["commerce-order-review-effects", "marketing automation", "review effect follow-up window reached", "14 to 60 days after provider-confirmed delivery"],
] as const;

const dormantNoSendCustomerOverrides = { testCoverage: "registry guard + dormant producer tripwire + sender tests", deliveryStatus: "no_send", policyFailureMode: "not_applicable" } as const;
const subscriptionRows = [
  ["subscription-welcome", "subscription lifecycle", "subscription created", "immediate after subscription activation"],
  ["subscription-activation-action-required", "subscription lifecycle", "paid initial order missing recurring mandate", "30 minutes after payment if still unresolved"],
  ["subscription-cancelled", "subscription lifecycle", "subscription canceled", "immediate after cancellation"],
  ["subscription-paused", "subscription lifecycle", "subscription paused", "immediate after self-service pause"],
  ["subscription-resumed", "subscription lifecycle", "subscription resumed", "immediate after self-service or auto resume"],
  ["subscription-pause-reminder", "subscription lifecycle", "pause ending soon", "configured pre-resume reminder"],
  ["subscription-renewal-upcoming", "subscription lifecycle", "renewal upcoming", "configured pre-renewal reminder"],
  ["subscription-winback", "subscription lifecycle", "cancelled win-back nudge", "between 14 and 120 days after cancellation"],
  ["subscription-delivery-rescheduled", "subscription self-service", "delivery rescheduled (slide_next_cycle)", "immediate after reschedule"],
  ["subscription-cycle-skipped", "subscription self-service", "cycle skipped (skip_next_cycle)", "immediate after skip"],
  ["subscription-address-changed", "subscription self-service", "shipping address changed", "immediate after address change"],
  ["subscription-package-changed", "subscription self-service", "box edited (recipe/addon/plan/portion)", "immediate after package edit"],
  ["subscription-payment-expired", "subscription dunning", "payment recovery window expired", "after max recovery attempts/window"],
  ["subscription-payment-recovered", "subscription dunning", "dunning case reached recovered", "next dunning cron run within 7 days of recovery"],
  ["subscription-renewal-at-risk", "subscription dunning", "renewal 2-5 days out with an unchargeable stored method", "pre-renewal window, capped at two sends per cause"],
] as const;

export const PROJECTED_RETIRED_EMAIL_SLUGS = emailRegistryProjection.retiredStaticSlugs;
export const RETIRED_OPERATIONAL_EMAIL_SLUGS = [
  "daily-report",
] as const;
const retiredEmailSlugs = new Set<string>([
  ...PROJECTED_RETIRED_EMAIL_SLUGS,
  ...RETIRED_OPERATIONAL_EMAIL_SLUGS,
]);
const retiredNoSend = {
  customerFacing: false, renderer: "no_send_decision", originPolicy: "not_applicable",
  ledgerSource: "historical email_sends + delivery_timeline", timing: "retired; no runtime sender",
  idempotencyPolicy: "no runtime sender may use this slug", testCoverage: "registry retirement guard",
  status: "planned_no_send", localePolicy: "not_applicable",
  inventoryStatus: "no_send", deliveryStatus: "no_send", policyFailureMode: "not_applicable",
} as const;

const adminRows = [
  ["b2b_admin_notification", "partners BFF B2B inquiry submit", "B2B inquiry received", "canonical_renderer"],
  ["admin-user-role-granted", "platform admin invite BFF", "existing admin user role granted", "canonical_renderer"],
  ["daily-report", "historical send-daily-report cron", "retired daily operational summary", "operational_variant"],
] as const;

function canonicalCustomer([slug, triggerSource, triggerEvent, timing]: readonly [string, string, string, string]): EmailCanonEntry {
  return applyEmailCanonVerification(slug === "commerce-back-in-stock" || slug === "commerce-order-canceled" ? { ...customerBase, slug, triggerSource, triggerEvent, timing, ...dormantNoSendCustomerOverrides } : { ...customerBase, slug, triggerSource, triggerEvent, timing });
}

function adminEntry([slug, triggerSource, triggerEvent, renderer]: readonly [string, string, string, EmailCanonRenderer]): EmailCanonEntry {
  if (retiredEmailSlugs.has(slug)) {
    return applyEmailCanonVerification({
      ...adminBase, ...retiredNoSend, slug, triggerSource, triggerEvent,
    });
  }
  return applyEmailCanonVerification({ ...adminBase, slug, triggerSource, triggerEvent, renderer });
}

const EMAIL_CANON_REGISTRY_BASE = [
  ...commerceRows.map(canonicalCustomer),
  ...subscriptionRows.map(canonicalCustomer),
  applyEmailCanonVerification({
    slug: "b2b_confirmation",
    owner: "growth",
    recipientKind: "partner",
    customerFacing: true,
    triggerSource: "partners BFF B2B inquiry submit",
    triggerEvent: "B2B inquiry received",
    renderer: "canonical_renderer",
    originPolicy: "app_origin_required",
    ledgerSource: "email_sends + delivery_timeline",
    timing: "immediate after inquiry insert",
    idempotencyPolicy: "inquiry id + email policy",
    testCoverage: "B2B BFF and managed submit tests + registry guard",
    status: "legacy_inline",
    localePolicy: "pl_only_launch_market",
    inventoryStatus: "legacy_inline",
    deliveryStatus: "implemented",
    policyFailureMode: "fail_closed",
  }),
  ...EMAIL_LIFECYCLE_PLANNED_CANON_ENTRIES,
  ...adminRows.map(adminEntry),
] as const satisfies readonly EmailCanonEntry[];
export const EMAIL_CANON_REGISTRY = insertProjectedEntries(
  EMAIL_CANON_REGISTRY_BASE,
  emailRegistryProjection.staticCanonInsertions.map((insertion) => ({
    ...insertion,
    entries: insertion.entries.map(applyEmailCanonVerification),
  })),
  (entry) => entry.slug,
);

const EMAIL_CANON_DYNAMIC_PATTERNS_BASE = [
  applyEmailCanonDynamicVerification({
    ...customerBase,
    id: "auth-actions",
    pattern: /^auth-[a-z_]+$/,
    notificationControlKey: "auth-*",
    triggerSource: "Supabase auth hook",
    triggerEvent: "magic link/recovery/signup/invite/auth action",
    // Was "deno_canonical_renderer" while a Deno function rendered these. The
    // hook moved to server/domains/auth/authSendEmailHook.ts, which calls the
    // same src/domains/communications/email/render.ts as every other entry, so
    // the Deno renderer is no longer a value this vocabulary can take.
    renderer: "canonical_renderer",
    originPolicy: "customer_auth_origin",
    timing: "immediate auth action",
    idempotencyPolicy: "Supabase auth event id",
    testCoverage: "auth sender tests + preview smoke",
    inventoryStatus: "dynamic_runtime",
  }),
  applyEmailCanonDynamicVerification({
    ...customerBase,
    id: "subscription-payment-failed-attempts",
    pattern: /^subscription-payment-failed-\d+$/,
    notificationControlKey: "subscription-payment-failed-*",
    triggerSource: "subscription dunning",
    triggerEvent: "payment recovery attempt failed",
    // Was "db_template" — a stale carry-over from the superseded edge sender,
    // which did fetch `email_templates`. Production renders this family from
    // src/domains/subscription/emails/subscriptionPaymentFailed.ts through the
    // shared branded renderer, exactly like its `subscription-payment-expired`
    // sibling; the edit guide has cited that TS module all along. The mislabel
    // escaped dbEmailTemplatePolicy.test.ts only because that guard scans the
    // STATIC registry and never the dynamic patterns.
    renderer: "canonical_renderer",
    timing: "configured dunning retry cadence",
    idempotencyPolicy: "subscription invoice attempt key",
    testCoverage: "dunning sender tests + registry guard",
    inventoryStatus: "dynamic_runtime",
  }),
] as const satisfies readonly EmailCanonDynamicPattern[];
export const EMAIL_CANON_DYNAMIC_PATTERNS = [
  ...EMAIL_CANON_DYNAMIC_PATTERNS_BASE,
  ...emailRegistryProjection.dynamicCanonEntries.map(applyEmailCanonDynamicVerification),
] as const satisfies readonly EmailCanonDynamicPattern[];
export const EMAIL_CANON_DYNAMIC_NOTIFICATION_CONTROL_KEYS = EMAIL_CANON_DYNAMIC_PATTERNS.map((entry) => entry.notificationControlKey).sort();
const projectedSlugsWithoutNotificationControl = new Set(emailRegistryProjection.staticSlugsWithoutNotificationControl);
export function hasStaticEmailNotificationControl(entry: EmailCanonEntry): boolean {
  if (retiredEmailSlugs.has(entry.slug)) {
    return !projectedSlugsWithoutNotificationControl.has(entry.slug);
  }
  return entry.slug !== "commerce-invoice-document" && entry.inventoryStatus !== "planned" && entry.inventoryStatus !== "no_send" && entry.renderer !== "provider_external" && entry.renderer !== "no_send_decision";
}

export const EMAIL_CANON_STATIC_NOTIFICATION_CONTROL_SLUGS = EMAIL_CANON_REGISTRY.filter(hasStaticEmailNotificationControl).map((entry) => entry.slug).sort();

export function findEmailCanonEntry(slug: string): EmailCanonEntry | EmailCanonDynamicPattern | null { const exact = EMAIL_CANON_REGISTRY.find((entry) => entry.slug === slug); return exact ?? EMAIL_CANON_DYNAMIC_PATTERNS.find((entry) => entry.pattern.test(slug)) ?? null; }

export function isKnownEmailCanonSlug(slug: string): boolean { return findEmailCanonEntry(slug) !== null; }
