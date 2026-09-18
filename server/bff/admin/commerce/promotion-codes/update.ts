import { withObservedRoute } from "../../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { createAdminPromotionCodeUpdateHandler } from "../../../../domains/commerce/adminPromotionCodesHandler.js";
import {
  createSupabaseAdminPromotionCodesDataPort,
  type AdminPromotionCodesSupabaseClient,
} from "../../../../adapters/supabase/adminPromotionCodes.js";
import { authorizeCommerceAdminWithUser } from "../shared.js";
import { composeAdminPromotionCodes } from "./_compose.js";

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const context = composeAdminPromotionCodes(req, res, { requirePreviewSecret: true });
  if (!context) return Promise.resolve();
  return createAdminPromotionCodeUpdateHandler({
    dataPort: createSupabaseAdminPromotionCodesDataPort(
      context.serviceClient as unknown as AdminPromotionCodesSupabaseClient,
    ),
    authorizeAdmin: () => authorizeCommerceAdminWithUser(context.authClient, context.accessToken),
    previewSecret: context.previewSecret,
  })(req, res);
}

export default withObservedRoute({
  route: "/api/bff/admin/commerce/promotion-codes/update",
  domain: "commerce", surface: "admin", risk: "mutation",
}, handler);
