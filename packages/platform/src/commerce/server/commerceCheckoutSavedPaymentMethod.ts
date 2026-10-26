import type { HttpRequest } from "../../http/index.js";
interface CheckoutSavedPaymentMethodResolverPort<Flow extends string, MethodKind extends string = string, RecurringModel extends string = string> {
  resolveSavedPaymentMethod(input: { accessToken: string; clientId: string; savedMethodId: string; requestedFlow: Flow; now: Date }): Promise<{ providerMethodRef: string; providerAliasType: MethodKind; recurringModel?: RecurringModel } | null>;
}
export type ResolveSavedMethodResult<MethodKind extends string = string, RecurringModel extends string = string> =
  | { kind: "none" }
  | {
      kind: "resolved";
      paymentMethodRef: string;
      paymentMethodAliasType: MethodKind;
      paymentMethodRecurringModel?: RecurringModel;
    }
  | {
      kind: "rejected";
      reason:
        | "saved_payment_method_resolver_unavailable"
        | "saved_payment_method_session_required"
        | "saved_payment_method_unavailable"
        | "saved_payment_method_read_failed";
    };

export function createCheckoutSavedPaymentMethodResolver<Execution, Flow extends string, MethodKind extends string = string, RecurringModel extends string = string>(requestForExecution: (execution: Execution | undefined) => { flow: Flow; savedMethodId: string } | null) {
type ResolveSavedMethodInput = {
  req: HttpRequest;
  paymentExecution: Execution | undefined;
  clientId: string;
  savedPaymentMethodResolverPort?: CheckoutSavedPaymentMethodResolverPort<Flow, MethodKind, RecurringModel>;
  now: () => Date;
  recordStage: <T>(stage: "payment_method_ref", operation: () => Promise<T>) => Promise<T>;
}

async function resolveSavedPaymentMethodForCheckout({
  req,
  paymentExecution,
  clientId,
  savedPaymentMethodResolverPort,
  now,
  recordStage,
}: ResolveSavedMethodInput): Promise<ResolveSavedMethodResult<MethodKind, RecurringModel>> {
  const savedPaymentMethodRequest = requestForExecution(paymentExecution);
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

function readBearerToken(req: HttpRequest): string | null {
  const raw = req.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

return { resolveSavedPaymentMethodForCheckout };
}
