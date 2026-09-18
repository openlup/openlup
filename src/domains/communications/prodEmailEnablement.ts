import type {
  EmailCanonDeliveryStatus,
  EmailCanonInventoryStatus,
} from "./emailCanon.js";
import type { CommunicationEmailRouteKind } from "./emailRoutingPolicyTypes.js";

export type ProdEmailEnablementStatus = "live" | "dormant_soak" | "dormant_feature";
export type EmailFeatureMaturityState =
  | "live"
  | "gated"
  | "dormant"
  | "contract_only"
  | "no_send";

export const PROD_EMAIL_ENABLEMENT = {
  COMMERCE_OUTBOX_DISPATCH_ENABLED: "live",
  ACCOUNTING_EMAIL_ENABLED: "live",
  SUBSCRIPTION_RENEWAL_OUTBOX_ENABLED: "live",
  COMMERCE_DUNNING_EMAILS_ENABLED: "live",
  COMMERCE_REORDER_REMINDER_ENABLED: "live",
  COMMERCE_SUBSCRIPTION_PAUSE_REMINDERS_ENABLED: "live",
  COMMERCE_SUBSCRIPTION_WINBACK_ENABLED: "live",
  COMMERCE_PROVIDER_AWARE_DELIVERED_EMAIL_ENABLED: "live",
  COMMERCE_ABANDONED_CART_ENABLED: "dormant_soak",
  COMMERCE_RETURNS_ENABLED: "dormant_feature",
  COMMERCE_BACK_IN_STOCK_ENABLED: "dormant_feature",
} as const satisfies Record<string, ProdEmailEnablementStatus>;

export type ProdEmailEnablementFlag = keyof typeof PROD_EMAIL_ENABLEMENT;

export const PROD_EMAIL_ENABLEMENT_REASONS = {
  COMMERCE_OUTBOX_DISPATCH_ENABLED: "Production-intended outbox send path; runtime value lives in Vercel/job controls.",
  ACCOUNTING_EMAIL_ENABLED: "Production-intended invoice PDF delivery through Resend; runtime value lives in Vercel/job controls.",
  SUBSCRIPTION_RENEWAL_OUTBOX_ENABLED: "Production renewal reminders use the outbox path; repo default is not runtime proof.",
  COMMERCE_DUNNING_EMAILS_ENABLED: "Production dunning email path for subscription payment recovery.",
  COMMERCE_REORDER_REMINDER_ENABLED: "Production reorder reminder path is enabled; runtime value lives in Vercel/job controls.",
  COMMERCE_SUBSCRIPTION_PAUSE_REMINDERS_ENABLED: "Production pause/autoresume reminder path is enabled; runtime value lives in Vercel/job controls.",
  COMMERCE_SUBSCRIPTION_WINBACK_ENABLED: "Production winback path is enabled; runtime value lives in Vercel/job controls.",
  COMMERCE_PROVIDER_AWARE_DELIVERED_EMAIL_ENABLED: "Production provider-aware delivered policy is on; the capability map decides, and no registered provider (OmniPack included since 2026-09-14) suppresses our delivered email.",
  COMMERCE_ABANDONED_CART_ENABLED: "Implemented and catalogued, but production operator config keeps abandoned-cart sends disabled pending human reactivation.",
  COMMERCE_RETURNS_ENABLED: "Returns R1 is staged-production only; production customer return emails stay dormant until the returns flag is promoted there.",
  COMMERCE_BACK_IN_STOCK_ENABLED: "Dormant feature: no customer-reachable notify-me UI/restock producer activation.",
} as const satisfies Record<ProdEmailEnablementFlag, string>;

export const PROD_EMAIL_ENABLEMENT_FLAG_PRIORITY = [
  "ACCOUNTING_EMAIL_ENABLED",
  "SUBSCRIPTION_RENEWAL_OUTBOX_ENABLED",
  "COMMERCE_DUNNING_EMAILS_ENABLED",
  "COMMERCE_ABANDONED_CART_ENABLED",
  "COMMERCE_BACK_IN_STOCK_ENABLED",
  "COMMERCE_REORDER_REMINDER_ENABLED",
  "COMMERCE_SUBSCRIPTION_PAUSE_REMINDERS_ENABLED",
  "COMMERCE_SUBSCRIPTION_WINBACK_ENABLED",
  "COMMERCE_PROVIDER_AWARE_DELIVERED_EMAIL_ENABLED",
  "COMMERCE_RETURNS_ENABLED",
  "COMMERCE_OUTBOX_DISPATCH_ENABLED",
] as const satisfies readonly ProdEmailEnablementFlag[];

