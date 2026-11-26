/**
 * The starter's binding of the storefront purchase-continuation controller to its checkout actions: the tab
 * record, the command key, the wire, the outcome classes and the create bookkeeping that decides when "no order
 * under this key" is final. It is bundled for the browser, so it takes every dependency as an option: the
 * managed pages pass the shared `act`, tab storage, `Date.now` and `() => crypto.randomUUID()`, and a test or a
 * store-owned client passes its own.
 */
import {
  clearContinuationRecord, toAttemptNumber, toCommandKey, toContinuationId,
  type CommandKey, type ContinuationRecord, type StatusReading, type SubmitOutcomeClass,
} from '@openlup/platform/storefront';
import type { createPurchaseContinuation } from '@openlup/platform/storefront';
import { actionRequestTimeoutMs, checkoutLateCreateMs, type ActionInput, type ActionResult, type Operation } from './api.ts';
import { isRecord, type OfferIssue } from './offer.ts';
import { uncertainAction } from './transport.ts';

/** The purchase a checkout submits: `reviewed` is the JSON of the reviewed form values without `locale`. */
export interface CheckoutPayload { reviewed: string; body: ActionInput }
export interface CheckoutRequest { key: CommandKey; body: ActionInput }
export type CheckoutBindings = Parameters<typeof createPurchaseContinuation<CheckoutPayload, CheckoutRequest, ActionResult>>[0];
export interface CheckoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export type CheckoutAct = (operation: Operation, input: ActionInput, commandKey: string, timeoutMs?: number) => Promise<ActionResult>;

/** The tab-storage name of the checkout record of one store configuration. */
export const checkoutRecordKey = (configuration: string) => `neutral-store:checkout-continuation:v1:${configuration}`;
const storageProbe = 'neutral-store:checkout-continuation:probe';
const versionFour = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Tab storage can be read and accepts a write; the probe leaves nothing behind. */
export function storageAvailable(storage: CheckoutStorage): boolean {
  try {
    storage.getItem(storageProbe);
    storage.setItem(storageProbe, '1');
    storage.removeItem(storageProbe);
    return true;
  } catch { return false; }
}

export interface CheckoutCreateState {
  inFlight: number;
  settledAt?: number;
  /** The dispatch time of the latest create of this key in this document. */
  sentAt?: number;
  /** A create the browser lost in transport may still reach the host until its request timeout. */
  lostUntil?: number;
  /** A create of this key got no definite answer, or the key came from an earlier document. */
  uncertain?: boolean;
}

/**
 * "No order under this key" is final only once no create of this key can still arrive: strictly after the
 * request timeout plus the host's late-create bound, as the host's own stale rule is strict.
 */
export function noneIsFinal(state: { sentAt?: number | undefined; create?: CheckoutCreateState | undefined; documentStartedAt: number; continuationAt: number }): boolean {
  if (state.sentAt === undefined) return true;
  if (state.create) {
    return state.create.inFlight === 0 && state.create.settledAt !== undefined
      && state.continuationAt > Math.max(state.create.settledAt, state.create.lostUntil ?? state.create.settledAt) + checkoutLateCreateMs;
  }
  return state.continuationAt > Math.max(state.documentStartedAt + checkoutLateCreateMs,
    state.sentAt + actionRequestTimeoutMs + checkoutLateCreateMs);
}

