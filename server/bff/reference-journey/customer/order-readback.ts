import { sendBffError } from "../../../_lib/bff/response.js";
import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { HttpRequest, HttpResponse } from "../../../_lib/types/http.js";
import { localReferenceDemoProfileEnabled } from "../../../adapters/localReferenceStoreAdapter.js";
import { referenceJourneyOrderReadbackAdapter } from "../../../adapters/referenceJourneyOrderReadbackAdapter.js";
import { createReferenceJourneyCustomerReadbackHandler } from "../../../domains/commerce/referenceJourneyReadbackHandlers.js";
import { createCustomerReferenceReadComposition, customerSelfServiceEnabled } from "../../customers/shared.js";

export async function customerReferenceJourneyOrderReadbackHandler(req: HttpRequest, res: HttpResponse): Promise<void> {
  if (!localReferenceDemoProfileEnabled(process.env)) return sendBffError(res, "NOT_FOUND", "Reference order readback is unavailable");
  if (!customerSelfServiceEnabled()) return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer self-service is disabled", { details: { feature: "customer_self_service", reason: "feature_flag_disabled" } });
  const composition = createCustomerReferenceReadComposition(req);
  if (!composition) return sendBffError(res, "INTERNAL", "Customer data environment is not configured");
  return createReferenceJourneyCustomerReadbackHandler({
    ...composition,
    readback: referenceJourneyOrderReadbackAdapter,
  })(req, res);
}

export default withObservedRoute({ route: "/api/bff/reference-journey/customer/order-readback", domain: "commerce", surface: "customer", risk: "read", featureFlags: [] }, customerReferenceJourneyOrderReadbackHandler);
