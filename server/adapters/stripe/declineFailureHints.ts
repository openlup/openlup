import type { PaymentFailureHint } from "@openlup/core/payment";

/**
 * This adapter's own translation from its opaque refusal codes to the neutral
 * hints the failure taxonomy accepts.
 *
 * The table lives here, in the adapter that owns the codes, and never in the
 * neutral kernel: the kernel classifies evidence, and this file is what turns
 * one acquirer's vocabulary into that evidence.
 *
 * It follows the published scheme research collected for the dunning programme.
 * The class these hints produce is DISPLAY-load-bearing: it reaches the payer as
 * the sentence explaining why the charge could not happen. It is still not a
 * cadence input (nothing in the retry ladder branches on it), so a wrong row
 * here costs a wrong sentence, not a wrong charge.
 *
 * Precedence note: this table is consulted only when the refusal carries NO
 * issuer advice code. Advice is the verdict of the party that would refuse the
 * next attempt, so it outranks anything read locally.
 *
 * Two deliberate silences, both from the research:
 *   - `do_not_honor` and `generic_decline` get NO entry. They are the issuer's
 *     way of declining without saying why, and they arrive on refusals that are
 *     dead and on refusals that clear on the next attempt alike. Guessing either
 *     way would invent a verdict; falling through to `indeterminate` is honest.
 *   - `restricted_card` IS mapped, to `credentialDead`, and the caveat is
 *     recorded rather than hidden: the research reads it as "this instrument may
 *     not be used for this transaction", which the payer's bank can lift, so the
 *     instrument is not necessarily finished. It is mapped anyway because every
 *     reading of it agrees that repeating the identical charge unattended cannot
 *     clear it, and that is the whole content of the class.
 *
 * The same caveat applies to `card_not_supported`, `currency_not_supported` and
 * `transaction_not_allowed`: the credential may be perfectly alive and the
 * refusal still final for the charge as submitted. `credentialDead` is chosen
 * for the CLASS it yields, not as a claim about the plastic.
 */
export const DECLINE_CODE_HINT_TABLE: Readonly<Record<string, readonly PaymentFailureHint[]>> = Object.freeze({
  approve_with_id: Object.freeze(["transient"] as const),
  authentication_required: Object.freeze(["authenticationRequired"] as const),
  card_not_supported: Object.freeze(["credentialDead"] as const),
  card_velocity_exceeded: Object.freeze(["limitExceeded"] as const),
  currency_not_supported: Object.freeze(["credentialDead"] as const),
  expired_card: Object.freeze(["credentialDead"] as const),
  fraudulent: Object.freeze(["credentialDead"] as const),
  highest_risk_level: Object.freeze(["credentialDead"] as const),
  incorrect_address: Object.freeze(["dataInvalid"] as const),
  incorrect_cvc: Object.freeze(["dataInvalid"] as const),
  incorrect_number: Object.freeze(["dataInvalid"] as const),
  incorrect_zip: Object.freeze(["dataInvalid"] as const),
  insufficient_funds: Object.freeze(["transient"] as const),
  invalid_account: Object.freeze(["credentialDead"] as const),
  invalid_amount: Object.freeze(["dataInvalid"] as const),
  invalid_cvc: Object.freeze(["dataInvalid"] as const),
  invalid_expiry_month: Object.freeze(["dataInvalid"] as const),
  invalid_expiry_year: Object.freeze(["dataInvalid"] as const),
  invalid_number: Object.freeze(["dataInvalid"] as const),
  issuer_not_available: Object.freeze(["transient"] as const),
  lost_card: Object.freeze(["credentialDead"] as const),
  merchant_blacklist: Object.freeze(["credentialDead"] as const),
  new_account_information_available: Object.freeze(["credentialDead"] as const),
  pickup_card: Object.freeze(["credentialDead"] as const),
  pin_try_exceeded: Object.freeze(["credentialDead"] as const),
  processing_error: Object.freeze(["transient"] as const),
  reenter_transaction: Object.freeze(["transient"] as const),
  restricted_card: Object.freeze(["credentialDead"] as const),
  revocation_of_all_authorizations: Object.freeze(["credentialDead"] as const),
  revocation_of_authorization: Object.freeze(["credentialDead"] as const),
  stolen_card: Object.freeze(["credentialDead"] as const),
  stop_payment_order: Object.freeze(["credentialDead"] as const),
  transaction_not_allowed: Object.freeze(["credentialDead"] as const),
  try_again_later: Object.freeze(["transient"] as const),
  withdrawal_count_limit_exceeded: Object.freeze(["limitExceeded"] as const),
});

/**
 * The hints this adapter asserts for one refusal code. Own-property lookup, so
 * an inherited key (`constructor`, `toString`) is not a mapping.
 *
 * The table itself is exported too, for a reader that holds a stored code and
 * has no adapter in the loop: the historical-corpus replay hands it straight to
 * the kernel's `declineCodeHints` option.
 */
export function declineCodeHints(declineCode: string | undefined): readonly PaymentFailureHint[] {
  if (declineCode === undefined) return [];
  return Object.prototype.hasOwnProperty.call(DECLINE_CODE_HINT_TABLE, declineCode)
    ? DECLINE_CODE_HINT_TABLE[declineCode]
    : [];
}
