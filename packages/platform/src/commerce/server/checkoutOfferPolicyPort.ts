import type { CheckoutKind, CheckoutOfferPolicyPort } from "../contracts/index.js";
import { commerceOfferEvidenceSchema } from "../offerEvidenceSchemas.js";
export type { CheckoutOfferPolicyPort } from "../contracts/index.js";
/** The refusal of an intent that carries an offer field when no adopter port is wired. */
export const CHECKOUT_OFFER_VERSION_UNSUPPORTED = "offer_version_unsupported";

export class CheckoutOfferRefusedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`checkout_offer_refused:${reason}`);
    this.name = "CheckoutOfferRefusedError";
    this.reason = reason;
  }
}

export type CheckoutOfferBinding<Intent, Quote> = { port: CheckoutOfferPolicyPort<Intent, Quote>; offerVersion: string };

/**
 * Null, without a port call, for an intent that carries neither `offerVersion`
 * nor `minimumUnits`. Otherwise the adopter's port must bind the offer: without
 * a port the intent is refused with `offer_version_unsupported`, and a port
 * refusal keeps its own reason. Both throw `CheckoutOfferRefusedError`.
 */
export async function resolveCheckoutOffer<Intent extends { offerVersion?: string; minimumUnits?: number }, Quote>(
  port: CheckoutOfferPolicyPort<Intent, Quote> | undefined,
  intent: Intent,
  checkoutKind: CheckoutKind,
): Promise<CheckoutOfferBinding<Intent, Quote> | null> {
  if (intent.offerVersion === undefined && intent.minimumUnits === undefined) return null;
  if (!port) throw new CheckoutOfferRefusedError(CHECKOUT_OFFER_VERSION_UNSUPPORTED);
  const resolution = await port.resolve({ intent, checkoutKind });
  if (resolution.kind === "refused") throw new CheckoutOfferRefusedError(resolution.reason);
  return { port, offerVersion: resolution.offerVersion };
}

/**
 * Writes a bound offer version and the adopter's evidence, checked against
 * `commerceOfferEvidenceSchema`, into an accepted snapshot's context. Without a
 * binding the same snapshot is returned; a bound snapshot without a context
 * fails closed.
 */
export async function withCheckoutOfferContext<Intent, Quote extends { context?: object }, Response extends { quote: Quote }>(
  binding: CheckoutOfferBinding<Intent, Quote> | null,
  intent: Intent,
  snapshot: Response,
): Promise<Response> {
  if (!binding) return snapshot;
  const context = snapshot.quote.context;
  if (!context) throw new Error("checkout_offer_context_missing");
  const offerEvidence = commerceOfferEvidenceSchema.parse(await binding.port.evidence({
    intent,
    offerVersion: binding.offerVersion,
    quote: snapshot.quote,
  }));
  return {
    ...snapshot,
    quote: { ...snapshot.quote, context: { ...context, offerVersion: binding.offerVersion, offerEvidence } },
  };
}
