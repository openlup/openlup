import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { createPartnersAdminB2BInquiryListHandler } from "../../../domains/partners/adminB2BInquiryHandlers.js";
import {
  createAdminB2BInquiryPort,
  type AdminB2BInquiryDataClient,
} from "../../../adapters/supabase/adminB2BInquiryPort.js";
import { createAdminAuthClient } from "../../../_lib/admin-domain/auth.js";
import {
  authorizePartnersAdmin,
  readBearerToken,
  readSupabaseEnv,
} from "./shared.js";
import {
  createPartnerAcquisitionListHandler,
  isDirectPartnerAcquisitionBundle,
  isPartnerAcquisitionView,
} from "../../partners/partnerAcquisitionDirect.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (isDirectPartnerAcquisitionBundle()) {
    if (isPartnerAcquisitionView(req)) {
      return createPartnerAcquisitionListHandler()(req, res);
    }
    sendBffError(res, "NOT_FOUND", "Partner acquisition view unavailable");
    return;
  }
  const env = readSupabaseEnv();
  if (!env) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  const accessToken = readBearerToken(req);
  const client = createAdminAuthClient(env, accessToken);

  return createPartnersAdminB2BInquiryListHandler({
    inquiryPort: createAdminB2BInquiryPort(client as unknown as AdminB2BInquiryDataClient),
    authorizeAdmin: () => authorizePartnersAdmin(client, accessToken),
  })(req, res);
}

export default withObservedRoute({
  route: "/api/bff/admin/partners/b2b-inquiries",
  domain: "partners",
  surface: "admin",
  risk: "mutation",
}, handler);
