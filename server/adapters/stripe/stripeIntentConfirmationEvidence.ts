import type { StripeIntentLike } from "./stripeSandboxPaymentExecutionAdapter.js";

/**
 * `requires_payment_method` on an intent that was never confirmed: no payment
 * method attached, no charge, no payment error. The provider object exists —
 * the request reached the provider and was accepted — but the payer never
 * submitted an instrument, so no issuer was ever asked to approve anything.
 *
 * Both absences beside the status are load-bearing. A payment method attached
 * but not yet confirmed means a charge may be seconds from moving; a charge or a
 * payment error means an issuer HAS been asked and answered. Either presence
 * makes this claim false, and the claim is used to decide what a durable row
 * says about the payer's money, so it must stay narrow rather than convenient.
 *
 * Shared deliberately. The execution rail asserts it to record what a fresh
 * intent is, and the reconciliation rail asserts it to answer a payer who is
 * still standing in the checkout. Those are two readings of ONE provider state,
 * and two copies of the predicate would let them drift into disagreeing about
 * whether the same intent had been attempted — the kind of drift that is only
 * discovered by a payer being told the wrong thing about their own payment.
 *
 * ⛔ Not to be widened into "the payer has gone" (abandonment). That is a
 * separate verdict, passed on a payer who is no longer present, and it
 * deliberately asserts fewer absences so a real refusal is never mislabelled as
 * abandonment. Merging the two would put one predicate under two opposite
 * pressures: this one must stay narrow so no live charge is called idle, that
 * one must stay broad so no refusal is silently dropped out of dunning.
 */
export function noIssuerWasAsked(intent: StripeIntentLike): boolean {
  return intent.status === "requires_payment_method"
    && !intent.payment_method
    && !intent.latest_charge
    && !intent.last_payment_error;
}
