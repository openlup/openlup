import { stripeFailureEvidence, type StripeIntentLike } from "./stripeFailureEvidence.js";
type Reference = string | { id: string } | null;
interface StripeIntentShape {
 id: string; status: string; customer?: Reference; payment_method?: Reference; latest_charge?: Reference;
 client_secret?: string | null; next_action?: { type?: string | null } | null;
 amount?: number; amount_received?: number; currency?: string;
 last_payment_error?: { code?: string | null; message?: string | null; type?: string | null } | null;
}
export function mapStripeIntent(intent: StripeIntentShape, knownCardOnlyRequest = false, source: "execution" | "readback" = "readback"): StripeIntentLike {
  const customer = typeof intent.customer === "string" ? intent.customer : intent.customer?.id ?? null;
  const paymentMethod =
    typeof intent.payment_method === "string"
      ? intent.payment_method
      : intent.payment_method?.id ?? null;
  const latestCharge =
    typeof intent.latest_charge === "string"
      ? intent.latest_charge
      : intent.latest_charge?.id ?? null;
  const mapped: StripeIntentLike = {
    id: intent.id,
    status: intent.status,
    client_secret: intent.client_secret,
    customer,
    payment_method: paymentMethod,
    latest_charge: latestCharge,
    next_action: intent.next_action ? { type: intent.next_action.type ?? null } : null,
  };
  if (typeof intent.amount === "number") mapped.amount = intent.amount;
  if (typeof intent.amount_received === "number") mapped.amount_received = intent.amount_received;
  if (typeof intent.currency === "string") mapped.currency = intent.currency;
  if (intent.last_payment_error) {
    mapped.last_payment_error = {
      code: intent.last_payment_error.code ?? null,
      message: intent.last_payment_error.message ?? null,
      type: intent.last_payment_error.type ?? null,
    };
  }
  const evidence = stripeFailureEvidence(intent, { source, knownCardOnlyRequest });
  if (evidence) mapped.diagnosticFailureEvidence = evidence;
  return mapped;
}

export function mapSetupIntent(intent: StripeIntentShape): StripeIntentLike {
  const customer = typeof intent.customer === "string" ? intent.customer : intent.customer?.id ?? null;
  const paymentMethod =
    typeof intent.payment_method === "string"
      ? intent.payment_method
      : intent.payment_method?.id ?? null;
  return {
    id: intent.id,
    status: intent.status,
    client_secret: intent.client_secret,
    customer,
    payment_method: paymentMethod,
    latest_charge: null,
    next_action: intent.next_action ? { type: intent.next_action.type ?? null } : null,
  };
}
