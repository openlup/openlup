import { createHmac, timingSafeEqual } from "node:crypto";
import type { VercelRequest } from "../../_lib/types/vercel.js";

export function verifyTpayWebhookSignature(input: {
  payload: string;
  signatureHeader: string | undefined;
  secret: string;
}): boolean {
  if (!input.signatureHeader || !input.secret) return false;
  const expected = createHmac("sha256", input.secret).update(input.payload).digest("hex");
  return safeEqual(input.signatureHeader, expected);
}

export async function normalizeTpayPaymentWebhook(req: VercelRequest, secret: string) {
  const payload = JSON.stringify(req.body ?? {});
  const signatureHeader = firstHeader(req.headers["x-tpay-signature"]);
  if (!verifyTpayWebhookSignature({ payload, signatureHeader, secret })) {
    throw new Error("invalid_tpay_signature");
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  return {
    provider: "tpay" as const,
    providerEventId: String(body.event_id ?? body.id ?? ""),
    eventType: mapTpayEventType(String(body.event_type ?? body.status ?? "")),
    providerPaymentId: String(body.transaction_id ?? body.payment_id ?? ""),
    paymentIntentId: typeof body.payment_intent_id === "string" ? body.payment_intent_id : null,
    amountMinor: typeof body.amount_minor === "number" ? body.amount_minor : null,
    currency: typeof body.currency === "string" ? body.currency : null,
    occurredAt: typeof body.occurred_at === "string" ? body.occurred_at : new Date().toISOString(),
    rawPayload: body,
    reusableMethod: mapTpayPayId(body),
  };
}

function mapTpayEventType(type: string) {
  if (type === "paid" || type === "payment.succeeded") return "payment.succeeded" as const;
  if (type === "failed" || type === "payment.failed") return "payment.failed" as const;
  if (type === "payid.active" || type === "setup.succeeded") return "setup.succeeded" as const;
  if (type === "payid.inactive" || type === "setup.failed") return "setup.failed" as const;
  throw new Error("unsupported_tpay_webhook");
}

function mapTpayPayId(body: Record<string, unknown>) {
  if (typeof body.client_id !== "string" || typeof body.payid !== "string") return null;
  return {
    clientId: body.client_id,
    subscriptionId: typeof body.subscription_id === "string" ? body.subscription_id : null,
    providerCustomerRef: typeof body.customer_ref === "string" ? body.customer_ref : null,
    providerMethodRef: body.payid,
    providerMandateRef: typeof body.alias_registration_id === "string" ? body.alias_registration_id : null,
    methodKind: "blik_payid" as const,
    status: body.payid_status === "inactive" ? ("inactive" as const) : ("active" as const),
    consentSnapshot: { source: "tpay.payid.webhook" },
  };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
