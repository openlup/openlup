import { createHmac, timingSafeEqual } from "node:crypto";
import type { VercelRequest } from "../../_lib/types/vercel.js";

export function verifyStripeWebhookSignature(input: {
  payload: string;
  signatureHeader: string | undefined;
  secret: string;
}): boolean {
  const timestamp = input.signatureHeader?.match(/(?:^|,)t=([^,]+)/)?.[1];
  const signature = input.signatureHeader?.match(/(?:^|,)v1=([^,]+)/)?.[1];
  if (!timestamp || !signature || !input.secret) return false;
  const expected = createHmac("sha256", input.secret)
    .update(`${timestamp}.${input.payload}`)
    .digest("hex");
  return safeEqual(signature, expected);
}

export async function normalizeStripePaymentWebhook(req: VercelRequest, secret: string) {
  const payload = JSON.stringify(req.body ?? {});
  const signatureHeader = firstHeader(req.headers["stripe-signature"]);
  if (!verifyStripeWebhookSignature({ payload, signatureHeader, secret })) {
    throw new Error("invalid_stripe_signature");
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const data = (body.data as Record<string, unknown> | undefined)?.object as Record<string, unknown> | undefined;
  return {
    provider: "stripe" as const,
    providerEventId: String(body.id ?? ""),
    eventType: mapStripeEventType(String(body.type ?? "")),
    providerPaymentId: String(data?.id ?? ""),
    paymentIntentId: typeof data?.metadata === "object" ? String((data.metadata as Record<string, unknown>).paymentIntentId ?? "") || null : null,
    amountMinor: typeof data?.amount === "number" ? data.amount : null,
    currency: typeof data?.currency === "string" ? data.currency.toUpperCase() : null,
    occurredAt: new Date(Number(body.created ?? Date.now() / 1000) * 1000).toISOString(),
    rawPayload: body,
    reusableMethod: mapStripeReusableMethod(data),
  };
}

function mapStripeEventType(type: string) {
  if (type === "payment_intent.succeeded") return "payment.succeeded" as const;
  if (type === "payment_intent.payment_failed") return "payment.failed" as const;
  if (type === "payment_intent.requires_action") return "payment.requires_action" as const;
  throw new Error("unsupported_stripe_webhook");
}

function mapStripeReusableMethod(data: Record<string, unknown> | undefined) {
  const metadata = data?.metadata as Record<string, unknown> | undefined;
  const clientId = metadata?.clientId;
  const paymentMethod = data?.payment_method;
  if (typeof clientId !== "string" || typeof paymentMethod !== "string") return null;
  return {
    clientId,
    subscriptionId: typeof metadata?.subscriptionId === "string" ? metadata.subscriptionId : null,
    providerCustomerRef: typeof data?.customer === "string" ? data.customer : null,
    providerMethodRef: paymentMethod,
    methodKind: "card" as const,
    status: "active" as const,
    consentSnapshot: { source: "stripe.payment_intent.future_usage" },
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
