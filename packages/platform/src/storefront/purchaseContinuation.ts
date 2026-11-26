import { recoverAmbiguousSubmit } from "./ambiguousSubmit.js";
import type {
  ChangedPayloadPolicy,
  ClientEventReporter,
  ContinuationRecord,
  ContinuationRecordStorageBinding,
  IdentifierBinding,
  PaymentProviderFacts,
  PendingAction,
  PendingActionStorageBinding,
  StatusReading,
  SubmitFailureClassifier,
  SubmitOutcomeClass,
  SubmitOutcomeClassifier,
} from "./bindings.js";
import { advanceAttempt, clearContinuationRecord, getOrCreateContinuationId, readContinuationRecord } from "./continuationRecord.js";
import { toAttemptNumber, type AttemptNumber, type CommandKey, type ContinuationId } from "./identity.js";
import { applyPendingResume, checkPendingResume, type PendingResumeDecision } from "./pendingResume.js";

/**
 * What a store renders for one purchase. A new frozen object whenever a field
 * changes; `getSnapshot()` returns the same object until then.
 *
 * - `status`: what the buyer faces now. The union is open: a reader renders a
 *   status it does not know as `unknown`.
 * - `busy`: a command is waiting on a binding; every other command is refused.
 * - `hasContinuation` and `attempt`: read from the stored record after each
 *   command. `hasContinuation` in `idle` means a purchase may already exist
 *   under the stored key; submitting the same intent continues it. The
 *   snapshot never carries the continuation identity.
 * - `result` and `outcome`: the last answer applied and its class, computed
 *   once when the answer was applied.
 * - `source`: what produced the current status, or `null` after `begin` and a
 *   reset.
 * - `resumeDecision`: the last pending-action decision, `null` once an answer
 *   is applied.
 * - `error`: the error behind the current status when a binding rejected.
 *
 * @experimental
 */
export interface PurchaseContinuationSnapshot<TResult = unknown> {
  readonly status:
    | "idle" | "awaiting_payment" | "awaiting_authority" | "details_changed" | "declined" | "refused"
    | "closed" | "paid" | "paid_pending_activation" | "storage_unavailable" | "unknown";
  readonly busy: boolean;
  readonly hasContinuation: boolean;
  readonly attempt: AttemptNumber;
  readonly result: TResult | null;
  readonly outcome: SubmitOutcomeClass | null;
  readonly source: "submit" | "replay" | "read" | "return" | null;
  readonly resumeDecision: PendingResumeDecision | null;
  readonly error: unknown;
}

/**
 * One purchase as one object a store's UI renders from in any framework.
 *
 * Members use no `this`, so they can be destructured. Every command returns
 * `{ accepted, snapshot }`; `accepted` is `false` when the command was refused
 * and therefore called no binding and changed nothing: while `busy`, `begin`
 * outside `idle`, and `submit` after a settled answer until `startOver`.
 *
 * - `subscribe`: calls the listener with no argument after each new snapshot,
 *   synchronously and in subscription order. A listener removed during a
 *   notification is not called; a listener's error does not stop the others
 *   and is surfaced as an unhandled rejected promise. Returns an idempotent
 *   unsubscribe.
 * - `begin`: reads the stored record into an `idle` snapshot and runs the
 *   pending-action check when a marker exists. It sends no create request.
 * - `submit`: runs the pending-action check, applies the changed-payload
 *   policy, persists and reads back the continuation record, then sends one
 *   request under the key `commandKeyFor` gives and replays it exactly once
 *   when the server may have committed it.
 * - `resume`: one authoritative read of the purchase by its key. The
 *   controller never reads on its own.
 * - `recordReturn`: the buyer came back from a provider. It sends nothing and
 *   never settles: only a following read can.
 * - `startOver`: asks the server to give up the purchase and clears it only on
 *   a `terminal` answer.
 *
 * @experimental
 */
