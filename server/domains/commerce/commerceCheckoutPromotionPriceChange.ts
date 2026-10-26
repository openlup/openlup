import { createPromotionPriceChange } from "@openlup/platform/commerce/server";
import { mapAcquisitionTermsFailure, CommerceQuoteCatalogReadError, CommerceQuoteError } from "@openlup/platform/pricing";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import type { VercelResponse } from "../../_lib/types/vercel.js";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type { ConfiguratorIntentPersistenceResponse } from "../../../src/domains/commerce/configuratorIntentPersistenceContracts.js";
import type { CreateQuoteRequest, CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import { buildQuoteRequest } from "./commerceCheckoutOrchestrationHelpers.js";
import { buildCheckoutPriceChangedResponse, type PriceChangedResponse } from "./commerceCheckoutQuoteGuard.js";
export function respondQuoteFailure(res: VercelResponse, error: unknown): boolean {
  const acquisition = mapAcquisitionTermsFailure(error);
  if (acquisition) { sendBffError(res, acquisition.code, "Acquisition terms unavailable", { details: acquisition.details }); return true; }
  if (error instanceof CommerceQuoteCatalogReadError) { sendBffError(res, "UPSTREAM_UNAVAILABLE", "Commerce catalog is unavailable", { details: { reason: "catalog_unavailable", refusalCode: error.code } }); return true; }
  if (error instanceof CommerceQuoteError) { sendBffError(res, error.code === "UNKNOWN_SKU" ? "BAD_REQUEST" : "CONFLICT", error.message, { details: error.details }); return true; }
  return false;
}
export const { rejectMissingPromotionExpectedQuote, respondToPromotionCodePriceChange } = createPromotionPriceChange<ConfiguratorIntent, Pick<ConfiguratorIntentPersistenceResponse, "clientId" | "petId" | "addressId">, CreateQuoteRequest, CreateQuoteResponse, PriceChangedResponse>({ responder: { sendBffError, sendBffSuccess, sendMethodNotAllowed }, buildQuoteRequest, buildCheckoutPriceChangedResponse, respondQuoteFailure });
