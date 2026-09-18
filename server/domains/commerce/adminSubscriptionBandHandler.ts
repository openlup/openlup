import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import {
  adminSubscriptionBandResponseSchema,
  type AdminSubscriptionBandEntry,
} from "../../../src/domains/commerce/adminPromotionsContracts.js";
import type { AdminPromotionsDataPort } from "./adminPromotionsDataPort.js";
import { resolveAdmin, type AuthorizeCommerceAdmin } from "./adminPromotionsHandler.js";
import { createLegacyCatalogMutationFenceHandler } from "./adminCatalogHandler.js";

/** Admin subscription-band handler: GET current per-SKU band, POST global percent. */

export interface AdminSubscriptionBandHandlerDeps {
  dataPort: AdminPromotionsDataPort;
  authorizeAdmin: AuthorizeCommerceAdmin;
}

export function createAdminSubscriptionBandHandler({
  dataPort,
  authorizeAdmin,
}: AdminSubscriptionBandHandlerDeps) {
  const mutationFence = createLegacyCatalogMutationFenceHandler(authorizeAdmin);

  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method === "POST") {
      await mutationFence(req, res);
      return;
    }
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET", "POST"]);
      return;
    }
    const authz = await resolveAdmin(authorizeAdmin, res);
    if (!authz) return;

    if (req.method === "GET") {
      try {
        const entries = await dataPort.listSubscriptionBand();
        const response = adminSubscriptionBandResponseSchema.safeParse({
          contractVersion: COMMERCE_CONTRACT_VERSION,
          currentPercent: uniformPercent(entries),
          entries,
        });
        if (!response.success) {
          sendBffError(res, "INVALID_RESPONSE", "Subscription band returned invalid response");
          return;
        }
        sendBffSuccess(res, response.data);
      } catch {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Subscription band read failed");
      }
      return;
    }

  };
}

/** Uniform band percent across SKUs, or null when they diverge / none exist. */
function uniformPercent(entries: AdminSubscriptionBandEntry[]): number | null {
  if (entries.length === 0) return null;
  const first = entries[0].percent;
  return entries.every((entry) => entry.percent === first) ? first : null;
}
