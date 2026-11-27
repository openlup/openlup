/**
 * One capability a selling store may need, and whether this installed version
 * of the package offers it.
 *
 * - `id` names the capability, never a gap (`^[a-z][a-z0-9_]*$`). It is never
 *   renamed; a wrong entry is superseded by a new id.
 * - `level` is `supported` or `unsupported` in this version. The set is open: a
 *   reader keeps a default branch for a level added later. Every entry states
 *   its level; there is no default.
 * - `statement` says what the capability is, in one sentence without a final
 *   period that stays true when `level` changes. Derive "not yet" wording from `level`, never from
 *   `statement`.
 * - `meanwhile` says what a store does while the capability is not supported;
 *   it is `null` exactly when `level` is `supported`.
 * - `closedBy` names who must act to make it supported.
 * - `appliesTo` is the neutral condition under which the capability matters for
 *   selling: an open-set `id` and a `text` that starts "Stores that" or "Stores
 *   whose". A store that does not meet the condition is not affected.
 *
 * @experimental
 */
export type StorefrontCapability = {
  readonly id: string;
  readonly level: "supported" | "unsupported" | (string & {});
  readonly statement: string;
  readonly meanwhile: string | null;
  readonly closedBy: "platform" | "provider_module" | "store" | (string & {});
  readonly appliesTo: { readonly id: string; readonly text: string };
};

// The one "not supported" token. Delivering a capability changes one line of its entry: `level` and `meanwhile`
// stay on the same line, and become `"supported", meanwhile: null` together.
const UNSUPPORTED = "unsupported";

const entry = (capability: StorefrontCapability): StorefrontCapability => Object.freeze({ ...capability, appliesTo: Object.freeze({ ...capability.appliesTo }) });

/**
 * The capabilities a selling store may need, each with its level in this
 * installed version, who closes it and the stores it affects. Frozen at every
 * depth.
 *
 * @experimental
 */
export const storefrontCapabilities: readonly StorefrontCapability[] = Object.freeze([
  entry({
    id: "mixed_purchase_modes_per_order",
    level: UNSUPPORTED, meanwhile: "Sell the subscription and the one-time product as separate orders.",
    statement: "One order holds a subscription and a one-time product",
    closedBy: "platform",
    appliesTo: { id: "mixed_purchase_modes", text: "Stores that sell a subscription and a one-time product in one order" },
  }),
  entry({
    id: "post_purchase_add_on",
    level: UNSUPPORTED, meanwhile: "Place the added items as a new order.",
    statement: "Items are added to an order after it is paid",
    closedBy: "platform",
    appliesTo: { id: "post_purchase_add_ons", text: "Stores that add items to an order after it is paid" },
  }),
  entry({
    id: "consent_and_disclosure_checked",
    level: UNSUPPORTED, meanwhile: "Check the consents and disclosures a purchase requires in the store's own tests.",
    statement: "The storefront scenarios check the consents and disclosures a purchase requires",
    closedBy: "platform",
    appliesTo: { id: "subscriptions", text: "Stores that sell subscriptions" },
  }),
  entry({
    id: "embedded_card_element",
    level: UNSUPPORTED, meanwhile: "Mount the provider's card element in the store's own page and confirm the client-confirmed handoff with it.",
    statement: "The package supplies the card entry element the checkout embeds",
    closedBy: "provider_module",
    appliesTo: { id: "takes_cards", text: "Stores that take cards" },
  }),
  entry({
    id: "storefront_payment_method_setup",
    level: UNSUPPORTED, meanwhile: "Start the setup with the server-side payment method setup and confirm its handoff in the store's own page.",
    statement: "The storefront confirms a payment method setup in the buyer's browser",
    closedBy: "provider_module",
    appliesTo: { id: "replaces_payment_methods", text: "Stores that replace a stored payment method" },
  }),
  entry({
    id: "destination_tax_at_checkout",
    level: UNSUPPORTED, meanwhile: "Sell at tax-inclusive prices, which the checkout quote already taxes.",
    statement: "Checkout issues orders with tax calculated for the buyer's destination on tax-exclusive prices",
    closedBy: "platform",
    appliesTo: { id: "adds_tax_at_checkout", text: "Stores that sell at tax-exclusive prices and add tax at checkout" },
  }),
  entry({
    id: "address_region",
    level: UNSUPPORTED, meanwhile: "Collect the region in a field of the store's own and send it as the subdivision of the experimental destination address.",
    statement: "The storefront's buyer fields include an address region",
    closedBy: "platform",
    appliesTo: { id: "addresses_need_region", text: "Stores whose addresses need a region" },
  }),
  entry({
    id: "recurring_consent_evidence",
    level: UNSUPPORTED, meanwhile: "Keep the buyer's acceptance, with the terms shown and its time, in the store's own records.",
    statement: "The buyer's acceptance of recurring payment terms at checkout is stored as evidence",
    closedBy: "platform",
    appliesTo: { id: "subscriptions", text: "Stores that sell subscriptions" },
  }),
  entry({
    id: "delegated_payment_credentials",
    level: UNSUPPORTED, meanwhile: "Let the buyer complete the payment.",
    statement: "An agent pays for a buyer with delegated payment credentials",
    closedBy: "platform",
    appliesTo: { id: "agent_payments", text: "Stores that let an agent pay for a buyer" },
  }),
  entry({
    id: "delegated_subscription_management",
    level: UNSUPPORTED, meanwhile: "Let the buyer manage the subscription.",
    statement: "An agent manages a buyer's subscription for them",
    closedBy: "platform",
    appliesTo: { id: "agent_subscription_management", text: "Stores that let an agent manage a buyer's subscription" },
  }),
  entry({
    id: "agent_completable_states",
    level: UNSUPPORTED, meanwhile: "Hand the purchase to the buyer for any step an agent cannot take.",
    statement: "An agent completes every purchase state without the buyer",
    closedBy: "platform",
    appliesTo: {
      id: "agent_purchases",
      text: "Stores whose purchases may need a buyer step an agent cannot take, such as a payment authentication challenge or activation pending",
    },
  }),
]);
