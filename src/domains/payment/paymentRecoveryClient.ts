import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  paymentRecoveryRedeemResponseSchema,
  paymentRecoverySetupMethodResponseSchema,
  type PaymentRecoveryRedeemRequest,
  type PaymentRecoveryRedeemResponse,
  type PaymentRecoverySetupMethodRequest,
  type PaymentRecoverySetupMethodResponse,
} from "./contracts";

const REDEEM_PATH = "/api/bff/customers/payment-recovery/redeem";
const SETUP_METHOD_PATH = "/api/bff/customers/payment-recovery/setup-method";

/**
 * One key per request attempt. A refused redeem rolls its ledger row back, so a
 * re-submission must not reuse the key that row was written under.
 */
export function createRecoveryIdempotencyKey(scope: "setup" | "redeem"): string {
  const value =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `payment-recovery:${scope}:${value}`;
}

export function redeemPaymentRecovery(
  accessToken: string,
  body: PaymentRecoveryRedeemRequest,
  options: BffRequestOptions = {},
): Promise<PaymentRecoveryRedeemResponse> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  return requestBff(REDEEM_PATH, paymentRecoveryRedeemResponseSchema, {
    ...options,
    method: "POST",
    headers,
    body,
  });
}

export function startPaymentRecoverySetup(
  accessToken: string,
  body: PaymentRecoverySetupMethodRequest,
  options: BffRequestOptions = {},
): Promise<PaymentRecoverySetupMethodResponse> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  return requestBff(SETUP_METHOD_PATH, paymentRecoverySetupMethodResponseSchema, {
    ...options,
    method: "POST",
    headers,
    body,
  });
}
