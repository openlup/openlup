/**
 * Back-compat surface for the commerce admin BFF routes. The admin auth spine
 * (bearer extraction, Supabase clients, the admin-role gate) was lifted into the
 * domain-neutral kit `api/_lib/admin-domain/auth.ts` in Wave 4.5; it is
 * re-exported here so the ~90 routes importing from this module do not churn.
 * The commerce mutation feature-flag readers stay here (commerce-specific).
 */

import type { HttpRequest } from "../../../_lib/types/http.js";
import {
  authorizeCommerceAdminWithUser,
  createAdminAuthClient,
  readBearerToken,
  readSupabaseAdminCommerceEnv as readAdminCommerceEnvironment,
  type AdminAuthorization,
} from "../../../_lib/admin-domain/auth.js";
import { commerceAgentCustomerReadEnabled } from "../../../_lib/admin-domain/agentCustomerReadGuard.js";
import { createReferenceJourneyAuditClient } from "../../../adapters/referenceJourneyOrderReadbackAdapter.js";
import type { OmsAgentReadGovernance } from "../../../_lib/admin-domain/customerReadGovernance.js";
import { bindBundleDataPort } from "../../../runtime/dataBinding.js";

export {
  readBearerToken,
  readSupabaseAdminCommerceEnv,
  createAdminAuthClient,
  createServiceRoleClient,
  authorizeCommerceAdminWithUser,
} from "../../../_lib/admin-domain/auth.js";
export type { AdminAuthorization, AuthorizeAdmin } from "../../../_lib/admin-domain/auth.js";

/**
 * Deployment-neutral name for the same admin-commerce environment reader. New
 * routes should reach for this one: it says what the value is (the admin commerce
 * environment) rather than which product happens to host it, so a route file
 * carries no deployment vocabulary. The vendor-named export above stays for the
 * ~90 routes already importing it.
 */
export { readAdminCommerceEnvironment };

type ServiceOnlyDataPort = {
  asService: <T>(work: (client: unknown) => Promise<T>) => Promise<T>;
};

interface OperatorReferenceReadCompositionDependencies {
  readEnvironment: typeof readAdminCommerceEnvironment;
  readToken: typeof readBearerToken;
  createAuthClient: typeof createAdminAuthClient;
  authorize: typeof authorizeCommerceAdminWithUser;
  readMachineFlag: typeof commerceAgentCustomerReadEnabled;
  bindService: typeof bindBundleDataPort;
}

const operatorReferenceReadDependencies: OperatorReferenceReadCompositionDependencies = {
  readEnvironment: readAdminCommerceEnvironment,
  readToken: readBearerToken,
  createAuthClient: createAdminAuthClient,
  authorize: authorizeCommerceAdminWithUser,
  readMachineFlag: commerceAgentCustomerReadEnabled,
  bindService: bindBundleDataPort,
};

export function createCommerceAdminReferenceReadComposition(
  req: HttpRequest,
  dependencies: OperatorReferenceReadCompositionDependencies =
    operatorReferenceReadDependencies,
) {
  let authorized = false;
  let servicePort: ServiceOnlyDataPort | null | undefined;

  const resolveServicePort = (): ServiceOnlyDataPort | null => {
    if (!authorized) return null;
    if (servicePort !== undefined) return servicePort;
    const port = dependencies.bindService(process.env);
    servicePort = port
      ? { asService: (work) => port.asService(work) }
      : null;
    return servicePort;
  };

  return {
    authorize: async (): Promise<
      AdminAuthorization | {
        ok: false;
        code: "UPSTREAM_UNAVAILABLE";
        message: string;
      }
    > => {
      const env = dependencies.readEnvironment();
      if (!env) {
        return {
          ok: false,
          code: "UPSTREAM_UNAVAILABLE",
          message: "Admin commerce OMS is not configured",
        };
      }
      const accessToken = dependencies.readToken(req);
      const authorization = await dependencies.authorize(
        dependencies.createAuthClient(env, accessToken),
        accessToken,
      );
      authorized = authorization.ok;
      return authorization;
    },
    servicePort: resolveServicePort,
    governance: (): OmsAgentReadGovernance => ({
      flagEnabled: dependencies.readMachineFlag(),
      auditClient: createReferenceJourneyAuditClient(resolveServicePort),
    }),
  };
}

export function commercePaidFulfillmentRecoveryMutationsEnabled(): boolean {
  return process.env.COMMERCE_PAID_FULFILLMENT_RECOVERY_MUTATIONS_ENABLED === "true";
}

export function commerceOmsRefundMutationsEnabled(): boolean {
  return process.env.COMMERCE_OMS_REFUND_MUTATIONS_ENABLED === "true";
}

export function commerceOmsOrderCancellationEnabled(): boolean {
  return process.env.COMMERCE_OMS_ORDER_CANCELLATION_ENABLED === "true";
}

export function commerceRuntimeMutationsEnabled(): boolean {
  return process.env.COMMERCE_RUNTIME_MUTATIONS_ENABLED === "true";
}

export function commerceSubscriptionMutationsEnabled(): boolean {
  return process.env.COMMERCE_SUBSCRIPTION_MUTATIONS_ENABLED === "true";
}

export function commerceDunningEmailsEnabled(): boolean {
  return process.env.COMMERCE_DUNNING_EMAILS_ENABLED === "true";
}

export function readCommercePromotionPreviewHmacSecret(): string | null {
  const value = process.env.COMMERCE_PROMOTION_PREVIEW_HMAC_SECRET;
  return typeof value === "string" && Buffer.byteLength(value, "utf8") >= 32
    ? value
    : null;
}

export function commerceRiskReviewMutationsEnabled(): boolean {
  return process.env.COMMERCE_RISK_REVIEW_MUTATIONS_ENABLED === "true";
}

export function commerceCatalogMutationsEnabled(): boolean {
  return process.env.COMMERCE_CATALOG_MUTATIONS_ENABLED === "true";
}

export function commerceCatalogActivationEnabled(): boolean {
  return process.env.COMMERCE_CATALOG_ACTIVATION_ENABLED === "true";
}

// Bundle write surface. Three flags, because the three questions are different:
// may anything be written at all, may a bundle be published or unpublished, and
// may the bundle read surface answer. Publication has its own switch so it can be
// off while composition and pricing are being worked on.
export function commerceBundleMutationsEnabled(): boolean {
  return process.env.COMMERCE_BUNDLE_MUTATIONS_ENABLED === "true";
}

export function commerceBundleActivationEnabled(): boolean {
  return process.env.COMMERCE_BUNDLE_ACTIVATION_ENABLED === "true";
}

/** Gates BOTH the admin bundle read routes and the public sellable-bundle feed. */
export function commerceBundleReadsEnabled(): boolean {
  return process.env.COMMERCE_BUNDLE_READ_ENABLED === "true";
}

// Wave 7a — actor-kind-aware governance for agent-operable CUSTOMER reads. The
// flag reader lives in the domain-neutral kit (shared by clients + OMS); re-export
// here so the commerce OMS routes match the existing flag-reader convention.
export { commerceAgentCustomerReadEnabled } from "../../../_lib/admin-domain/agentCustomerReadGuard.js";
