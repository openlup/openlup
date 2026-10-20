/** @agent-domain-anti-reference Promotion compatibility harness; use the catalog reference for new admin domains. */
import { adminPromotionUpdateRequestSchema, adminPromotionUpdateResponseSchema, adminPromotionsListResponseSchema } from "../../../src/domains/commerce/adminPromotionsContracts.js";
import { createAdminPromotionsHandlers } from "@openlup/platform/promotions";
import { createAdminMutationHandler, createAdminReadHandler } from "../../_lib/admin-domain/handlers.js";
import { mapRpcError } from "../../_lib/admin-domain/rpcErrors.js";
export const { createAdminPromotionsListHandler, createAdminPromotionUpdateHandler } = createAdminPromotionsHandlers({ createAdminMutationHandler, createAdminReadHandler, mapRpcError }, { adminPromotionUpdateRequestSchema, adminPromotionUpdateResponseSchema, adminPromotionsListResponseSchema });
export type { AdminPromotionsListHandlerDeps, AdminPromotionUpdateHandlerDeps } from "@openlup/platform/promotions";
export { resolveAdmin } from "../../_lib/admin-domain/auth.js";
export type { AdminAuthorization as CommerceAdminAuthorization, AuthorizeAdmin as AuthorizeCommerceAdmin } from "../../_lib/admin-domain/auth.js";
