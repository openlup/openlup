import type { HttpRequest, HttpResponse } from "../http/index.js";
import type { BffResponder } from "../bff/index.js";
import type { AdminShippingRateHandlerDeps, ShippingRateHandlerSchemas } from "./shippingRatePorts.js";

export function createAdminShippingRateHandler({
  dataPort,
  authorizeAdmin,
  resolveAdmin,
}: AdminShippingRateHandlerDeps, schemas: ShippingRateHandlerSchemas, responder: BffResponder) {
  const { adminShippingRateResponseSchema, adminSetShippingRateRequestSchema, adminSetShippingRateResponseSchema, contractVersion: COMMERCE_CONTRACT_VERSION } = schemas;
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = responder;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
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