/** The creates of each checkout key in this document, kept across remounts of the page. */
function createBookkeeping() {
  const creates = new Map<string, CheckoutCreateState>();
  let documentStartedAt: number | undefined;
  return {
    /** Records when this document started using checkout keys; later calls keep the first time. */
    begin(now: number): number { documentStartedAt ??= now; return documentStartedAt; },
    state(id: string): CheckoutCreateState | undefined { return creates.get(id); },
    /**
     * Counts a create of `id` dispatched at `sentAt`. `previousSentAt` is the stored dispatch time from before it:
     * a key from an earlier document may have a create this document never saw settle, which may reach the host
     * until its request timeout, so that bound carries over to this document's creates.
     */
    dispatch(id: string, sentAt: number, previousSentAt: number | undefined): void {
      const state = creates.get(id) ?? { inFlight: 0, ...(previousSentAt !== undefined
        ? { uncertain: true, lostUntil: previousSentAt + actionRequestTimeoutMs } : {}) };
      state.inFlight += 1;
      state.sentAt = sentAt;
      creates.set(id, state);
    },
    /** Always after a create returned, even when its view is gone; `result` is absent when it threw. */
    settled(id: string, result: ActionResult | undefined, now: number): void {
      const state = creates.get(id);
      if (!state) return;
      state.inFlight = Math.max(0, state.inFlight - 1);
      state.settledAt = now;
      if (!result || uncertainAction(result)) state.uncertain = true;
      // An early transport error does not end the request on the wire: it may reach the host until the request timeout.
      if (result && !result.ok && result.code === 'starter_transport_unavailable' && state.sentAt !== undefined) {
        state.lostUntil = Math.max(state.lostUntil ?? 0, state.sentAt + actionRequestTimeoutMs);
      }
    },
    /** A definite refusal of the latest create shows that no create of this key left an order behind. */
    refusedEvery(id: string, record: { ordered?: true | undefined; sentAt?: number | undefined }): boolean {
      const state = creates.get(id);
      return !record.ordered && record.sentAt !== undefined && state !== undefined && state.inFlight === 0 && !state.uncertain;
    },
    /** `noneIsFinal` for the key `id`, its stored dispatch time and the time its continuation was sent. */
    final(id: string, sentAt: number | undefined, continuationAt: number): boolean {
      const create = creates.get(id);
      const startedAt = documentStartedAt ?? continuationAt;
      const final = noneIsFinal({ sentAt, create, documentStartedAt: startedAt, continuationAt });
      // A stored dispatch time newer than this document's latest create was written by another document sharing the
      // storage: its create may still arrive, so its own bound applies as well.
      if (!final || !create || sentAt === undefined || create.sentAt === undefined || sentAt <= create.sentAt) return final;
      return noneIsFinal({ sentAt, documentStartedAt: startedAt, continuationAt });
    },
  };
}

/** One per document, keyed by checkout key: a remounted page shares it. */
export const checkoutCreates = createBookkeeping();

/**
 * The class of every refusal code the starter's checkout create, continuation and read actions answer, and of the
 * codes the browser raises. `refused` means the create was refused before anything was created, so the buyer may
 * correct the details under the same key; every other refusal, listed or not, is `unknown`.
 */
const cartIssueCodes: Record<OfferIssue['code'], 'refused'> = {
  cart_invalid: 'refused', cart_configuration_changed: 'refused', cart_empty: 'refused', unknown_sku: 'refused',
  quantity_invalid: 'refused', duplicate_sku: 'refused', purchase_mode_unavailable: 'refused', cadence_unavailable: 'refused',
  minimum_units: 'refused', maximum_units: 'refused', amount_overflow: 'refused',
};
export const checkoutRefusalClasses: Readonly<Record<string, 'refused' | 'unknown'>> = Object.freeze({
  starter_input_invalid: 'refused', starter_email_invalid: 'refused', starter_terms_required: 'refused',
  starter_expected_total_required: 'refused', starter_quote_price_changed: 'refused', starter_quote_refresh_required: 'refused',
  acquisition_terms_capability_required: 'refused', catalog_admission_quote_authority_required: 'refused', ...cartIssueCodes,
  starter_checkout_changed: 'unknown', starter_checkout_in_progress: 'unknown', starter_checkout_not_abandonable: 'unknown',
  starter_checkout_expired: 'unknown', starter_checkout_paid: 'unknown', starter_checkout_not_payable: 'unknown',
  starter_checkout_not_found: 'unknown', starter_checkout_request_stale: 'unknown', starter_attempt_limited: 'unknown',
  starter_command_conflict: 'unknown', starter_purchase_unavailable: 'unknown', starter_quote_unavailable: 'unknown',
  starter_order_not_found: 'unknown', starter_recovery_unavailable: 'unknown', starter_recovery_expired: 'unknown',
  starter_dependency_unavailable: 'unknown', starter_transport_unavailable: 'unknown', starter_response_invalid: 'unknown',
  starter_checkout_session_changed: 'unknown',
});
const refusedBeforeCreate = (code: string) => (Object.hasOwn(checkoutRefusalClasses, code) && checkoutRefusalClasses[code] === 'refused')
  || code.startsWith('acquisition_terms_');
