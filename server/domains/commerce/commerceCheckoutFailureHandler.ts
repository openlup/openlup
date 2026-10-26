import { createCheckoutFailureHandler } from "@openlup/platform/commerce/server";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { respondToPromotionCodePriceChange, respondQuoteFailure } from "./commerceCheckoutPromotionPriceChange.js";
import { CheckoutProviderAttemptFailure, logCheckoutProviderAttemptFailure } from "./commerceProviderAttemptFailure.js";
import { previewCheckoutDiagnosticsEnabled } from "./commerceDiagnostics.js";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type { ConfiguratorIntentPersistenceResponse } from "../../../src/domains/commerce/configuratorIntentPersistenceContracts.js";
import type { CreateQuoteRequest, CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
export const { respondToCheckoutFailure } = createCheckoutFailureHandler<ConfiguratorIntent, ConfiguratorIntentPersistenceResponse, CreateQuoteRequest, CreateQuoteResponse>({ responder: { sendBffError, sendBffSuccess, sendMethodNotAllowed }, respondToPromotionCodePriceChange, respondQuoteFailure, previewDiagnosticsEnabled: previewCheckoutDiagnosticsEnabled,
  logProviderFailure: (error) => { if (error instanceof CheckoutProviderAttemptFailure) logCheckoutProviderAttemptFailure(error); } });
