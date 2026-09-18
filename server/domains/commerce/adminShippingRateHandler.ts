import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import {
  adminSetShippingRateRequestSchema,
  adminSetShippingRateResponseSchema,
  adminShippingRateResponseSchema,
} from "../../../src/domains/commerce/adminPromotionsContracts.js";
import type { AdminPromotionsDataPort } from "./adminPromotionsDataPort.js";
import { resolveAdmin, type AuthorizeCommerceAdmin } from "./adminPromotionsHandler.js";

/** Admin shipping-rate handler: GET the flat shipping rate, POST a new value. */

export interface AdminShippingRateHandlerDeps {
  dataPort: AdminPromotionsDataPort;
  authorizeAdmin: AuthorizeCommerceAdmin;
}

export function createAdminShippingRateHandler({
  dataPort,
  authorizeAdmin,
}: AdminShippingRateHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "POST") {
      sendMethodNotAllowed(res, ["GET", "POST"]);
      return;
    }
    const authz = await resolveAdmin(authorizeAdmin, res);
    if (!authz) return;

    if (req.method === "GET") {
      try {
        const shippingFlatMinor = await dataPort.getShippingFlatMinor();
        const response = adminShippingRateResponseSchema.safeParse({
          contractVersion: COMMERCE_CONTRACT_VERSION,
          shippingFlatMinor,
        });
        if (!response.success) {
          sendBffError(res, "INVALID_RESPONSE", "Shipping rate returned invalid response");
          return;
        }
        sendBffSuccess(res, response.data);
      } catch {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Shipping rate read failed");
      }
      return;
    }

    const parsed = adminSetShippingRateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid shipping rate request", {
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      await dataPort.setShippingFlatMinor(parsed.data.shippingFlatMinor);
      // Best-effort audit (never blocks the mutation result).
      await dataPort
        .recordPromotionAudit({
          actorId: authz.userId,
          actorEmail: null,
          action: "shipping_rate_change",
          promotionId: "shipping_flat_minor",
          newValue: { shippingFlatMinor: parsed.data.shippingFlatMinor },
        })
        .catch(() => undefined);
      const response = adminSetShippingRateResponseSchema.safeParse({
        contractVersion: COMMERCE_CONTRACT_VERSION,
        updated: true,
        shippingFlatMinor: parsed.data.shippingFlatMinor,
      });
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Shipping rate set returned invalid response");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Shipping rate set failed");
    }
  };
}
