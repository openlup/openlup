import type { PaymentExecutionPort } from "../../../src/domains/payment/ports.js";
import type {
  PaymentExecutionProvider,
  PaymentExecutionResult,
} from "../../../src/domains/payment/types.js";

/**
 * No-op payment execution adapter (W11.0).
 *
 * Makes no external provider call. Returns hidden rehearsal attempt facts
 * (`providerCall:false`) while satisfying the wider PSP-ready execution
 * contract. Real PSP adapters (stripe/tpay, W11.7) implement the same
 * `PaymentExecutionPort` and return real session/method facts; they replace
 * this only inside `paymentAdapterRegistry`.
 */
export function createNoopPaymentExecutionAdapter(
  provider: PaymentExecutionProvider = "hidden_rehearsal",
): PaymentExecutionPort {
  return {
    async execute(input): Promise<PaymentExecutionResult> {
      return {
        provider,
        providerAttemptId: null,
        providerSessionId: null,
        attemptStatus: "processing",
        nextActionKind: null,
        requestPayload: {
          source: "commerce.runtime.hidden.v0",
          providerIdempotencyKey: input.providerIdempotencyKey,
          providerRequestFingerprint: input.providerRequestFingerprint,
        },
        responsePayload: { providerCall: false },
      };
    },
  };
}
