/**
 * The markup anchor names a store's pages carry, for example
 * `data-openlup-action={storefrontAnchor.action.proceed_to_checkout}`.
 *
 * `attribute` holds the four attribute names. In `action` (buyer actions),
 * `state` (states a buyer sees) and `field` (buyer-detail fields) every value
 * equals its key. Groups and members are only added: a member is never renamed,
 * and a wrong one is superseded by a new member.
 *
 * @experimental
 */
export const storefrontAnchor = Object.freeze({
  attribute: Object.freeze({
    action: "data-openlup-action",
    state: "data-openlup-state",
    field: "data-openlup-field",
    value: "data-openlup-value",
  } as const),
  action: Object.freeze({
    proceed_to_checkout: "proceed_to_checkout",
    place_order: "place_order",
    continue_payment: "continue_payment",
    retry_payment: "retry_payment",
    start_over: "start_over",
  } as const),
  state: Object.freeze({
    awaiting_payment: "awaiting_payment",
    details_changed: "details_changed",
    awaiting_authority: "awaiting_authority",
    declined: "declined",
    paid: "paid",
    paid_pending_activation: "paid_pending_activation",
  } as const),
  field: Object.freeze({
    email: "email",
    first_name: "first_name",
    last_name: "last_name",
    phone: "phone",
    address_line1: "address_line1",
    address_line2: "address_line2",
    city: "city",
    postal_code: "postal_code",
    terms_accepted: "terms_accepted",
  } as const),
} as const);

/**
 * The type of `storefrontAnchor`.
 *
 * @experimental
 */
export type StorefrontAnchor = typeof storefrontAnchor;
