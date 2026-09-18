import { withObservedRoute } from "../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { createPartnersPublicB2BInquirySubmitHandler } from "../../domains/partners/publicB2BInquiryHandler.js";
import { createSupabasePartnersB2BInquirySubmitPort } from "../../adapters/supabase/partnersB2BInquirySubmitPort.js";
import {
  createPartnerAcquisitionSubmitHandler,
  isDirectPartnerAcquisitionBundle,
} from "./partnerAcquisitionDirect.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (isDirectPartnerAcquisitionBundle()) {
    return createPartnerAcquisitionSubmitHandler()(req, res);
  }
  return createPartnersPublicB2BInquirySubmitHandler({
    submitPort: createSupabasePartnersB2BInquirySubmitPort(),
  })(req, res);
}

export default withObservedRoute({
  route: "/api/bff/partners/b2b-inquiries",
  domain: "partners",
  surface: "public",
  risk: "validation_mutation",
}, handler);
