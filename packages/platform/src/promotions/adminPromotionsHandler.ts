/** @agent-domain-anti-reference Promotion compatibility harness; use the catalog reference for new admin domains. */
import { COMMERCE_CONTRACT_VERSION } from "../pricing/index.js";
import type { createAdminPromotionSchemas } from "./adminPromotionsContracts.js";
import type { AdminPromotionUpdateRequest } from "./contracts/index.js";
import type { AgentDomainMutationSpec } from "./adminBindings.js";
import type { AuthorizeAdmin, PromotionAdminBindings } from "./adminBindings.js";
import type { AdminPromotionsDataPort } from "./adminPromotionsDataPort.js";
/** Human-admin promotion edits retain the required audit and the existing non-atomic update boundary. */

export interface AdminPromotionsListHandlerDeps {
  dataPort: AdminPromotionsDataPort;
  authorizeAdmin: AuthorizeAdmin;
}
export interface AdminPromotionUpdateHandlerDeps {
  dataPort: AdminPromotionsDataPort;
  authorizeAdmin: AuthorizeAdmin;
}

export function createAdminPromotionsHandlers({ createAdminMutationHandler, createAdminReadHandler, mapRpcError }: Pick<PromotionAdminBindings, "createAdminMutationHandler" | "createAdminReadHandler" | "mapRpcError">, { adminPromotionUpdateRequestSchema, adminPromotionUpdateResponseSchema, adminPromotionsListResponseSchema }: Pick<ReturnType<typeof createAdminPromotionSchemas>, "adminPromotionUpdateRequestSchema" | "adminPromotionUpdateResponseSchema" | "adminPromotionsListResponseSchema">) {
function createAdminPromotionsListHandler({
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

const promotionUpdateMutation: AgentDomainMutationSpec<AdminPromotionUpdateRequest> = {
  key: "update",
  requestSchema: adminPromotionUpdateRequestSchema,
  gate: "mutation",
  allowedActorKinds: ["human"],
  lifecycleMarkers: [],
};

function createAdminPromotionUpdateHandler({
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
return { createAdminPromotionsListHandler, createAdminPromotionUpdateHandler };
}
