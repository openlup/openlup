import { sendBffError } from "../../../_lib/bff/response.js";
import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { HttpRequest, HttpResponse } from "../../../_lib/types/http.js";
import { localReferenceDemoProfileEnabled } from "../../../adapters/localReferenceStoreAdapter.js";
import { referenceJourneyOrderReadbackAdapter } from "../../../adapters/referenceJourneyOrderReadbackAdapter.js";
import { createReferenceJourneyOperatorReadbackHandler } from "../../../domains/commerce/referenceJourneyReadbackHandlers.js";
import { createCommerceAdminReferenceReadComposition } from "../../admin/commerce/shared.js";

export async function operatorReferenceJourneyOrderReadbackHandler(req: HttpRequest, res: HttpResponse): Promise<void> {
  if (!localReferenceDemoProfileEnabled(process.env)) return sendBffError(res, "NOT_FOUND", "Reference order readback is unavailable");
  return createReferenceJourneyOperatorReadbackHandler({
    ...createCommerceAdminReferenceReadComposition(req),
    readback: referenceJourneyOrderReadbackAdapter,
  })(req, res);
}

export default withObservedRoute({ route: "/api/bff/reference-journey/operator/order-readback", domain: "commerce", surface: "admin", risk: "read", featureFlags: [] }, operatorReferenceJourneyOrderReadbackHandler);
