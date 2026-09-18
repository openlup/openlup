import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  findRecoveryTokenEvidence,
  PaymentRecoveryRecordError,
  type CustomerRecoveryAuthenticationResult,
  type SubscriptionPaymentRecoveryPort as PaymentRecoveryPort,
} from "./paymentRecoveryPorts.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  PAYMENT_RECOVERY_CONTRACT_VERSION,
  paymentRecoveryRedeemRequestSchema,
  paymentRecoveryRedeemResponseSchema,
} from "../../../src/domains/payment/contracts.js";

export interface PaymentRecoveryHandlerDeps {
  enabled: () => boolean;
  authenticateCustomer: (req: VercelRequest) => Promise<CustomerRecoveryAuthenticationResult | { ok: false }>;
  recoveryPort: PaymentRecoveryPort;
  now?: () => Date;
}

export function createPaymentRecoveryRedeemHandler({
  enabled,
  authenticateCustomer,
  recoveryPort,
  now = () => new Date(),
}: PaymentRecoveryHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enabled()) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Payment recovery is disabled", {
        details: {
          feature: "payment-recovery",
          featureFlag: "COMMERCE_PSP_RECOVERY_ENABLED",
          reason: "feature_flag_disabled",
        },
      });
      return;
    }

    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const parsed = paymentRecoveryRedeemRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid payment recovery request", {
        details: parsed.error.flatten(),
      });
      return;
    }

    const auth = await authenticateCustomer(req);
    if (!auth.ok) {
      sendBffError(res, "UNAUTHORIZED", "Customer session required");
      return;
    }

    // SHA-256 token pre-check. Mirrors the RPC lookup
    // (`token_hash = encode(sha256(...))`); both layers must match.
    const evidence = await findRecoveryTokenEvidence(recoveryPort, parsed.data.recoveryToken);
    if (!evidence || evidence.revokedAt || new Date(evidence.expiresAt).getTime() <= now().getTime()) {
      sendBffError(res, "CONFLICT", "Payment recovery token is invalid", {
        details: { reason: "token_invalid_or_expired" },
      });
      return;
    }

    if (!evidence.authUserId || evidence.authUserId !== auth.userId) {
      sendBffError(res, "FORBIDDEN", "Payment recovery token does not belong to this customer");
      return;
    }
    // A `resume_subscription` token used to be refused here, mirroring the RPC's
    // own fail-closed guard: nothing downstream could resume an expired journey
    // without leaving the subscription active and permanently unchargeable. The
    // RPC resumes now, and a refusal at this layer would only hide it. The RPC
    // stays the authority on whether the resume is admissible -- a stored method
    // the renewal lane cannot use still raises, and arrives here as a CONFLICT
    // carrying its own reason.

    let recovery: Awaited<ReturnType<PaymentRecoveryPort["recordSubscriptionPaymentRecovery"]>>;
    try {
      recovery = await recoveryPort.recordSubscriptionPaymentRecovery(parsed.data);
    } catch (error) {
      if (error instanceof PaymentRecoveryRecordError) {
        sendBffError(res, "CONFLICT", error.message, { details: { reason: error.reason } });
        return;
      }
      throw error;
    }
    const response = paymentRecoveryRedeemResponseSchema.parse({
      contractVersion: PAYMENT_RECOVERY_CONTRACT_VERSION,
      recovery: recovery.subscriptionPaymentRecovery,
    });
    sendBffSuccess(res, response, { contractVersion: PAYMENT_RECOVERY_CONTRACT_VERSION });
  };
}

export { hashRecoveryToken } from "./paymentRecoveryPorts.js";
export { PaymentRecoveryRecordError } from "./paymentRecoveryPorts.js";
export type {
  CustomerRecoveryAuthenticationResult,
  SubscriptionPaymentRecoveryPort as PaymentRecoveryPort,
  SubscriptionRecoveryTokenEvidence as PaymentRecoveryTokenEvidence,
} from "./paymentRecoveryPorts.js";
