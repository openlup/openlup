import { withObservedRoute } from "../../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { createAdminPromotionCodePreviewHandler } from "../../../../domains/commerce/adminPromotionCodesHandler.js";
import { authorizeCommerceAdminWithUser } from "../shared.js";
import { composeAdminPromotionCodes } from "./_compose.js";

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const context = composeAdminPromotionCodes(req, res, { requirePreviewSecret: true });
  if (!context) return Promise.resolve();
  return createAdminPromotionCodePreviewHandler({
    authorizeAdmin: () => authorizeCommerceAdminWithUser(context.authClient, context.accessToken),
    previewSecret: context.previewSecret,
  })(req, res);
}

export default withObservedRoute({
  route: "/api/bff/admin/commerce/promotion-codes/preview",
  domain: "commerce", surface: "admin", risk: "read",
}, handler);
