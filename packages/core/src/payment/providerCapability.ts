/**
 * Payment provider capability contracts.
 *
 * Renewal and dunning orchestration must decide what it can do with a stored
 * consent by reading CAPABILITIES, never by comparing a provider identity
 * string. This module is the neutral vocabulary those decisions are expressed
 * in; the values live in each adapter, so nothing here names a provider.
 *
 * Every field exists because a live branch consumes it. Capabilities without a
 * consumer (capture flows, status reads, limits) are deliberately absent and
 * arrive with the code that needs them.
 */

/**
 * Why a stored consent cannot back an unattended (off-session) charge.
 *
 * Neutral by construction: a provider-native refusal code never reaches a
 * caller through this contract, so the orchestrator can route a blocked
 * renewal into customer repair without learning provider vocabulary.
 */
export type UnattendedChargeBlockReason =
  // The consent was registered under a model that cannot be charged
  // unattended — including the case where no model was recorded at all, which
  // fails closed rather than guessing one.
  "mandate_model_unsupported_for_unattended_charge";

/**
 * The stored consent evidence a capability judges, as read from local records
 * rather than from a provider call. Optional everywhere: a provider whose
 * consent carries no model simply ignores the field.
 */
export interface StoredMandateSnapshot {
  /** Recurring/mandate model recorded when the payer gave consent. */
  recurringModel?: string | null;
}

/** The verdict on whether a stored consent may be charged unattended. */
export interface UnattendedMandateAssessment {
  chargeable: boolean;
  blockReason?: UnattendedChargeBlockReason;
}

/**
 * What an unattended charge request must carry about the payer.
 *
 * Models the two payer-shaped branches on the renewal path: whether the
 * request needs a payer block at all, and whether the customer reference may
 * fall back to the stored contact email when no provider customer exists.
 */
export interface PayerContextRequirements {
  requiresPayerBlock: boolean;
  customerRefFallsBackToContactEmail: boolean;
}

/**
 * What the stored-method health check must see before a charge is attempted.
 *
 * Models the per-provider preconditions the payment-method lifecycle applies
 * to a stored method; the lifecycle keeps owning the reason vocabulary it
 * reports, this contract owns only the expectations.
 */
export interface PaymentMethodHealthExpectations {
  /** A provider-side customer reference is mandatory for a charge. */
  requiresCustomerRef: boolean;
  /** The stored method must be of exactly this kind, or null when any kind charges. */
  requiredMethodKind: string | null;
  /** A stored payer contact (email) is mandatory for a charge. */
  requiresPayerContact: boolean;
}

/**
 * How a customer-present client must drive one method-capture flow.
 *
 * Closed on purpose: a client can only offer a flow it knows how to drive, so a
 * provider that invents a handoff no client implements must widen this union
 * together with the surface that renders it, rather than have a repair page
 * present a control that leads nowhere.
 */
export type PaymentMethodCaptureHandoff =
  // The client mounts provider-supplied fields bound to a per-attempt secret,
  // or the payer types a short-lived authorisation code into the client's own
  // form. Line comments on purpose: a member-level doc comment makes the
  // extractor emit a trailing-whitespace alias line the diff guard refuses.
  "embedded_client_secret" | "payer_supplied_code";

/**
 * One way a payer can hand this provider a reusable payment consent while
 * present at the keyboard — the repair path out of a failed unattended charge.
 *
 * `kind` is neutral vocabulary the renderer may label and key on; it is never a
 * provider identity. A declared flow is an offer of capability, not a promise
 * that any given client implements it: the client filters by `handoff`.
 */
export interface PaymentMethodCaptureFlow {
  kind: string;
  handoff: PaymentMethodCaptureHandoff;
}

/**
 * Where a terminal outcome becomes visible on a rail, and how long the absence
 * of one is still normal.
 *
 * Reconciliation cannot tell "still running" from "stuck" by polling alone: a
 * rail that answers non-terminally forever looks identical to a healthy slow
 * one. Declaring the shape makes silence measurable per rail instead of
 * guessed at globally, and makes the question something a new adapter must
 * answer up front rather than discover through an incident.
 */
export interface TerminalOutcomeReporting {
  /**
   * Where the outcome lands. Line comments on purpose: a member-level doc
   * comment makes the extractor emit a trailing-whitespace alias line the diff
   * guard refuses.
   */
  // "status_field" - the readback's own status turns terminal.
  // "attempt_records" - the status stays non-terminal and the outcome is
  //   reported per attempt, so reading only the status never terminalizes.
  // "inbound_event" - only a pushed event carries the outcome, so a lost event
  //   means the readback never turns terminal at all.
  kind: "status_field" | "attempt_records" | "inbound_event";
  /**
   * Minutes of non-terminal answers after which this rail is behaving
   * abnormally and the attempt deserves a human, not another poll. This is a
   * suspicion threshold, never a verdict: elapsed time is not evidence about
   * money, so nothing may terminalize a charge from this value alone.
   */
  silenceBecomesSuspectAfterMinutes: number;
}

/**
 * One provider's unattended-charge capabilities, published by its adapter.
 *
 * `providerKind` is the registry key only. Consumers must read the capability
 * fields; branching on this value re-creates the coupling the contract exists
 * to remove.
 */
export interface PaymentProviderCapabilityDescriptor {
  providerKind: string;
  /**
   * Every customer-present capture flow this provider can complete. Empty means
   * a payer cannot repair this rail's consent without leaving the product.
   */
  captureFlows: readonly PaymentMethodCaptureFlow[];
  /**
   * The stored consent evidence must be loaded from local records before a
   * charge is prepared. False means `assessMandate` decides without it, and the
   * caller must not pay for the read.
   */
  requiresStoredMandateEvidence: boolean;
  /** Judges stored consent evidence before any durable provider attempt is created. */
  assessMandate(snapshot: StoredMandateSnapshot): UnattendedMandateAssessment;
  /** The provider flow an unattended renewal charge must be dispatched under. */
  unattendedChargeFlow: string;
  payerContext: PayerContextRequirements;
  methodHealth: PaymentMethodHealthExpectations;
  /** How this rail reports a terminal outcome, and when its silence stops being normal. */
  terminalOutcomeReporting: TerminalOutcomeReporting;
  /**
   * The stored consent belongs to one subscription rather than to the payer
   * account, so persisting it from a webhook must use the subscription-scoped
   * guarded write.
   */
  mandateUpsertIsSubscriptionScoped: boolean;
}

/** Lookup of published capabilities, keyed by provider kind. */
export interface PaymentProviderCapabilityRegistry {
  /** The descriptor published for this kind, or null when the kind is unknown. */
  get(providerKind: string): PaymentProviderCapabilityDescriptor | null;
  /** Every published kind, for inventory and conformance proofs. */
  kinds(): readonly string[];
}
