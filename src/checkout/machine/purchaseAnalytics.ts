import { projectPaidPurchase } from "@openlup/platform/marketing";
import type { PurchaseOrder, PurchaseSuppressionReason } from "@openlup/platform/marketing/contracts";
import type {
  OrderRecapV3Response,
  OrderRecapV4Response,
} from "@/domains/commerce/orderRecapContracts";

type AnalyticsOrderRecap = OrderRecapV3Response | OrderRecapV4Response;
import {
  emitAnalyticsEvent,
  isAnalyticsLoaderReady,
  type AnalyticsEventMap,
} from "@/lib/analytics/dataLayer";

const PURCHASE_DEDUPE_PREFIX = "openlup-ga4-v1-purchase-tracked-";
const DEPLOYMENT_PURCHASE_DEDUPE_PREFIX = "deployment-analytics-v1-purchase-tracked-";
const admittedDeploymentPurchaseKeys = new Set<string>();
/**
 * Admit purchase independently to the deployment projection and, once ready,
 * GTM. Neither admission is a transport or business acknowledgement.
 */
export function trackPurchaseOnce(recap: AnalyticsOrderRecap): void {
  const payload = buildPurchasePayload(recap);
  if (!payload) return;

  const optionalDedupeKey = `${PURCHASE_DEDUPE_PREFIX}${recap.orderId}`;
  const deploymentDedupeKey = `${DEPLOYMENT_PURCHASE_DEDUPE_PREFIX}${recap.orderId}`;
  const deploymentSeen =
    admittedDeploymentPurchaseKeys.has(deploymentDedupeKey) ||
    hasSessionDedupe(deploymentDedupeKey);
  const optionalSeen = hasSessionDedupe(optionalDedupeKey);
  const attempts = {
    deployment: !deploymentSeen,
    optional: isOptionalReady() && !optionalSeen,
  };
  if (!attempts.deployment && !attempts.optional) return;

  const admitted = emitAnalyticsEvent("purchase", payload, attempts);
  if (admitted.deployment) {
    admittedDeploymentPurchaseKeys.add(deploymentDedupeKey);
    writeSessionDedupe(deploymentDedupeKey);
  }
  if (admitted.optional) writeSessionDedupe(optionalDedupeKey);
}

function isOptionalReady(): boolean {
  try {
    return isAnalyticsLoaderReady();
  } catch {
    return false;
  }
}

function hasSessionDedupe(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeSessionDedupe(key: string): void {
  try {
    sessionStorage.setItem(key, "1");
  } catch {
    // Deployment has a document-local fallback; GTM keeps its prior best-effort
    // behavior when browser session storage is unavailable.
  }
}

export function buildPurchasePayload(
  recap: AnalyticsOrderRecap,
): AnalyticsEventMap["purchase"] | null {
  // The reference admits initial checkout only. Guard at the projection's kind
  // check so order/payment refusals retain their existing precedence.
  // The validated recap supplies these facts; non-strict Zod inference marks
  // nullable fields optional, so retain the required structural view here.
  return projectPaidPurchase({
    ...recap,
    checkoutKind: recap.checkoutKind === "one_time" || recap.checkoutKind === "subscription_initial"
      ? recap.checkoutKind : null,
  } as PurchaseOrder, suppressPurchase);
}

function suppressPurchase(reason: PurchaseSuppressionReason): null {
  if (import.meta.env.DEV || isPurchaseSuppressionDiagnosticHost()) {
    console.warn(`[analytics] purchase suppressed: ${reason}`);
  }
  return null;
}

function isPurchaseSuppressionDiagnosticHost(): boolean {
  if (typeof window === "undefined") return false;
  const { hostname } = window.location;
  return hostname === "staging.openlup.com" || /^openlup-hidden-preview-[a-z0-9-]+\.vercel\.app$/.test(hostname);
}