const paidStatuses: readonly unknown[] = ['paid', 'fulfillment_pending', 'fulfilled'];
const attemptClasses = new Map<unknown, SubmitOutcomeClass>([
  [undefined, 'needs_client_action'], [null, 'needs_client_action'], ['refused', 'declined'],
  ['dispatched', 'awaiting_authority'], ['indeterminate', 'awaiting_authority'],
]);

/**
 * Classifies a starter action result. Only `cancelled` closes a key: an expired or not payable order may still
 * settle a payment under it, so those answers are `unknown`.
 */
export function classifyCheckoutAnswer(answer: unknown): SubmitOutcomeClass {
  if (!isRecord(answer)) return 'unknown';
  if (answer.ok === false) {
    return typeof answer.code === 'string' && answer.status !== 503 && refusedBeforeCreate(answer.code) ? 'refused' : 'unknown';
  }
  if (answer.ok !== true || !isRecord(answer.value)) return 'unknown';
  const value = answer.value;
  if (paidStatuses.includes(value.status)) return 'settled';
  if (value.status === 'pending_payment') return attemptClasses.get(value.attemptState) ?? 'unknown';
  if (value.status === 'cancelled') return 'closed';
  return 'unknown';
}

/** A starter answer that does not say whether the host applied the request; `answer` carries it. */
export class CheckoutAnswerUncertain extends Error {
  readonly answer: ActionResult;
  constructor(answer: ActionResult) {
    super('starter_checkout_answer_uncertain');
    this.name = 'CheckoutAnswerUncertain';
    this.answer = answer;
  }
}

/**
 * Tab storage did not keep the dispatch time of a create, so the create was not sent. The record and its key are
 * kept; the page may retry once storage accepts writes, or move the purchase to page memory.
 */
export class CheckoutStorageUnavailable extends Error {
  constructor(cause: unknown) {
    super('starter_checkout_storage_unavailable', { cause });
    this.name = 'CheckoutStorageUnavailable';
  }
}

/** The tab record: the package's fields, then the starter's host fields. Version 1 stays; fields are additive. */
interface StoredRecord {
  v: 1; id: string; fingerprint?: string | undefined; attempt?: number | undefined;
  attempts?: Record<string, number> | undefined; sentAt?: number | undefined; ordered?: true | undefined; orderRef?: string | undefined;
}
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function parseRecord(raw: string | null): StoredRecord | null {
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isRecord(value) || typeof value.id !== 'string' || !versionFour.test(value.id)) return null;
  if (value.v !== 1) return { v: 1, id: value.id };
  const attempts = isRecord(value.attempts) ? Object.fromEntries(Object.entries(value.attempts).filter(([, attempt]) => count(attempt))) : {};
  return {
    v: 1, id: value.id,
    ...(typeof value.fingerprint === 'string' ? { fingerprint: value.fingerprint } : {}),
    ...(count(value.attempt) ? { attempt: value.attempt } : {}),
    ...(Object.keys(attempts).length ? { attempts: attempts as Record<string, number> } : {}),
    ...(Number.isSafeInteger(value.sentAt) ? { sentAt: value.sentAt as number } : {}),
    ...(value.ordered === true ? { ordered: true as const } : {}),
    ...(value.ordered === true && typeof value.orderRef === 'string' ? { orderRef: value.orderRef } : {}),
  };
}

/** Serializes in one field order, so equal records are equal text. */
function encode(record: StoredRecord): string {
  const { v, id, fingerprint, attempt, attempts, sentAt, ordered, orderRef } = record;
  return JSON.stringify({ v, id, fingerprint, attempt, attempts, sentAt, ordered, orderRef });
}

const valueOf = (answer: ActionResult | null): Record<string, unknown> | null =>
  answer?.ok === true && isRecord(answer.value) ? answer.value : null;
