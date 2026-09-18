import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  formatStockNotifyRateLimitMessage,
  type StockNotifyRateLimitPort,
} from "../../_lib/rate-limit/stockNotifyRateLimit.js";
import {
  STOCK_NOTIFY_CONTRACT_VERSION,
  stockNotifyRequestSchema,
} from "../../../src/domains/commerce/stockNotifyContracts.js";
import type { StockNotifySubscribePort } from "./stockNotifySubscribePort.js";

export interface StockNotifyHandlerDeps {
  subscribePort: StockNotifySubscribePort;
  rateLimitPort?: StockNotifyRateLimitPort;
}

export function createStockNotifyHandler({ rateLimitPort, subscribePort }: StockNotifyHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const request = stockNotifyRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid stock notification request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      if (rateLimitPort) {
        const rateLimit = await rateLimitPort.check({
          headers: req.headers,
          email: request.data.email,
          sku: request.data.sku,
        });
        if (!rateLimit.allowed) {
          sendBffError(res, "RATE_LIMITED", formatStockNotifyRateLimitMessage(rateLimit.reason), {
            details: {
              reason: rateLimit.reason,
              attemptsByIp: rateLimit.attemptsByIp,
              attemptsByEmailSku: rateLimit.attemptsByEmailSku,
            },
          });
          return;
        }
      }

      await subscribePort.subscribe({
        sku: request.data.sku,
        email: request.data.email,
      });
      sendBffSuccess(
        res,
        { contractVersion: STOCK_NOTIFY_CONTRACT_VERSION, subscribed: true },
        { contractVersion: STOCK_NOTIFY_CONTRACT_VERSION },
      );
    } catch {
      // Never leak the upstream error shape to an anonymous caller.
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Stock notification subscribe failed");
    }
  };
}
