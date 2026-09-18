import type { VercelRequest } from "../../_lib/types/vercel.js";
import type { CheckoutPaymentExecution } from "../../../src/domains/commerce/paymentExecutionContracts.js";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type {
  PaymentExecutionProvider,
  PaymentProviderFlow,
} from "../../../src/domains/payment/types.js";

export function providerFlowFor(
  paymentProvider: PaymentExecutionProvider,
  paymentExecution: CheckoutPaymentExecution | undefined,
): PaymentProviderFlow {
  if (paymentProvider === "tpay" && paymentExecution?.provider === "tpay") {
    if (paymentExecution.flow === "blik_recurring_saved") {
      return "recurring_charge";
    }
    return paymentExecution.flow;
  }
  return "one_time_payment";
}

export function checkoutClientAction(input: {
  provider: string;
  status: "paid" | "processing" | "failed";
  providerClientSecret: string | null;
  providerRedirectUrl: string | null;
}) {
  if (input.status !== "processing") return { kind: "none" as const };
  if (input.provider === "stripe") {
    return {
      kind: "provider_embedded" as const,
      provider: "stripe" as const,
      ...(input.providerClientSecret ? { clientSecret: input.providerClientSecret } : {}),
    };
  }
  if (input.provider === "tpay" && input.providerRedirectUrl) {
    return { kind: "redirect" as const, url: input.providerRedirectUrl };
  }
  return { kind: "none" as const };
}

export function providerPayerFromRequest(req: VercelRequest, intent: ConfiguratorIntent) {
  return {
    email: intent.contact.email,
    name: `${intent.contact.firstName} ${intent.contact.lastName}`.trim(),
    ip: firstHeader(req.headers["x-forwarded-for"])?.split(",")[0]?.trim() ??
      firstHeader(req.headers["x-real-ip"]) ??
      null,
    userAgent: firstHeader(req.headers["user-agent"]) ?? null,
  };
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const first = value.find((entry) => entry.trim());
    return first?.trim() ?? null;
  }
  return null;
}