const sessionChanged: ActionResult = Object.freeze({ ok: false, code: 'starter_checkout_session_changed' });
/** Refusals that say an order exists under the key. */
const orderExists: readonly string[] = ['starter_checkout_changed', 'starter_checkout_in_progress', 'starter_checkout_not_abandonable',
  'starter_checkout_expired', 'starter_checkout_paid', 'starter_checkout_not_payable'];
const terminal: StatusReading = Object.freeze({ kind: 'terminal' });
const checking: StatusReading = Object.freeze({ kind: 'checking' });
const active: StatusReading = Object.freeze({ kind: 'active' });

export interface CheckoutBindingOptions {
  configuration: string;
  storage: CheckoutStorage;
  act: CheckoutAct;
  /** Milliseconds; the page passes `Date.now`. */
  now: () => number;
  /** A version 4 UUID; the page passes `() => crypto.randomUUID()`. */
  nextId: () => string;
  /** The purchase convenience token, or `null`. */
  token: () => string | null;
  /** The buyer's locale, sent with each continuation. */
  locale: () => string;
  /** Receives each `checkout.continuation` answer, with the abandon reading or `null`. */
  onContinuationAnswer?: (answer: ActionResult, reading: StatusReading | null) => void;
}

/**
 * Binds the controller to the starter's checkout. The key of a purchase is its stored continuation value, sent
 * unchanged in `Idempotency-Key`; nothing is cached, so every read reads tab storage. No body, token or key is
 * logged or reported.
 *
 * Limits of the finality rule ("no order under this key" is final only once no create can still arrive):
 *
 * - `storage` is per-tab storage (`sessionStorage`), and `now` a wall clock shared by documents (`Date.now`). The
 *   create bookkeeping lives in one document. With storage shared across tabs, a newer dispatch time another tab
 *   stored keeps "no order" open until that create's own bound, but a create another tab has not yet stored is
 *   not seen, so shared storage can still end a key early.
 * - The bound assumes each create may reach the host until `actionRequestTimeoutMs` after it was sent, the default
 *   deadline of the shared `act`. A custom `act` with a longer deadline, or one that throws after sending, is not
 *   covered by that bound.
 * - A create is sent only after its dispatch time reads back from storage; otherwise the submit rejects with
 *   `CheckoutStorageUnavailable` and nothing is sent.
 * - A `getItem` that throws reads as no record. The controller then mints a new identity, and its write may replace
 *   the unreadable record before its read-back refuses to send.
 */
