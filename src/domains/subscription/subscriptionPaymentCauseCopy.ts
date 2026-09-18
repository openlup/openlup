// One sentence per payment cause, shared by every surface that has a cause to
// state — the failure notices, the expired notice, the pre-renewal at-risk
// warning, and the pages the customer lands on from any of them.
//
// It lives in one module because the alternative is what the customer saw
// before it: rails describing one problem in several vocabularies, some naming a
// cause and some naming none. A customer who reads the mail and then opens the
// page it linked must hear one voice, so the page quotes this table rather than
// restating it in an i18n bundle where the two would drift apart silently.
//
// It sits at the domain root rather than under `emails/` for exactly that
// reason: the sentences are what we tell a customer about a payment cause, not
// what one delivery channel happens to render.
//
// WHAT THESE SENTENCES MAY CLAIM. Each states what is true about the STORED
// METHOD or about what the issuer told us, and stops there. None of them says
// "your card was declined" unless a decline actually happened, and none names a
// scheme, a bank or a payment rail: the cause vocabulary is neutral by
// construction and the copy must not smuggle vendor identity back in. That
// neutrality is machine-enforced by the OSS readiness ratchet, which counts
// vendor vocabulary in this family — a brand name added here fails that gate, so
// no unit test re-implements the check.
//
// `unknown` deliberately has NO entry. A surface resolving `unknown` renders
// exactly what it rendered before this module existed — an absent fact drops its
// sentence and never prints a placeholder, the same discipline the amount and
// method lines in these templates already follow.

import type { PaymentFailureCustomerCause } from "@openlup/core/payment";
import type { Locale } from "../../lib/i18n/resolveLocale.js";

/** Every cause that earns a sentence. `unknown` is absent on purpose. */
export type StatedPaymentCause = Exclude<PaymentFailureCustomerCause, "unknown">;

const CAUSE_SENTENCES: Record<Locale, Record<StatedPaymentCause, string>> = {
  pl: {
    needs_confirmation:
      "Twój bank wymaga potwierdzenia tej płatności, a przy automatycznym odnowieniu nie ma Cię przy tym.",
    method_cannot_recur:
      "Zapisana metoda płatności nie pozwala nam obciążyć Cię automatycznie, bez Twojego udziału.",
    method_dead: "Bank trwale odrzucił tę metodę płatności.",
    method_data_invalid: "Dane zapisanej metody płatności wymagają poprawienia.",
    method_missing: "Nie mamy zapisanej metody płatności dla tej subskrypcji.",
  },
  en: {
    needs_confirmation:
      "Your bank wants this payment confirmed, and an automatic renewal happens without you there.",
    method_cannot_recur:
      "The payment method we have on file does not let us charge you automatically, without you present.",
    method_dead: "Your bank has permanently refused this payment method.",
    method_data_invalid: "The details of your stored payment method need correcting.",
    method_missing: "We have no payment method on file for this subscription.",
  },
};

/**
 * Every locale this table covers, derived from the table itself so an exhaustive
 * test cannot fall behind a locale the copy gained.
 */
export const CAUSE_COPY_LOCALES = Object.keys(CAUSE_SENTENCES) as Locale[];

/**
 * The sentence for a cause, or null when nothing may be claimed.
 *
 * Callers spread the result into their block list, so a null cause costs them
 * one `?? []` and never a branch on the vocabulary itself.
 */
export function subscriptionPaymentCauseSentence(
  locale: Locale,
  cause: PaymentFailureCustomerCause,
): string | null {
  return cause === "unknown" ? null : CAUSE_SENTENCES[locale][cause];
}
