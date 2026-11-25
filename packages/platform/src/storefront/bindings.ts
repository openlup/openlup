import type { PaymentAttemptStatus } from "@openlup/core/payment";
import type { AttemptNumber, CommandKey, ContinuationId } from "./identity.js";

/**
 * What a store's client keeps for one purchase so that it survives a lost
 * response and a reload.
 *
 * The record's identity is its continuation identity. `fingerprint` is the
 * host's opaque stamp of the payload that first created the record. `attempt`
 * absent means the first attempt, `0`. The record carries no time.
 */
export interface ContinuationRecord {
  continuationId: ContinuationId;
  fingerprint: string;
  attempt?: AttemptNumber;
}

/**
 * The host's storage for the continuation record. The host owns the storage
 * name and the serialization; a read returns `null` for an absent or unreadable
 * record.
 *
 * It is synchronous, matching the synchronous browser storage it is bound to
 * and the functions that read it. An asynchronous variant would be a new name.
 */
export interface ContinuationRecordStorageBinding {
  read(): ContinuationRecord | null;
  write(record: ContinuationRecord): void;
  clear(): void;
}

/**
 * The host's source of continuation identities.
 *
 * `next` mints a new identifier and `accepts` decides whether a stored one may
 * be reused. Both use a plain `string`: the identifier format belongs to the
 * host, and the package brands a value with `toContinuationId` only once the
 * host accepts it. A host that wants the server's format applies the commerce
 * entry's `checkoutContinuationJourneyIdSchema` in `accepts`.
 */
export interface IdentifierBinding {
  next(): string;
  accepts(value: string): boolean;
}

/**
 * The class the host gives a failed submit.
 *
 * - `attempt_in_flight`: the server refused because an attempt for this
 *   purchase is already in flight. Report the conflict and send nothing.
 * - `timeout`: the request timed out, so the server may have committed. One
 *   exact replay of the retained request.
 * - `transport_uncertain`: the browser reported a transport failure, so the
 *   server may have committed. One exact replay of the retained request.
 * - `other`: anything unrecognized. Send nothing and never replay.
 *
 * The union is open: members may be added in a minor release. The package reads
 * this value and treats a member it does not know as `other`.
 */
export type SubmitFailureClass = "attempt_in_flight" | "timeout" | "transport_uncertain" | "other";

/** Maps a failed submit's error to one `SubmitFailureClass`; returns `other` for anything it does not recognize. */
export type SubmitFailureClassifier = (error: unknown) => SubmitFailureClass;

/**
 * The host's submit transport, used to replay a retained request exactly.
 *
 * `commandKey` returns the request's `CommandKey`, or `null` or `undefined`
 * when the request carries none; a request without a key is never replayed.
 * `replay` sends the retained request and options again. `deadlineMs` is a
 * duration in milliseconds after which the replay gives up.
 */
export interface SubmitTransportBinding<TRequest = unknown, TOptions = unknown, TResponse = unknown> {
  commandKey(request: TRequest): CommandKey | null | undefined;
  replay(request: TRequest, options: TOptions, deadlineMs: number): Promise<TResponse>;
}

/**
 * What the client does when it cannot persist a new continuation identity.
 *
 * - `refuse`: the default. Do not submit.
 * - `continue_unpersisted`: deprecated from its first release. Submit with an
 *   identity that was not persisted, so a reload cannot find it again.
 *
 * The union is open: members may be added in a minor release.
 *
 * @experimental
 */
export type StorageFailurePolicy = "refuse" | "continue_unpersisted";

/**
 * Receives a client event the package reports.
 *
 * New events may be added in a minor release, so a host accepts the parameter's
 * union type rather than narrowing to the literals it knows.
 *
 * @experimental
 */
export type ClientEventReporter = (event: "submit_refused_in_flight") => void;

/**
 * Marks a provider action that was already issued for a purchase.
 *
 * `actionKind` is the kind of action, `phase` how far the client got with it,
 * and `expiresAt` the time after which the marker no longer describes a live
 * action, in epoch seconds. A marker without `phase` is read as
 * `confirm_dispatched`; a marker without `expiresAt` does not expire.
 *
 * @experimental
 */
export interface PendingAction {
  actionKind: "embedded" | "redirect" | "none";
  phase?: "action_issued" | "confirm_dispatched";
  expiresAt?: number;
}

/**
 * The host's storage for the pending-action marker. The host owns the storage
 * name and the serialization, and may extend the marker with its own fields
 * through `C`.
 *
 * @experimental
 */
export interface PendingActionStorageBinding<C extends PendingAction = PendingAction> {
  read(): C | null;
  write(pending: C): void;
  clear(): void;
}

/**
 * What a status binding resolves to.
 *
 * - `terminal`: the server answered that the purchase is over.
 * - `checking`: the status could not be read. It is not an answer.
 * - `active`: the purchase is open, with optional payment and action facts.
 *
 * The provider fields are opaque strings the host supplies; the package names
 * no provider. A host maps a payment attempt status it does not recognize to
 * `null`, which the package reads as "not known to admit a new attempt". The
 * union is open: the package reads a kind it does not know as `checking`.
 *
 * @experimental
 */
export type StatusReading =
  | { kind: "terminal" }
  | { kind: "checking" }
  | {
    kind: "active";
    payment?: { provider?: string | null; attemptStatus?: PaymentAttemptStatus | null } | null;
    action?:
      | { kind: "embedded"; provider?: string; actionToken?: string }
      | { kind: "redirect"; url: string }
      | { kind: "other"; provider?: string }
      | null;
  };

/**
 * The host's status read for a pending action.
 *
 * It resolves to `checking` when the status cannot be read, and to `terminal`
 * only on the server's answer that the purchase is over.
 *
 * @experimental
 */
export interface StatusTransportBinding<C extends PendingAction = PendingAction> {
  read(pending: C): Promise<StatusReading>;
}

/**
 * Facts about the payment providers a store uses, as opaque names.
 *
 * `providers` lists the providers, `reopenableEmbeddedProviders` those whose
 * embedded action can be opened again, and `retryableAttemptStatuses` the
 * attempt statuses that admit a new attempt. The default for the last is the
 * core payment entry's `RETRYABLE_ATTEMPT_STATUSES`; the statuses are core's
 * `PaymentAttemptStatus`, so this entry adds no second vocabulary.
 *
 * @experimental
 */
export interface PaymentProviderFacts {
  providers: readonly string[];
  reopenableEmbeddedProviders: readonly string[];
  retryableAttemptStatuses: readonly PaymentAttemptStatus[];
}

/**
 * What the server does with a changed payload sent under the same command key:
 * `update_in_place` updates the existing record, `refuse_changed` refuses it.
 * It configures no replay. The union is open: members may be added in a minor
 * release.
 *
 * @experimental
 */
export type ChangedPayloadPolicy = "update_in_place" | "refuse_changed";

/**
 * The class of the result of any submit command, not only a purchase.
 *
 * The union is open: members may be added in a minor release. The package reads
 * this value and treats a member it does not know as `unknown`.
 *
 * @experimental
 */
export type SubmitOutcomeClass = "settled" | "needs_client_action" | "awaiting_authority" | "refused" | "unknown";

/**
 * Maps a submit command's result to one `SubmitOutcomeClass`.
 *
 * @experimental
 */
export type SubmitOutcomeClassifier<TResult = unknown> = (result: TResult) => SubmitOutcomeClass;
