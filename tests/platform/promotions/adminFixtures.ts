// Bind the actual shared reference kit; package code owns no duplicate authorization/error logic.
import { createAdminPromotionCodesHandlers, createAdminPromotionsHandlers, createAdminPromotionSchemas, createPromotionCodePreview } from "@openlup/platform/promotions";
import { createAdminMutationHandler, createAdminReadHandler, createAdminParameterizedReadHandler } from "../../../server/_lib/admin-domain/handlers.js";
import { DomainRpcError, mapRpcError } from "../../../server/_lib/admin-domain/rpcErrors.js";
import { resolveAdmin } from "../../../server/_lib/admin-domain/auth.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../../server/_lib/bff/response.js";
import { platformCurrencySchema } from "../../../src/lib/currency/platformCurrency.js";
import type { PromotionAdminBindings } from "@openlup/platform/promotions";
export { DomainRpcError };
export type { AdminPromotionCodesHandlerDeps } from "@openlup/platform/promotions";
export const preview = createPromotionCodePreview({ minimumProductPayableMinor: 100 });
export const { previewPromotionCode } = preview;
export const bindings: PromotionAdminBindings = { createAdminMutationHandler, createAdminReadHandler, createAdminParameterizedReadHandler, DomainRpcError, mapRpcError, resolveAdmin, sendBffError, sendBffSuccess, sendMethodNotAllowed, ...preview };
export const { createAdminPromotionsListHandler, createAdminPromotionUpdateHandler } = createAdminPromotionsHandlers(bindings, createAdminPromotionSchemas({ currencySchema: platformCurrencySchema }));
export const { createAdminPromotionCodesListHandler, createAdminPromotionCodeCreateHandler, createAdminPromotionCodeUpdateHandler, createAdminPromotionCodePreviewHandler } = createAdminPromotionCodesHandlers(bindings);
