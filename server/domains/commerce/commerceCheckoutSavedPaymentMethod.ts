import type { VercelRequest } from "../../_lib/types/vercel.js";
import type { CheckoutPaymentExecution } from "../../../src/domains/commerce/paymentExecutionContracts.js";
import type { CheckoutSavedPaymentMethodResolverPort } from "./savedPaymentMethodResolverPort.js";

interface ResolveSavedTpayMethodInput {
  req: VercelRequest;
  paymentExecution: CheckoutPaymentExecution | undefined;
  clientId: string;
  savedPaymentMethodResolverPort?: CheckoutSavedPaymentMethodResolverPort;
  now: () => Date;
  recordStage: <T>(stage: "payment_method_ref", operation: () => Promise<T>) => Promise<T>;
}

export type ResolveSavedTpayMethodResult =
  | { kind: "none" }
  | {
      kind: "resolved";
      paymentMethodRef: string;
      paymentMethodAliasType: "UID" | "PAYID";
      paymentMethodRecurringModel?: "O" | "M";
    }
  | {
      kind: "rejected";
      reason:
        | "saved_payment_method_resolver_unavailable"
        | "saved_payment_method_session_required"
        | "saved_payment_method_unavailable"
        | "saved_payment_method_read_failed";
    };

export async function resolveSavedTpayPaymentMethodForCheckout({
  req,
  paymentExecution,
  clientId,
  savedPaymentMethodResolverPort,
  now,
  recordStage,
}: ResolveSavedTpayMethodInput): Promise<ResolveSavedTpayMethodResult> {
  const savedPaymentMethodRequest = savedTpayMethodRequest(paymentExecution);
  if (!savedPaymentMethodRequest) return { kind: "none" };
  if (!savedPaymentMethodResolverPort) {
    return { kind: "rejected", reason: "saved_payment_method_resolver_unavailable" };
  }

  const accessToken = readBearerToken(req);
  if (!accessToken) {
    return { kind: "rejected", reason: "saved_payment_method_session_required" };
  }

  try {
    const resolved = await recordStage("payment_method_ref", () =>
      savedPaymentMethodResolverPort.resolveSavedPaymentMethod({
        accessToken,
        clientId,
        savedMethodId: savedPaymentMethodRequest.savedMethodId,
        requestedFlow: savedPaymentMethodRequest.flow,
        now: now(),
      }),
    );
    if (!resolved) {
      return { kind: "rejected", reason: "saved_payment_method_unavailable" };
    }
    return {
      kind: "resolved",
      paymentMethodRef: resolved.providerMethodRef,
      paymentMethodAliasType: resolved.providerAliasType,
      ...(resolved.recurringModel
        ? { paymentMethodRecurringModel: resolved.recurringModel }
        : {}),
    };
  } catch {
    return { kind: "rejected", reason: "saved_payment_method_read_failed" };
  }
}

function savedTpayMethodRequest(
  paymentExecution: CheckoutPaymentExecution | undefined,
): { flow: "blik_one_click" | "blik_recurring_saved"; savedMethodId: string } | null {
  if (paymentExecution?.provider !== "tpay") return null;
  if (
    paymentExecution.flow === "blik_one_click" ||
    paymentExecution.flow === "blik_recurring_saved"
  ) {
    return { flow: paymentExecution.flow, savedMethodId: paymentExecution.savedMethodId };
  }
  return null;
}

function readBearerToken(req: VercelRequest): string | null {
  const raw = req.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}
