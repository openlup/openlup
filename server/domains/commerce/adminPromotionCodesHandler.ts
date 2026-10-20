import { createAdminPromotionCodesHandlers } from "@openlup/platform/promotions";
import { createAdminMutationHandler, createAdminParameterizedReadHandler } from "../../_lib/admin-domain/handlers.js";
import { DomainRpcError, mapRpcError } from "../../_lib/admin-domain/rpcErrors.js";
import { resolveAdmin } from "../../_lib/admin-domain/auth.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { generatePromotionCode, normalizePromotionCode, previewPromotionCode, verifyPromotionPreviewProof } from "./promotionCodePreview.js";
export const { createAdminPromotionCodesListHandler, createAdminPromotionCodePreviewHandler, createAdminPromotionCodeCreateHandler, createAdminPromotionCodeUpdateHandler } = createAdminPromotionCodesHandlers({ createAdminMutationHandler, createAdminParameterizedReadHandler, DomainRpcError, mapRpcError, resolveAdmin, sendBffError, sendBffSuccess, sendMethodNotAllowed, generatePromotionCode, normalizePromotionCode, previewPromotionCode, verifyPromotionPreviewProof });
export type { AdminPromotionCodesHandlerDeps } from "@openlup/platform/promotions";
