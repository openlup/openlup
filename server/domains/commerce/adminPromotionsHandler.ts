import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import {
  type AdminPromotionUpdateRequest,
  adminPromotionUpdateRequestSchema,
  adminPromotionUpdateResponseSchema,
  adminPromotionsListResponseSchema,
} from "../../../src/domains/commerce/adminPromotionsContracts.js";
import type { AgentDomainMutationSpec } from "../../../src/lib/agent-domain/domainSpec.js";
import {
  createAdminMutationHandler,
  createAdminReadHandler,
} from "../../_lib/admin-domain/handlers.js";
import { mapRpcError } from "../../_lib/admin-domain/rpcErrors.js";
import type { AuthorizeAdmin } from "../../_lib/admin-domain/auth.js";
import type { AdminPromotionsDataPort } from "./adminPromotionsDataPort.js";

/**
 * @agent-domain-anti-reference
 * NOT THE REFERENCE. Promotions ("Rabaty") predates the agent-operable kit and is
 * refactored ONTO it here as a back-compat regression harness for the thin
 * authz / flag / envelope slice — NOT a blueprint for a new domain (copy the
 * catalog `@agent-domain-reference` files instead). Promotions is human-admin
 * only (no machine actor) and its mutation is a plain table UPDATE, not a
 * single-RPC rule boundary.
 *
 * Wave 4.5 fixes two bugs while moving it onto the kit:
 *  1. Empty-catch error-flattening — the old blanket `catch { UPSTREAM_UNAVAILABLE }`
 *     hid every failure cause; errors now flow through the kit `mapRpcError`, so a
 *     structured RPC RAISE surfaces its real code/reason.
 *  2. Non-atomic, silently-swallowed audit — the audit was a best-effort direct
 *     `admin_audit_events` INSERT in a `catch {}`. It now goes through the
 *     non-repudiable `record_admin_audit_event` fn and is a REQUIRED step (its
 *     failure fails the request instead of vanishing).
 *
 * DEFERRED (needs a migration, out of this no-migration wave): folding the UPDATE
 * + audit into one combined RPC for true single-statement atomicity, and the
 * `admin_audit_events` BEFORE-INSERT fn-only trigger. Tracked for a follow-up.
 */

// Back-compat: these moved to the domain-neutral kit; re-exported so the sibling
// commerce admin handlers (shipping-rate, catalog-price, subscription-band) that
// import them from this module keep compiling unchanged.
export { resolveAdmin } from "../../_lib/admin-domain/auth.js";
export type {
  AdminAuthorization as CommerceAdminAuthorization,
  AuthorizeAdmin as AuthorizeCommerceAdmin,
} from "../../_lib/admin-domain/auth.js";

export interface AdminPromotionsListHandlerDeps {
  dataPort: AdminPromotionsDataPort;
  authorizeAdmin: AuthorizeAdmin;
}

export function createAdminPromotionsListHandler({
  dataPort,
  authorizeAdmin,
}: AdminPromotionsListHandlerDeps) {
  return createAdminReadHandler({
    authorizeAdmin,
    load: () => dataPort.listPromotions(),
    toResponse: (promotions) => ({ contractVersion: COMMERCE_CONTRACT_VERSION, promotions }),
    responseSchema: adminPromotionsListResponseSchema,
    invalidResponseMessage: "Admin promotions list returned invalid response",
    failureMessage: "Admin promotions list failed",
  });
}

export interface AdminPromotionUpdateHandlerDeps {
  dataPort: AdminPromotionsDataPort;
  authorizeAdmin: AuthorizeAdmin;
}

const promotionUpdateMutation: AgentDomainMutationSpec<AdminPromotionUpdateRequest> = {
  key: "update",
  requestSchema: adminPromotionUpdateRequestSchema,
  gate: "mutation",
  allowedActorKinds: ["human"],
  lifecycleMarkers: [],
};

export function createAdminPromotionUpdateHandler({
  dataPort,
  authorizeAdmin,
}: AdminPromotionUpdateHandlerDeps) {
  return createAdminMutationHandler<AdminPromotionUpdateRequest, { id: string }>({
    mutation: promotionUpdateMutation,
    authorizeAdmin,
    invoke: async (actorId, input) => {
      await dataPort.updatePromotion(input.id, input.updates);
      const action =
        input.updates.status !== undefined ? "promo_status_change" : "promo_update";
      // Required, non-repudiable audit via the fn — no longer best-effort/swallowed.
      await dataPort.recordPromotionAudit({
        actorId,
        actorEmail: null,
        action,
        promotionId: input.id,
        newValue: input.updates as Record<string, unknown>,
      });
      return { id: input.id };
    },
    toResponse: ({ id }) => ({ contractVersion: COMMERCE_CONTRACT_VERSION, updated: true, id }),
    responseSchema: adminPromotionUpdateResponseSchema,
    invalidResponseMessage: "Admin promotion update returned invalid response",
    invalidRequestMessage: "Invalid promotion update request",
    failureMessage: "Admin promotion update failed",
    mapError: mapRpcError,
  });
}
