// Drives a real Stripe sandbox PaymentIntent to success so the checkout reaches
// `order.paid` (W4). The stripe checkout path returns status `processing` +
// `webhookExpected`; confirming the PI with the `pm_card_visa` test method triggers
// Stripe's `payment_intent.succeeded` webhook, which is what advances our order to paid.
// Test-mode only — guarded by the preflight (sk_test_ key + sandbox flags).

const STRIPE_API = "https://api.stripe.com/v1/payment_intents";

export interface StripeConfirmRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

// Pure request builder (form-encoded, as Stripe's REST API expects). The default test
// payment method `pm_card_visa` is a Stripe-hosted token — no raw PAN ever touches us.
export function buildStripeConfirmRequest(args: {
  paymentIntentId: string;
  secretKey: string;
  paymentMethod?: string;
}): StripeConfirmRequest {
  const params = new URLSearchParams();
  params.set("payment_method", args.paymentMethod ?? "pm_card_visa");
  return {
    url: `${STRIPE_API}/${encodeURIComponent(args.paymentIntentId)}/confirm`,
    headers: {
      authorization: `Bearer ${args.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  };
}

export interface StripeConfirmResult {
  status: number;
  paymentIntentStatus: string | null;
  body: Record<string, unknown>;
}

export async function confirmStripePaymentIntent(args: {
  paymentIntentId: string;
  secretKey: string;
  paymentMethod?: string;
  fetchImpl?: typeof fetch;
}): Promise<StripeConfirmResult> {
  const doFetch = args.fetchImpl ?? fetch;
  const retrieve = await doFetch(`${STRIPE_API}/${encodeURIComponent(args.paymentIntentId)}`, {
    headers: { authorization: `Bearer ${args.secretKey}` },
  });
  const retrievedBody = (await retrieve.json().catch(() => ({}))) as Record<string, unknown>;
  if (!retrieve.ok || retrievedBody.status === "succeeded") {
    return {
      status: retrieve.status,
      paymentIntentStatus: typeof retrievedBody.status === "string" ? retrievedBody.status : null,
      body: retrievedBody,
    };
  }
  const request = buildStripeConfirmRequest(args);
  const res = await doFetch(request.url, { method: "POST", headers: request.headers, body: request.body });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    status: res.status,
    paymentIntentStatus: typeof body.status === "string" ? body.status : null,
    body,
  };
}
