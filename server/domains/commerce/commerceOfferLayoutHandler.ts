import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  COMMERCE_OFFER_LAYOUT_CONTRACT_VERSION,
  configuratorOfferLayoutResponseSchema,
  type ConfiguratorOfferLayout,
} from "../../../src/domains/commerce/offerLayoutContracts.js";

/**
 * The stored layout is a merchandising decision that changes rarely and carries no
 * money, so it tolerates a short shared-cache TTL plus a stale window: an operator
 * UPDATE becomes visible within a minute without every configurator view paying a
 * DB read. Browsers still revalidate (`max-age=0`).
 */
export const COMMERCE_OFFER_LAYOUT_CACHE_CONTROL =
  "public, max-age=0, s-maxage=30, stale-while-revalidate=60";

export interface CommerceOfferLayoutHandlerDeps {
  readConfiguratorOfferLayout(): Promise<ConfiguratorOfferLayout>;
}

export function createCommerceOfferLayoutHandler({
  readConfiguratorOfferLayout,
}: CommerceOfferLayoutHandlerDeps) {
  return async function handler(
    req: VercelRequest,
    res: VercelResponse,
  ): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    try {
      const parsed = configuratorOfferLayoutResponseSchema.safeParse({
        contractVersion: COMMERCE_OFFER_LAYOUT_CONTRACT_VERSION,
        layout: await readConfiguratorOfferLayout(),
      });
      if (!parsed.success) {
        sendBffError(
          res,
          "INVALID_RESPONSE",
          "Commerce offer layout returned invalid response",
        );
        return;
      }
      sendBffSuccess(
        res,
        parsed.data,
        { contractVersion: parsed.data.contractVersion },
        { cacheControl: COMMERCE_OFFER_LAYOUT_CACHE_CONTROL },
      );
    } catch {
      // Never guess a layout from a failed read: the client owns the fail-safe and
      // falls back to `DEFAULT_CONFIGURATOR_OFFER_LAYOUT`.
      sendBffError(
        res,
        "UPSTREAM_UNAVAILABLE",
        "Commerce offer layout is unavailable",
      );
    }
  };
}
