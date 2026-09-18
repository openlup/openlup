import { z } from "zod";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import type {
  PaymentProviderReconciliationProvider,
  PaymentProviderReconciliationPort,
} from "./paymentProviderReconciliationContracts.js";
import {
  verifyPaymentAttemptNow,
  type PaymentVerifyReadPort,
  type VerifiableAttemptSnapshot,
} from "./paymentVerifyNowService.js";

/**
 * Buyer-triggered "verify now": after a CLIENT-side confirm failure the FE has
 * the only copy of the outcome (a pre-charge provider rejection emits no
 * webhook), so it asks the server to read the provider immediately instead of
 * waiting for the next adopter-configured reconciliation pass. The client can never assert a result — truth is the live
 * provider readback, and the only write path is the reconciliation apply RPC
 * with the cron's own idempotency key, so both paths converge replay-safely.
 */

export const paymentVerifyRequestSchema = z.object({
  orderId: z.guid(),
  paymentIntentId: z.guid(),
  clientId: z.guid(),
});

export type PaymentVerifyRequest = z.infer<typeof paymentVerifyRequestSchema>;

export type { PaymentVerifyReadPort, VerifiableAttemptSnapshot } from "./paymentVerifyNowService.js";

export function createCommercePaymentVerifyHandler(deps: {
  readPort: PaymentVerifyReadPort;
  applyPort: Pick<PaymentProviderReconciliationPort, "applyTerminalResult">;
  providers: Partial<Record<string, PaymentProviderReconciliationProvider>>;
  mutationsEnabled: () => boolean;
  now?: () => Date;
}): (req: VercelRequest, res: VercelResponse) => Promise<void> {
  const now = deps.now ?? (() => new Date());
  return async (req, res) => {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }
    if (!deps.mutationsEnabled()) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Provider payment verify is disabled", {
        details: {
          feature: "payment-verify",
          featureFlag: "COMMERCE_PROVIDER_PAYMENTS_ENABLED",
          reason: "feature_flag_disabled",
        },
      });
      return;
    }

    const parsed = paymentVerifyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid payment verify request", {
        details: parsed.error.flatten(),
      });
      return;
    }

    const snapshot = await deps.readPort.readVerifiableAttempt(parsed.data);
    if (!snapshot) {
      sendBffError(res, "NOT_FOUND", "Payment not found");
      return;
    }
    // Same non-leaking ownership shape as payment-status: a non-owning triple
    // reads as absent rather than confirming the payment exists.
    if (snapshot.orderClientId !== parsed.data.clientId) {
      sendBffError(res, "NOT_FOUND", "Payment not found");
      return;
    }

    const result = await verifyPaymentAttemptNow({
      snapshot,
      applyPort: deps.applyPort,
      providers: deps.providers,
      now,
      // This route has exactly one kind of caller: a browser sitting in a live
      // checkout, asking about the attempt it is currently waiting on. The
      // reconciliation worker never comes through here — it holds the provider
      // and calls `readPayment` itself — so the purpose is a property of the
      // seam, not something a request may choose.
      purpose: "active_checkout",
    });
    sendBffSuccess(res, {
      status: result.status,
      verified: result.verified,
      applied: result.applied,
    });
  };
}
