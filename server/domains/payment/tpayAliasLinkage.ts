import type { NormalizedProviderPaymentWebhook } from "./paymentWebhookHandlers.js";

export function isActiveTpayBlikAliasEvent(event: NormalizedProviderPaymentWebhook): boolean {
  if (event.reusableMethod?.methodKind === "blik_payid" && event.reusableMethod.status === "active") {
    return true;
  }
  if (event.eventType !== "setup.succeeded") return false;
  const eventKind = event.rawPayload.eventKind;
  return eventKind === "blik_alias" || eventKind === "payid_alias";
}

export function tpayProviderMethodRef(event: NormalizedProviderPaymentWebhook): string | null {
  const fromMethod = event.reusableMethod?.providerMethodRef;
  if (fromMethod) return fromMethod;
  return paymentIntentIdFromAlias(event.providerPaymentId) ? event.providerPaymentId : null;
}

export function paymentIntentIdFromAlias(value: string): string | null {
  const match = /^openlup_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(value);
  return match ? match[1].toLowerCase() : null;
}
