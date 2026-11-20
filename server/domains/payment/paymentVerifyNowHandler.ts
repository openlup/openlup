import {
  createCommercePaymentVerifyHandler as createPlatformCommercePaymentVerifyHandler,
  paymentVerifyRequestSchema,
  type PaymentVerifyRequest,
} from "@openlup/platform/payments";
import type {
  PaymentProviderReconciliationPort,
  PaymentProviderReconciliationProvider,
  PaymentVerifyReadPort,
  VerifiableAttemptSnapshot,
} from "@openlup/platform/payments/contracts";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { bffResponder } from "../../_lib/bff/response.js";

export { paymentVerifyRequestSchema };
export type { PaymentVerifyRequest, PaymentVerifyReadPort, VerifiableAttemptSnapshot };

export function createCommercePaymentVerifyHandler(deps: {
  readPort: PaymentVerifyReadPort;
  applyPort: Pick<PaymentProviderReconciliationPort, "applyTerminalResult" | "readCaptureReview">;
  providers: Partial<Record<string, PaymentProviderReconciliationProvider>>;
  mutationsEnabled: () => boolean;
  now?: () => Date;
}): (req: VercelRequest, res: VercelResponse) => Promise<void> {
  return createPlatformCommercePaymentVerifyHandler({
    ...deps,
    responder: bffResponder,
  }) as (req: VercelRequest, res: VercelResponse) => Promise<void>;
}
