// The pre-send question the dunning dispatcher was never asking.
//
// Every other mail rail on this deployment passes a per-recipient consent read
// before it sends. Dunning did not: the dispatcher claimed a row, resolved a
// recipient, and handed it to the transport. The only thing that could stop it
// was the operator-wide template control, which is a switch for a WHOLE template,
// not an answer about THIS person. A customer who had explicitly asked this
// deployment to stop mailing them kept receiving dunning notices.
//
// WHY IT DEFAULTS TO SEND. Dunning is transactional: it is the message that
// tells a paying customer their money did not move and hands them the link that
// repairs it. Withholding it is not a privacy win, it is an unrecoverable
// subscription. So the gate refuses ONLY on an explicit, durable denial or
// suppression that a person (or an operator on their behalf) actually recorded.
// Absence of a permission row, an unreadable table, a thrown query — all of
// those answer ALLOW. That is the opposite of the marketing evaluator's
// fail-closed rule, and deliberately so: there, a wrong send is a violation;
// here, a wrong silence is a cancelled customer.
//
// WHY REFUSALS ARE DURABLE. Every refusal lands on the same `skipped` rail the
// template control already used, with a reason code, so a suppression is a row
// an operator can count — never a send that quietly did not happen.

import type { DunningCadenceConfig } from "./dunningCadenceConfig.js";

/**
 * Why a customer dunning notice was not sent. Neutral: none of these names a
 * transport, a table, or a vendor.
 */
export type DunningConsentRefusalCode =
  /** This recipient's recorded preference is denial or suppression. */
  | "consent_denied"
  /** An operator disabled this notice for everyone. */
  | "control_disabled"
  /** The deployment's cadence does not admit this notice kind at all. */
  | "cadence_not_allowed";

/**
 * The durable skip reason each refusal writes.
 *
 * `control_disabled` maps to the string the template control has always
 * persisted. Renaming it would silently re-baseline every historical row an
 * operator reads, so the gate adopts the existing word instead of imposing its
 * own — the vocabulary is new, the stored evidence is not.
 */
export const DUNNING_REFUSAL_SKIP_REASON: Readonly<Record<DunningConsentRefusalCode, string>> =
  Object.freeze({
    consent_denied: "consent_denied",
    control_disabled: "admin_disabled",
    cadence_not_allowed: "cadence_not_allowed",
  });

export function dunningRefusalSkipReason(code: DunningConsentRefusalCode): string {
  return DUNNING_REFUSAL_SKIP_REASON[code];
}

export interface DunningConsentRequest {
  /** The address the notice would go to. */
  recipientEmail: string;
  /** 'payment_failed' | 'payment_expired' — checked against the cadence. */
  notificationKind: string;
  /** The template this notice renders, for the operator-wide control. */
  templateSlug: string;
  signal: AbortSignal;
}

export type DunningConsentDecision =
  | { verdict: "allow" }
  | { verdict: "refuse"; refusalCode: DunningConsentRefusalCode };

export interface DunningConsentGate {
  /**
   * Answers before every customer send. Implementations MUST answer `allow`
   * for anything they cannot positively refuse; see the fail-open rule above.
   */
  evaluate(request: DunningConsentRequest): Promise<DunningConsentDecision>;
}

const ALLOWED: DunningConsentDecision = { verdict: "allow" };

/**
 * The cadence leg, which needs no deployment state at all: a notice kind the
 * configuration does not list is refused before any read happens. With the
 * shipped default cadence — which lists every kind that ships today — this
 * refuses nothing.
 */
export function evaluateDunningCadence(
  cadence: DunningCadenceConfig,
  notificationKind: string,
): DunningConsentDecision {
  return cadence.allowedNotificationKinds.includes(notificationKind)
    ? ALLOWED
    : { verdict: "refuse", refusalCode: "cadence_not_allowed" };
}

/**
 * Composes the cadence leg in front of a deployment's per-recipient gate, so a
 * composition that has no recipient state still gets the cadence refusal and a
 * composition that has one does not have to re-implement the cadence check.
 *
 * The per-recipient leg is optional on purpose: a deployment with no consent
 * ledger at all is a deployment where every transactional notice sends, which
 * is the correct answer for it, not a reason to withhold repair mail.
 */
export function createDunningConsentGate(input: {
  cadence: DunningCadenceConfig;
  recipientConsent?: DunningConsentGate;
}): DunningConsentGate {
  return {
    async evaluate(request: DunningConsentRequest): Promise<DunningConsentDecision> {
      const cadence = evaluateDunningCadence(input.cadence, request.notificationKind);
      if (cadence.verdict === "refuse") return cadence;
      if (!input.recipientConsent) return ALLOWED;
      try {
        return await input.recipientConsent.evaluate(request);
      } catch {
        // A gate that cannot answer must not be the reason a payer never hears
        // that their subscription is about to end.
        return ALLOWED;
      }
    },
  };
}