export function createCheckoutBindings(options: CheckoutBindingOptions) {
  const name = checkoutRecordKey(options.configuration);
  checkoutCreates.begin(options.now());
  const stored = (): StoredRecord | null => {
    let raw: string | null;
    try { raw = options.storage.getItem(name); } catch { return null; }
    return parseRecord(raw);
  };
  const own = (id: string) => { const record = stored(); return record?.id === id ? record : null; };
  /** Changes the record of `id` only; a write tab storage refuses leaves the stored record as it was. */
  const amend = (id: string, change: (record: StoredRecord) => StoredRecord): void => {
    const record = own(id);
    if (!record) return;
    try { options.storage.setItem(name, encode(change(record))); } catch { /* The stored record still stands. */ }
  };
  const otherOrder = (record: StoredRecord | null, value: Record<string, unknown> | null) =>
    record?.orderRef !== undefined && typeof value?.orderRef === 'string' && value.orderRef !== record.orderRef;
  const reject = (answer: ActionResult) => { throw new CheckoutAnswerUncertain(answer); };

  const storage: CheckoutBindings['storage'] = {
    read(): ContinuationRecord | null {
      const record = stored();
      return record && { continuationId: toContinuationId(record.id), fingerprint: record.fingerprint ?? '',
        ...(record.attempt !== undefined ? { attempt: toAttemptNumber(record.attempt) } : {}) };
    },
    write(record: ContinuationRecord): void {
      const previous = stored();
      const kept = previous?.id === record.continuationId
        ? { attempts: previous.attempts, sentAt: previous.sentAt, ordered: previous.ordered, orderRef: previous.orderRef } : {};
      options.storage.setItem(name, encode({ v: 1, id: record.continuationId, fingerprint: record.fingerprint,
        ...(record.attempt !== undefined ? { attempt: record.attempt } : {}), ...kept }));
    },
    clear(): void { options.storage.removeItem(name); },
  };

  async function create(request: CheckoutRequest, timeoutMs?: number): Promise<ActionResult> {
    const id: string = request.key;
    // The record keeps whole milliseconds; rounding up keeps the bound on the safe side for a fractional clock.
    const sentAt = Math.ceil(options.now());
    // No create leaves without its dispatch time in the record: a reload could otherwise read "no order" as final at once.
    const previous = own(id);
    if (!previous) throw new CheckoutStorageUnavailable(null);
    try { options.storage.setItem(name, encode({ ...previous, sentAt })); } catch (error) { throw new CheckoutStorageUnavailable(error); }
    if (own(id)?.sentAt !== sentAt) throw new CheckoutStorageUnavailable(null);
    checkoutCreates.dispatch(id, sentAt, previous?.sentAt);
    let answer: ActionResult;
    try {
      answer = await (timeoutMs === undefined ? options.act('checkout.create', request.body, id)
        : options.act('checkout.create', request.body, id, timeoutMs));
    } catch (error) {
      checkoutCreates.settled(id, undefined, options.now());
      throw error;
    }
    checkoutCreates.settled(id, answer, options.now());
    if (uncertainAction(answer)) reject(answer);
    const record = own(id);
    const value = valueOf(answer);
    if (otherOrder(record, value)) return sessionChanged;
    if (value?.status === 'pending_payment' && typeof value.orderRef === 'string') {
      const orderRef = value.orderRef;
      amend(id, current => ({ ...current, ordered: true, orderRef }));
    } else if (!answer.ok && orderExists.includes(answer.code)) {
      amend(id, current => ({ ...current, ordered: true }));
    } else if (!answer.ok && answer.code !== 'starter_checkout_not_found' && record && checkoutCreates.refusedEvery(id, record)) {
      // A definite refusal of every create of this key leaves no order behind, so the record no longer asks for the panel.
      amend(id, ({ sentAt: _sentAt, ...current }) => current);
    }
    return answer;
  }

  const continuation = async (id: string, action: 'resume' | 'abandon') =>
    await options.act('checkout.continuation', { action, locale: options.locale() }, id);

  const read: CheckoutBindings['transport']['read'] = async ({ continuationId, attempt, result }) => {
    const id: string = continuationId;
    const resumed = await continuation(id, 'resume');
    options.onContinuationAnswer?.(resumed, null);
    if (uncertainAction(resumed)) reject(resumed);
    const record = own(id);
    const value = valueOf(resumed);
    let answer = resumed;
    let attemptRef: string | undefined;
    if (value?.status === 'pending_payment' && typeof value.token === 'string') {
      const inspected = await options.act('checkout.payment', { action: 'inspect', orderRef: value.orderRef, token: value.token }, options.nextId());
      if (uncertainAction(inspected)) reject(inspected);
      const inspection = valueOf(inspected);
      if (!inspected.ok || !inspection) answer = inspected;
      else {
        if (typeof inspection.attemptRef === 'string') attemptRef = inspection.attemptRef;
        answer = { ok: true, ...(resumed.ok && resumed.replayed ? { replayed: true } : {}), value: { ...value, ...(attemptRef !== undefined ? { attemptRef } : {}),
          ...('state' in inspection ? { attemptState: inspection.state } : {}) } };
      }
    } else if (!resumed.ok && resumed.code === 'starter_checkout_not_payable' && record?.orderRef !== undefined) {
      const last = valueOf(result);
      const token = typeof last?.token === 'string' ? last.token : options.token();
      if (token !== null) {
        const pinned = await options.act('checkout.read', { orderRef: record.orderRef, token }, options.nextId());
        if (valueOf(pinned)?.orderRef === record.orderRef) answer = pinned;
      }
    }
    if (otherOrder(record, valueOf(answer)) || (!resumed.ok && resumed.code === 'starter_checkout_not_found' && record?.ordered)) {
      return sessionChanged;
    }
    const facts = valueOf(answer);
    if (facts?.status === 'pending_payment' && typeof facts.orderRef === 'string') {
      const orderRef = facts.orderRef;
      amend(id, current => ({ ...current, ordered: true, orderRef,
        ...(attemptRef !== undefined && !Object.hasOwn(current.attempts ?? {}, attemptRef)
          ? { attempts: { ...current.attempts, [attemptRef]: attempt } } : {}) }));
    }
    return answer;
  };

  const abandon: CheckoutBindings['transport']['abandon'] = async ({ continuationId }) => {
    const id: string = continuationId;
    // The host may have looked for an order at any time after this; an earlier time is the safe one.
    const continuationAt = options.now();
    checkoutCreates.begin(continuationAt);
    const answer = await continuation(id, 'abandon');
    if (uncertainAction(answer)) {
      options.onContinuationAnswer?.(answer, null);
      reject(answer);
    }
    const reading = abandonReading(answer, own(id), id, continuationAt);
    options.onContinuationAnswer?.(answer, reading);
    return reading;
  };

  function abandonReading(answer: ActionResult, record: StoredRecord | null, id: string, continuationAt: number): StatusReading {
    if (!answer.ok) {
      return answer.code === 'starter_checkout_paid' ? terminal : answer.code === 'starter_checkout_not_abandonable' ? active : checking;
    }
    const value = valueOf(answer);
    if (!value || typeof value.abandoned !== 'boolean') return checking;
    if (value.abandoned) return terminal;
    if (value.orderRef === undefined) {
      // No order under this key: final only once no create can still arrive, and never when one was recorded.
      if (record?.ordered) return checking;
      return checkoutCreates.final(id, record?.sentAt, continuationAt) ? terminal : checking;
    }
    // A paid order cannot settle anything more under the key; a cancelled or refunded one is over.
    return ['cancelled', 'refunded', ...paidStatuses].includes(value.status) ? terminal : active;
  }

  const bindings: CheckoutBindings = {
    storage,
    identifier: { next: () => options.nextId(), accepts: value => versionFour.test(value) },
    changedPayload: 'refuse_changed',
    commandKeyFor: ({ continuationId }) => toCommandKey(continuationId),
    request: {
      fingerprint: payload => payload.reviewed,
      build: (payload, { commandKey }) => ({ key: commandKey, body: payload.body }),
    },
    transport: {
      submit: async request => await create(request),
      replay: async (request, _options, deadlineMs) => await create(request, deadlineMs),
      read,
      abandon,
    },
    classifySubmitFailure: error => error instanceof CheckoutAnswerUncertain ? 'transport_uncertain' : 'other',
    classifyOutcome: classifyCheckoutAnswer,
    // The starter activates a subscription in the capture path, so a paid answer waits for nothing more.
    activationPending: () => false,
    declinedAttempt: result => {
      const attemptRef = valueOf(result)?.attemptRef;
      const attempts = stored()?.attempts;
      return typeof attemptRef === 'string' && attempts && Object.hasOwn(attempts, attemptRef) ? attempts[attemptRef]! : null;
    },
  };

  return {
    bindings,
    /** The record shows an order or a create that may still arrive, so the continuation panel shows on load. */
    pending(): boolean { const record = stored(); return record?.sentAt !== undefined || record?.ordered === true; },
    /**
     * Migrates a record written before the bindings: one without a fingerprint takes `reviewed`, keeping its
     * identity and host fields. Call it right before each submit. A throwing write propagates.
     */
    adoptFingerprint(reviewed: string): void {
      const record = stored();
      if (record && record.fingerprint === undefined) options.storage.setItem(name, encode({ ...record, fingerprint: reviewed }));
    },
    /** The buyer's explicit "Start a different purchase" or "Start a new action". */
    clearLocally(): void { clearContinuationRecord({ storage }); },
    /** Clears the record only when `value` names its order as paid or cancelled; true when it did. */
    completed(value: unknown): boolean {
      const record = stored();
      if (!record?.orderRef || !isRecord(value) || (value.orderRef !== record.orderRef && value.originalOrderRef !== record.orderRef)) return false;
      if (![value.status, value.terminalStatus].some(status => status === 'paid' || status === 'cancelled')) return false;
      try { options.storage.removeItem(name); return true; } catch { return false; }
    },
  };
}