export const PROD_EMAIL_SLUG_ENABLEMENT_OVERRIDES = {
  "commerce-order-canceled": {
    status: "dormant_feature",
    controllingFlag: "COMMERCE_OUTBOX_DISPATCH_ENABLED",
    reason: "Shared dispatcher flag is live for other transactional email; this slug stays dormant until a real paid-order cancel plus refund producer exists.",
  },
  "commerce-back-in-stock": {
    status: "dormant_feature",
    controllingFlag: "COMMERCE_BACK_IN_STOCK_ENABLED",
    reason: "No public notify-me UI/restock producer is active; do not activate by flipping the flag alone.",
  },
} as const satisfies Record<string, {
  status: ProdEmailEnablementStatus;
  controllingFlag: ProdEmailEnablementFlag | null;
  reason: string;
}>;

export type ProdEmailDormantPolicyNote = {
  id: string;
  label: string;
  status: Exclude<ProdEmailEnablementStatus, "live">;
  controllingFlag: ProdEmailEnablementFlag;
  reason: string;
};

export const PROD_EMAIL_DORMANT_POLICY_NOTES: readonly ProdEmailDormantPolicyNote[] = [];

export type ProdEmailEnablementDecision = {
  status: ProdEmailEnablementStatus;
  controllingFlag: ProdEmailEnablementFlag | null;
  reason: string;
};

export type EmailFeatureMaturityInput = {
  routeKind: CommunicationEmailRouteKind | "none";
  deliveryStatus: EmailCanonDeliveryStatus;
  inventoryStatus: EmailCanonInventoryStatus;
  controllingFlags?: readonly string[];
};

export function isProdEmailEnablementFlag(flag: string): flag is ProdEmailEnablementFlag {
  return Object.prototype.hasOwnProperty.call(PROD_EMAIL_ENABLEMENT, flag);
}

export function selectProdEmailEnablementFlag(
  controllingFlags: readonly string[] | undefined,
): ProdEmailEnablementFlag | null {
  if (!controllingFlags?.length) return null;
  return PROD_EMAIL_ENABLEMENT_FLAG_PRIORITY.find((flag) => controllingFlags.includes(flag)) ?? null;
}

export function resolveProdEmailEnablement(input: {
  id: string;
  routeKind: CommunicationEmailRouteKind | "none";
  deliveryStatus: EmailCanonDeliveryStatus;
  inventoryStatus: EmailCanonInventoryStatus;
  controllingFlags?: readonly string[];
}): ProdEmailEnablementDecision {
  const override = PROD_EMAIL_SLUG_ENABLEMENT_OVERRIDES[input.id];
  if (override) return override;

  const flag = selectProdEmailEnablementFlag(input.controllingFlags);
  if (flag) {
    return {
      status: PROD_EMAIL_ENABLEMENT[flag],
      controllingFlag: flag,
      reason: PROD_EMAIL_ENABLEMENT_REASONS[flag],
    };
  }

  if (isDormantByCanon(input)) {
    return {
      status: "dormant_feature",
      controllingFlag: null,
      reason: "Canon marks this row as planned, contract-only, dormant, or no-send; no production customer send is active.",
    };
  }

  return {
    status: "live",
    controllingFlag: null,
    reason: "Production-intended send path; no production-specific email flag controls this row.",
  };
}

export function resolveEmailFeatureMaturity(
  input: EmailFeatureMaturityInput,
): EmailFeatureMaturityState {
  if (input.deliveryStatus === "no_send" || input.inventoryStatus === "no_send") return "no_send";
  if (input.routeKind === "dormant") return "dormant";
  if (input.deliveryStatus === "contract_only" || input.inventoryStatus === "contract_only") {
    return "contract_only";
  }
  if (input.controllingFlags?.length) return "gated";
  return "live";
}

export function emailFeatureMaturityAllowsCustomerSend(
  state: EmailFeatureMaturityState,
): boolean {
  return state === "live" || state === "gated";
}

function isDormantByCanon(input: {
  routeKind: CommunicationEmailRouteKind | "none";
  deliveryStatus: EmailCanonDeliveryStatus;
  inventoryStatus: EmailCanonInventoryStatus;
}): boolean {
  return input.routeKind === "dormant" ||
    input.deliveryStatus === "contract_only" ||
    input.deliveryStatus === "no_send" ||
    input.inventoryStatus === "planned" ||
    input.inventoryStatus === "contract_only" ||
    input.inventoryStatus === "no_send";
}