export interface PurchaseContinuation<TPayload, TResult, TOptions = undefined> {
  readonly getSnapshot: () => PurchaseContinuationSnapshot<TResult>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly begin: () => Promise<{ readonly accepted: boolean; readonly snapshot: PurchaseContinuationSnapshot<TResult> }>;
  readonly submit: (input: { payload: TPayload; options?: TOptions; selectedProvider?: string | null })
    => Promise<{ readonly accepted: boolean; readonly snapshot: PurchaseContinuationSnapshot<TResult> }>;
  readonly resume: () => Promise<{ readonly accepted: boolean; readonly snapshot: PurchaseContinuationSnapshot<TResult> }>;
  readonly recordReturn: () => { readonly accepted: boolean; readonly snapshot: PurchaseContinuationSnapshot<TResult> };
  readonly startOver: () => Promise<{ readonly accepted: boolean; readonly snapshot: PurchaseContinuationSnapshot<TResult> }>;
}

type Snapshot<TResult> = PurchaseContinuationSnapshot<TResult>;
type Patch<TResult> = { -readonly [K in keyof Snapshot<TResult>]?: Snapshot<TResult>[K] };
type Identity = { continuationId: ContinuationId; attempt: AttemptNumber };

const FIRST_ATTEMPT = toAttemptNumber(0);
const FIRST: Snapshot<never> = Object.freeze({
  status: "idle", busy: false, hasContinuation: false, attempt: FIRST_ATTEMPT, result: null, outcome: null,
  source: null, resumeDecision: null, error: undefined,
});
const FIELDS = Object.keys(FIRST) as (keyof Snapshot<never>)[];

/**
 * Creates the controller of one purchase. It composes the entry's
 * continuation-record functions, `recoverAmbiguousSubmit` and the
 * pending-resume functions, and reaches storage, requests and server answers
 * only through these bindings. It holds no storage name, wire format,
 * provider, clock of its own or timer, and creating it calls no binding.
 *
 * Host obligations:
 *
 * 1. `transport.submit`, `transport.replay` and `transport.read` resolve every
 *    typed server answer, refusals included, and reject only on a transport
 *    failure, except the server's in-flight refusal, which rejects so that
 *    `classifySubmitFailure` returns `attempt_in_flight` for it.
 * 2. `commandKeyFor` is deterministic across calls, reloads and instances; the
 *    key is the command's replay identity.
 * 3. `read` and `abandon` work from `{ continuationId, attempt }` alone;
 *    `result` is the last answer in this page when one exists.
 * 4. `abandon` resolves `terminal` only when the server cancelled or closed the
 *    purchase under the key, or confirmed that none exists and none can still
 *    arrive, after the host's own request timeout plus the server's
 *    late-create bound since the last unanswered create.
 * 5. `request.fingerprint` covers the purchase the buyer reviewed, without the
 *    payment method, and is stable across reloads and instances.
 * 6. `declinedAttempt` returns the attempt number the answer declines, or
 *    `null`; a host whose answers name attempts by a server identifier keeps a
 *    durable map from that identifier to the attempt number.
 * 7. A host resolves the purchase or clears the record before a sign-in or
 *    sign-out changes the principal its keys are bound to.
 * 8. The continuation identity is a credential on servers that accept it as
 *    one: a host does not log or report it.
 *
 * An answer is applied once. After a `settled` answer only another `settled`
 * answer changes the status. `settled` and `closed` clear the record and the
 * pending-action marker; `declined` advances the attempt only when
 * `declinedAttempt` names the stored attempt, and clears the marker. A changed
 * payload is sent only under `update_in_place`, or after a `refused` answer;
 * any other policy value reads as `refuse_changed`. When a record write throws
 * or does not read back, nothing is sent: the controller takes no
 * storage-failure policy. A class, recovery, reading or decision this version
 * does not know sends nothing more and keeps the record.
 *
 * A rejected `read` or `abandon` keeps the status and sets `error`. Any other
 * binding error, a throwing `storage.write` aside, rejects the command with
 * that error after `busy` is released, and the snapshot keeps its values from
 * before the command.
 *
 * @experimental
 */
