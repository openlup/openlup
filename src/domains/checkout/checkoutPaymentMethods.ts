/**
 * The closed set of payment methods a buyer can choose at checkout.
 *
 * This is a platform contract, and it is here because two surfaces need it and
 * neither owns it: the customer account (payment recovery, "finish paying") and
 * the storefront's own package composer. Until this module existed the union was
 * declared inside the composer's form store, so the account could not name a
 * payment method without importing a storefront implementation module — the
 * exact inversion the split measures as debt.
 *
 * The values are scheme/wallet kinds, deliberately processor-free. *Which*
 * integration settles a given method, and whether it is offered at all, is a
 * configuration decision owned by the deployment that wires the adapters up; it
 * must never be readable from this contract.
 */

/**
 * Every method the platform recognises, in no particular order — display order
 * is a storefront decision, not a contract one.
 */
export const CHECKOUT_PAYMENT_METHODS = [
  "blik",
  "blik_one_click",
  "card",
  "transfer",
] as const;

/** A payment method a buyer can pick at checkout. */
export type PaymentMethod = (typeof CHECKOUT_PAYMENT_METHODS)[number];
