import type { CheckoutKind } from "../../../src/domains/commerce/checkoutContracts.js";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import { commerceOfferEvidenceSchema } from "../../../src/domains/commerce/offerVersionContracts.js";

/** The refusal of an intent that carries an offer field when no adopter port is wired. */
export const CHECKOUT_OFFER_VERSION_UNSUPPORTED = "offer_version_unsupported";

export type CheckoutOfferResolution =
  | { kind: "bound"; offerVersion: string }
  | { kind: "refused"; reason: string };

/**
 * An adopter's offer policy at checkout. Core consults it only for an intent
 * that carries `offerVersion` or `minimumUnits`, and never interprets the
 * version: the port binds it or refuses the checkout with a reason.
 */
export interface CheckoutOfferPolicyPort {
  resolve(input: { intent: ConfiguratorIntent; checkoutKind: CheckoutKind }): Promise<CheckoutOfferResolution>;
  /** The adopter's record of the binding, stored as `quote.context.offerEvidence`. */
  evidence(input: {
    intent: ConfiguratorIntent;
    offerVersion: string;
    quote: CreateQuoteResponse["quote"];
  }): Promise<Record<string, unknown>>;
}

export class CheckoutOfferRefusedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`checkout_offer_refused:${reason}`);
    this.name = "CheckoutOfferRefusedError";
    this.reason = reason;
  }
}

export type CheckoutOfferBinding = { port: CheckoutOfferPolicyPort; offerVersion: string };

/**
 * Null, without a port call, for an intent that carries neither `offerVersion`
 * nor `minimumUnits`. Otherwise the adopter's port must bind the offer: without
 * a port the intent is refused with `offer_version_unsupported`, and a port
 * refusal keeps its own reason. Both throw `CheckoutOfferRefusedError`.
 */
export async function resolveCheckoutOffer(
  port: CheckoutOfferPolicyPort | undefined,
  intent: ConfiguratorIntent,
  checkoutKind: CheckoutKind,
): Promise<CheckoutOfferBinding | null> {
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
export async function withCheckoutOfferContext(
  binding: CheckoutOfferBinding | null,
  intent: ConfiguratorIntent,
  snapshot: CreateQuoteResponse,
): Promise<CreateQuoteResponse> {
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