export function createPurchaseContinuation<TPayload, TRequest, TResult, TOptions = undefined, C extends PendingAction = PendingAction>(bindings: {
  storage: ContinuationRecordStorageBinding;
  identifier: IdentifierBinding;
  changedPayload: ChangedPayloadPolicy;
  commandKeyFor: (identity: { continuationId: ContinuationId; attempt: AttemptNumber }) => CommandKey;
  request: {
    fingerprint: (payload: TPayload) => string;
    build: (payload: TPayload, identity: { commandKey: CommandKey; attempt: AttemptNumber }) => TRequest;
  };
  transport: {
    submit: (request: TRequest, options?: TOptions) => Promise<TResult>;
    replay: (request: TRequest, options: TOptions | undefined, deadlineMs: number) => Promise<TResult>;
    read: (purchase: { continuationId: ContinuationId; attempt: AttemptNumber; result: TResult | null; pending: C | null }) => Promise<TResult>;
    abandon: (purchase: { continuationId: ContinuationId; attempt: AttemptNumber; result: TResult | null; pending: C | null }) => Promise<StatusReading>;
  };
  classifySubmitFailure: SubmitFailureClassifier;
  classifyOutcome: SubmitOutcomeClassifier<TResult>;
  activationPending: (result: TResult) => boolean;
  declinedAttempt: (result: TResult) => number | null;
  /** @experimental */
  report?: ClientEventReporter;
  pending?: {
    storage: PendingActionStorageBinding<C>;
    toStatusReading: (result: TResult) => StatusReading;
    clock: { now: () => number };
    providerFacts: PaymentProviderFacts;
  };
}): PurchaseContinuation<TPayload, TResult, TOptions> {
  const { storage, identifier, transport, pending, report } = bindings;
  let snapshot: Snapshot<TResult> = FIRST;
  let settled = false;
  let refusedSeen = false;
  let last: Identity | null = null;
  const listeners: { listener: () => void; active: boolean }[] = [];

  const done = (accepted: boolean) => ({ accepted, snapshot });

  function publish(patch: Patch<TResult>): void {
    const next = { ...snapshot, ...patch };
    if (FIELDS.every(field => Object.is(next[field], snapshot[field]))) return;
    snapshot = Object.freeze(next);
    for (const entry of listeners.slice()) {
      if (!entry.active) continue;
      try {
        entry.listener();
      } catch (error) {
        void Promise.reject(error);
      }
    }
  }

  /** Reads the record and remembers its identity, so a purchase can still be read after its record is cleared. */
  function readRecord(): ContinuationRecord | null {
    const record = readContinuationRecord({ storage });
    if (record) last = { continuationId: record.continuationId, attempt: record.attempt ?? FIRST_ATTEMPT };
    return record;
  }

  const recordFields = (record: ContinuationRecord | null): Patch<TResult> =>
    ({ hasContinuation: record !== null, attempt: record?.attempt ?? FIRST_ATTEMPT });

  function identity(): Identity | null {
    readRecord();
    return last;
  }

  /** Publishes `busy` with `start`, runs `work` on a patch and releases `busy` with the result, or with the earlier fields on an error. */
  async function whileBusy(work: (patch: Patch<TResult>) => Promise<void>, start: Patch<TResult> = {}) {
    const before = snapshot;
    publish({ ...start, busy: true, error: undefined });
    const patch: Patch<TResult> = {};
    let completed = false;
    try {
      await work(patch);
      completed = true;
    } finally {
      publish(completed ? { ...patch, busy: false } : { ...before, busy: false });
    }
    return done(true);
  }

  function applyAnswer(patch: Patch<TResult>, result: TResult, outcome: SubmitOutcomeClass, source: Snapshot<TResult>["source"]): void {
    if (settled && outcome !== "settled") return;
    let status: Snapshot<TResult>["status"];
    switch (outcome) {
      case "settled":
        status = bindings.activationPending(result) ? "paid_pending_activation" : "paid";
        clearContinuationRecord({ storage });
        pending?.storage.clear();
        settled = true;
        break;
      case "needs_client_action":
        status = "awaiting_payment";
        break;
      case "awaiting_authority":
        status = "awaiting_authority";
        break;
      case "declined": {
        const declined = bindings.declinedAttempt(result);
        const record = readRecord();
        if (record && declined === (record.attempt ?? 0)) advanceAttempt({ storage });
        pending?.storage.clear();
        status = "declined";
        break;
      }
      case "refused":
        status = "refused";
        break;
      case "closed":
        clearContinuationRecord({ storage });
        pending?.storage.clear();
        status = "closed";
        break;
      default:
        status = "unknown";
    }
    refusedSeen = outcome === "refused";
    Object.assign(patch, { status, result, outcome, source, resumeDecision: null, error: undefined });
  }

  /**
   * Runs the pending-action check when a marker is stored and returns whether
   * the command must stop. It reads the purchase at most once; a `settled`,
   * `declined` or `closed` answer read during the check is applied and stops
   * the command.
   */
  async function checkMarker(patch: Patch<TResult>, selectedProvider?: string | null): Promise<boolean> {
    if (!pending) return false;
    const marker = pending.storage.read();
    if (!marker) return false;
    const purchase = identity();
    // Assigned inside the status binding, so the type is widened for the reads after the check.
    let read = null as { answer: TResult } | { error: unknown } | null;
    const status = {
      read: async (action: C): Promise<StatusReading> => {
        // With no identity nothing can be read: the reading is not an answer.
        if (!purchase) return { kind: "checking" };
        try {
          read = { answer: await transport.read({ ...purchase, result: snapshot.result, pending: action }) };
        } catch (error) {
          read = { error };
          return { kind: "checking" };
        }
        return pending.toStatusReading(read.answer);
      },
    };
    const decision = await checkPendingResume({ status, clock: pending.clock, providerFacts: pending.providerFacts }, marker, selectedProvider);
    if (read && "answer" in read) {
      const outcome = bindings.classifyOutcome(read.answer);
      if (outcome === "settled" || outcome === "declined" || outcome === "closed") {
        applyAnswer(patch, read.answer, outcome, "read");
        return true;
      }
    }
    let halted = null as Snapshot<TResult>["status"] | null;
    const halts = applyPendingResume(decision, {
      discardMarker: () => pending.storage.clear(),
      keepMarker: () => {},
      cannotCheck: () => { halted = "unknown"; },
      waitOnStatus: () => { halted = "awaiting_authority"; },
      blockOnPriorAttempt: () => { halted = "awaiting_payment"; },
      followRedirect: () => { halted = "awaiting_payment"; },
      reopenAction: () => { halted = "awaiting_payment"; },
    });
    patch.resumeDecision = decision;
    if (halted) patch.status = halted;
    if (read && "error" in read) patch.error = read.error;
    return halts;
  }

  async function send(patch: Patch<TResult>, payload: TPayload, options: TOptions | undefined): Promise<void> {
    let writeFailed = false;
    const guarded: ContinuationRecordStorageBinding = {
      read: () => storage.read(),
      write: (record) => {
        try {
          storage.write(record);
        } catch {
          writeFailed = true;
        }
      },
      clear: () => storage.clear(),
    };
    const record = readRecord();
    if (record && !identifier.accepts(record.continuationId)) {
      report?.("stored_continuation_rejected");
      Object.assign(patch, { status: "unknown" }, recordFields(record));
      return;
    }
    if (record && bindings.changedPayload !== "update_in_place") {
      const fingerprint = bindings.request.fingerprint(payload);
      if (fingerprint !== record.fingerprint) {
        if (!refusedSeen) {
          Object.assign(patch, { status: "details_changed" }, recordFields(record));
          return;
        }
        guarded.write({ ...record, fingerprint });
      }
    }
    const continuationId = getOrCreateContinuationId({ storage: guarded, identifier }, { fingerprint: () => bindings.request.fingerprint(payload) });
    // The attempt and the key come only from the record read back, so an identity that was not kept is never sent.
    const stored = readRecord();
    if (writeFailed || !stored || stored.continuationId !== continuationId) {
      Object.assign(patch, { status: "storage_unavailable" }, recordFields(stored));
      return;
    }
    const attempt = stored.attempt ?? FIRST_ATTEMPT;
    const commandKey = bindings.commandKeyFor({ continuationId, attempt });
    const request = bindings.request.build(payload, { commandKey, attempt });
    let answer: TResult;
    try {
      answer = await transport.submit(request, options);
    } catch (error) {
      const recovery = await recoverAmbiguousSubmit<TRequest, TOptions | undefined, TResult>({
        transport: { commandKey: () => commandKey, replay: (sent, sentOptions, deadlineMs) => transport.replay(sent, sentOptions, deadlineMs) },
        classifySubmitFailure: bindings.classifySubmitFailure,
        ...(report ? { report } : {}),
      }, { error, request, options });
      if (recovery?.kind === "recovered") applyAnswer(patch, recovery.response, bindings.classifyOutcome(recovery.response), "replay");
      else if (recovery?.kind === "in_flight") Object.assign(patch, { status: "awaiting_authority", source: "submit" });
      else Object.assign(patch, { status: "unknown", error });
      Object.assign(patch, recordFields(readRecord()));
      return;
    }
    applyAnswer(patch, answer, bindings.classifyOutcome(answer), "submit");
    Object.assign(patch, recordFields(readRecord()));
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      const entry = { listener, active: true };
      listeners.push(entry);
      return () => {
        if (!entry.active) return;
        entry.active = false;
        listeners.splice(listeners.indexOf(entry), 1);
      };
    },
    begin: async () => {
      if (snapshot.busy || snapshot.status !== "idle") return done(false);
      const idle: Patch<TResult> = { status: "idle", result: null, outcome: null, source: null, ...recordFields(readRecord()) };
      if (!pending?.storage.read()) {
        publish(idle);
        return done(true);
      }
      return await whileBusy(async patch => {
        await checkMarker(patch);
        Object.assign(patch, recordFields(readRecord()));
      }, idle);
    },
    submit: async (input) => {
      if (snapshot.busy || settled) return done(false);
      return await whileBusy(async patch => {
        if (await checkMarker(patch, input.selectedProvider)) {
          Object.assign(patch, recordFields(readRecord()));
          return;
        }
        await send(patch, input.payload, input.options);
      });
    },
    resume: async () => {
      if (snapshot.busy) return done(false);
      const purchase = identity();
      if (!purchase) {
        publish({ status: snapshot.status === "idle" ? "idle" : "unknown", ...recordFields(null) });
        return done(true);
      }
      return await whileBusy(async patch => {
        let answer: TResult;
        try {
          answer = await transport.read({ ...purchase, result: snapshot.result, pending: pending?.storage.read() ?? null });
        } catch (error) {
          Object.assign(patch, { error }, recordFields(readRecord()));
          return;
        }
        applyAnswer(patch, answer, bindings.classifyOutcome(answer), "read");
        Object.assign(patch, recordFields(readRecord()));
      });
    },
    recordReturn: () => {
      if (snapshot.busy) return done(false);
      if (!settled) publish({ status: "awaiting_authority", source: "return" });
      return done(true);
    },
    startOver: async () => {
      if (snapshot.busy) return done(false);
      settled = false;
      refusedSeen = false;
      const record = readRecord();
      const marker = pending?.storage.read() ?? null;
      const purchase = record || marker ? last : null;
      if (!purchase) {
        // Nothing addresses a purchase any more: a marker without any identity cannot be read or abandoned.
        if (marker) pending?.storage.clear();
        last = null;
        publish(FIRST);
        return done(true);
      }
      return await whileBusy(async patch => {
        let reading: StatusReading;
        try {
          reading = await transport.abandon({ ...purchase, result: snapshot.result, pending: marker });
        } catch (error) {
          Object.assign(patch, { error }, recordFields(readRecord()));
          return;
        }
        if (reading.kind === "terminal") {
          clearContinuationRecord({ storage });
          pending?.storage.clear();
          last = null;
          Object.assign(patch, FIRST);
          return;
        }
        Object.assign(patch, recordFields(readRecord()));
      });
    },
  };
}
