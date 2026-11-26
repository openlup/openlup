import { isRecord } from '../shared/offer.ts';
import { resolveRoute } from '../shared/routes.ts';
import type { ActionResult } from '../shared/api.ts';
import type { Locale } from '../shared/config.ts';
import { checkoutContinuationCopy } from '../shared/limits.ts';
import { act, uncertainAction } from './api.ts';
import { checkoutCreates, checkoutRecordKey, noneIsFinal, storageAvailable, type CheckoutCreateState } from '../shared/storefront-bindings.ts';

export { noneIsFinal };
export type { CheckoutCreateState };

interface Purchase { orderRef?: string; token?: string }
const memory = new Map<string, Purchase>();
const key = (configuration: string) => `neutral-store:purchase:v2:${configuration}`;
let entry: string | null = null;

/** Run synchronously at bootstrap and navigation, before rendering or query propagation. */
export function captureCompletionEntry(): void {
  if (resolveRoute(location.pathname).key !== 'completion') return;
  const query = new URLSearchParams(location.search);
  const token = query.get('token');
  if (token !== null) {
    entry = token;
    query.delete('token');
    history.replaceState(null, '', location.pathname + (query.size ? `?${query}` : '') + location.hash);
  }
}

/** Browser storage is a reload convenience. Only native inspection grants access. */
export function rememberPurchase(configuration: string, value: unknown): void {
  if (!isRecord(value)) return;
  let previous = memory.get(configuration);
  if (!previous) {
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(key(configuration)) ?? 'null');
      if (isRecord(stored)) previous = {
        ...(typeof stored.orderRef === 'string' ? { orderRef: stored.orderRef } : {}),
        ...(typeof stored.token === 'string' ? { token: stored.token } : {}),
      };
    } catch { /* Missing storage never grants access. */ }
  }
  const purchase = { ...(typeof value.orderRef === 'string' ? { orderRef: value.orderRef } : {}),
    ...(typeof value.token === 'string' ? { token: value.token }
      : typeof value.orderRef === 'string' && value.orderRef === previous?.orderRef && previous.token
        ? { token: previous.token } : {}) };
  memory.set(configuration, purchase);
  try { sessionStorage.setItem(key(configuration), JSON.stringify(purchase)); } catch { /* Memory still serves this tab. */ }
}

export function currentPurchase(configuration: string): Purchase | null {
  if (entry !== null) {
    rememberPurchase(configuration, { token: entry });
    entry = null;
  }
  const active = memory.get(configuration);
  if (active) return active;
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key(configuration)) ?? 'null');
    if (isRecord(value)) {
      rememberPurchase(configuration, value);
      return memory.get(configuration) ?? null;
    }
  } catch { /* Missing browser state never grants access. */ }
  return null;
}

export function visiblePurchase(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { token: _credential, ...visible } = value;
  return visible;
}

/** Forget the reload convenience when it is the given order; true when it was. */
export function forgetPurchase(configuration: string, orderRef: string): boolean {
  if (currentPurchase(configuration)?.orderRef !== orderRef) return false;
  memory.delete(configuration);
  try { sessionStorage.removeItem(key(configuration)); } catch { /* Memory no longer serves it. */ }
  return true;
}

/** How each checkout answer acts on the continuation record. */
export type CheckoutAnswerClass = 'noAnswer' | 'open' | 'closed' | 'none' | 'other';
/** Every `starter_*` code of the host's checkout operations, plus the answers the browser cannot read. */
export const checkoutAnswerCodes: Readonly<Record<string, CheckoutAnswerClass>> = Object.freeze({
  starter_transport_unavailable: 'noAnswer', starter_response_invalid: 'noAnswer', starter_dependency_unavailable: 'noAnswer',
  starter_checkout_changed: 'open', starter_checkout_in_progress: 'open', starter_checkout_not_abandonable: 'open', starter_checkout_expired: 'open',
  starter_checkout_paid: 'closed', starter_checkout_not_payable: 'closed',
  starter_checkout_not_found: 'none',
  starter_checkout_request_stale: 'other', starter_attempt_limited: 'other', starter_command_conflict: 'other',
  starter_input_invalid: 'other', starter_email_invalid: 'other', starter_terms_required: 'other',
  starter_purchase_unavailable: 'other', starter_quote_refresh_required: 'other', starter_quote_price_changed: 'other',
  starter_expected_total_required: 'other',
});

export interface CheckoutContinuationRecord { v: 1; id: string; sentAt?: number; ordered?: true; orderRef?: string }
type ContinuationStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type CheckoutContinuationText = keyof typeof checkoutContinuationCopy;
export interface CheckoutOutcome {
  kind: CheckoutAnswerClass | 'contradiction';
  /** The code named on screen: a host code or a client-raised one. */
  code?: string;
  /** A managed text from `checkoutContinuationCopy`. */
  text?: CheckoutContinuationText;
  /** An owned order-state text. */
  copy?: 'recoveryPaid' | 'recoveryCancelled';
  /** The panel after this answer. */
  panel: 'open' | 'close' | 'keep';
  /** Whether resume and abandon are still offered. */
  choices: boolean;
  /** Whether "Start a different purchase" is offered. */
  different: boolean;
  /** The payment link after this answer. */
  link: 'show' | 'remove' | 'keep';
  /** False when a tab-storage write failed; the answer itself still stands. */
  stored: boolean;
  value?: Record<string, unknown>;
}

const versionFour = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const closedPaid = ['paid', 'fulfillment_pending', 'fulfilled'];
const closedOther = ['cancelled', 'refunded', 'expired'];
const records = new Map<string, CheckoutContinuationRecord | null>();
/** Continuation requests in flight, per configuration, across panel remounts in this document. */
const choicesInFlight = new Map<string, number>();

/** A managed buyer text with its request-limit wait filled in. */
export function continuationMessage(text: CheckoutContinuationText, locale: Locale, windowMs: number): string {
  return checkoutContinuationCopy[text][locale].replaceAll('{minutes}', String(Math.ceil(windowMs / 60_000)));
}

function parseRecord(raw: string): CheckoutContinuationRecord | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isRecord(value) || typeof value.id !== 'string' || !versionFour.test(value.id)) return null;
  const base = { v: 1 as const, id: value.id };
  const sentAt = value.sentAt === undefined || Number.isSafeInteger(value.sentAt);
  const ordered = value.ordered === undefined || value.ordered === true;
  const orderRef = value.orderRef === undefined || (typeof value.orderRef === 'string' && value.ordered === true);
  if (value.v !== 1 || !sentAt || !ordered || !orderRef) return base;
  return { ...base, ...(typeof value.sentAt === 'number' ? { sentAt: value.sentAt } : {}),
    ...(value.ordered === true ? { ordered: true as const } : {}), ...(typeof value.orderRef === 'string' ? { orderRef: value.orderRef } : {}) };
}

/** The checkout key of one purchase in this tab. Nothing touches storage, crypto or the DOM until a method is called. */
export function checkoutContinuation(configuration: string, options: { storage?: () => ContinuationStorage; now?: () => number } = {}) {
  const storage = options.storage ?? (() => sessionStorage);
  const now = options.now ?? Date.now;
  const storageKey = checkoutRecordKey(configuration);
  const begin = () => { checkoutCreates.begin(now()); };
  const read = (): CheckoutContinuationRecord | null => {
    if (records.has(configuration)) return records.get(configuration)!;
    let raw: string | null;
    try { raw = storage().getItem(storageKey); } catch { return null; }
    const value = raw === null ? null : parseRecord(raw);
    records.set(configuration, value);
    return value;
  };
  const write = (value: CheckoutContinuationRecord): boolean => {
    records.set(configuration, value);
    try { storage().setItem(storageKey, JSON.stringify(value)); return true; } catch { return false; }
  };
  const clear = (): boolean => {
    records.set(configuration, null);
    try { storage().removeItem(storageKey); return true; } catch { return false; }
  };
  const tokenKnown = (orderRef: unknown) => typeof orderRef === 'string' && currentPurchase(configuration)?.orderRef === orderRef
    && typeof currentPurchase(configuration)?.token === 'string';

  function apply(operation: 'create' | 'resume' | 'abandon', key: string, result: ActionResult, continuationAt?: number, view = true): CheckoutOutcome {
    const created = operation === 'create';
    const outcome = (kind: CheckoutOutcome['kind'], fields: Partial<CheckoutOutcome> = {}): CheckoutOutcome => ({
      kind, panel: created ? 'keep' : 'open', choices: true, different: false, link: 'keep', stored: true, ...fields });
    const record = read();
    const own = record?.id === key ? record : null;
    const value = result.ok && isRecord(result.value) ? result.value : undefined;
    // The answer belongs to another sign-in state: the record keeps the earlier order, and the page still shows the order the host answered with.
    const contradiction = (fields: Partial<CheckoutOutcome> = {}) => outcome('contradiction', { ...fields,
      code: 'starter_checkout_session_changed', text: 'starter_checkout_session_changed', panel: 'open', choices: true, different: false });
    const otherOrder = () => own?.orderRef !== undefined && typeof value?.orderRef === 'string' && own.orderRef !== value.orderRef;
    const closed = (fields: Partial<CheckoutOutcome>) => {
      if (otherOrder()) return contradiction(fields);
      const stored = own ? clear() : true;
      return outcome('closed', { panel: created ? 'close' : 'open', choices: false, link: 'remove', stored, ...fields });
    };
    const open = (fields: Partial<CheckoutOutcome>) => {
      const orderRef = typeof value?.orderRef === 'string' ? value.orderRef : undefined;
      if (otherOrder()) return contradiction(fields.value ? { value: fields.value } : {});
      const stored = own ? write({ ...own, ordered: true, ...(orderRef ? { orderRef } : {}) }) : true;
      return outcome('open', { panel: 'open', stored, ...fields });
    };
    if (!result.ok) {
      const kind = uncertainAction(result) ? 'noAnswer' : checkoutAnswerCodes[result.code] ?? 'other';
      const code = result.code;
      const text = Object.hasOwn(checkoutContinuationCopy, code) ? code as CheckoutContinuationText : undefined;
      if (kind === 'noAnswer') return outcome('noAnswer', { code, panel: 'open' });
      if (kind === 'open') return open({ code, ...(text ? { text } : {}), different: code === 'starter_checkout_not_abandonable' || code === 'starter_checkout_expired' });
      if (kind === 'closed') return closed({ code, ...(code === 'starter_checkout_paid' && operation === 'abandon' ? { copy: 'recoveryPaid' as const } : text ? { text } : {}) });
      if (kind === 'none') return none();
      return outcome('other', { code, ...(text ? { text } : {}), stored: created ? settleRefusal() : true });
    }
    if (!value) return outcome('other');
    if (operation === 'abandon' && typeof value.abandoned === 'boolean') {
      if (value.abandoned === true && typeof value.orderRef === 'string') {
        const result = otherOrder() ? contradiction({ copy: 'recoveryCancelled', value }) : closed({ text: 'abandoned', value });
        const forgotten = forgetPurchase(configuration, value.orderRef);
        return result.kind === 'contradiction' && forgotten ? { ...result, link: 'remove' } : result;
      }
      if (value.orderRef === undefined) return none();
      if (closedPaid.includes(String(value.status))) return closed({ copy: 'recoveryPaid', value });
      if (value.status === 'cancelled') return closed({ copy: 'recoveryCancelled', value });
      if (closedOther.includes(String(value.status))) return closed({ text: 'starter_checkout_not_payable', value });
      return outcome('other', { value });
    }
    if (typeof value.orderRef === 'string' && value.status === 'paid') return closed({ copy: 'recoveryPaid', value });
    if (typeof value.orderRef === 'string' && value.status === 'pending_payment') {
      const token = typeof value.token === 'string';
      const fields: Partial<CheckoutOutcome> = { value, ...(token ? {} : { text: 'limited' as const }) };
      const result = open(fields);
      // A stale view still settles the record, but never replaces the purchase the page shows.
      if (view) rememberPurchase(configuration, value);
      const link = tokenKnown(value.orderRef) ? 'show' as const : 'remove' as const;
      if (result.kind !== 'open') return { ...result, link: link === 'show' ? 'show' : 'keep' };
      return { ...result, link, panel: created && token ? 'close' : 'open' };
    }
    return outcome('other', { value });

    /** A definite refusal of every create of this key leaves no order behind, so the record no longer asks for the panel. */
    function settleRefusal(): boolean {
      if (!own || !checkoutCreates.refusedEvery(own.id, own)) return true;
      return write({ v: 1, id: own.id });
    }

    function none(): CheckoutOutcome {
      if (own?.ordered) return contradiction();
      const at = continuationAt ?? now();
      const final = own ? checkoutCreates.final(own.id, own.sentAt, at) : true;
      if (!final) return outcome('none', { code: 'starter_checkout_in_progress', text: 'starter_checkout_in_progress' });
      const stored = own ? clear() : true;
      return outcome('none', { code: 'starter_checkout_not_found', text: 'starter_checkout_not_found', choices: false, stored });
    }
  }

  return {
    /** Checked at render: the record key can be read and tab storage accepts a write. */
    available(): boolean {
      begin();
      try { return storageAvailable(storage()); } catch { return false; }
    },
    current(): CheckoutContinuationRecord | null { begin(); return read(); },
    /** The record shows an order or an uncertain create, so the panel shows on load. */
    pending(): boolean { begin(); const record = read(); return record?.sentAt !== undefined || record?.ordered === true; },
    /** Right before a create is sent: the record and its dispatch time are stored first. */
    dispatch(): { key: string; stored: boolean } {
      begin();
      const previous = read();
      const record = { ...(previous ?? { v: 1 as const, id: crypto.randomUUID() }), sentAt: now() };
      const stored = write(record);
      checkoutCreates.dispatch(record.id, record.sentAt, previous?.sentAt);
      return { key: record.id, stored };
    },
    /** Always after a create returned, even when its view is gone. */
    settled(key: string, result?: ActionResult): void { checkoutCreates.settled(key, result, now()); },
    /** Applies a create answer to the record. `view` is false when the form's view is gone or stale. */
    answer(key: string, result: ActionResult, view = true): CheckoutOutcome { begin(); return apply('create', key, result, undefined, view); },
    /** A create or a continuation of this purchase is in flight in this document. */
    inFlight(): boolean {
      const record = read();
      return (choicesInFlight.get(configuration) ?? 0) > 0 || (record ? (checkoutCreates.state(record.id)?.inFlight ?? 0) > 0 : false);
    },
    /** Resumes or abandons the order under the stored key. */
    async continue(action: 'resume' | 'abandon', locale: string): Promise<CheckoutOutcome> {
      begin();
      const record = read();
      if (!record) return { kind: 'none', code: 'starter_checkout_not_found', text: 'starter_checkout_not_found', panel: 'open', choices: false, different: false, link: 'keep', stored: true };
      const continuationAt = now();
      choicesInFlight.set(configuration, (choicesInFlight.get(configuration) ?? 0) + 1);
      try {
        const result = await act('checkout.continuation', { action, locale }, record.id);
        return apply(action, record.id, result, continuationAt);
      } finally { choicesInFlight.set(configuration, Math.max(0, (choicesInFlight.get(configuration) ?? 1) - 1)); }
    },
    /** The buyer's explicit choice after not abandonable or expired: the next submit uses a new key. */
    startDifferent(): boolean { begin(); return clear(); },
    /** The completion page shows this order as paid, cancelled or expired. */
    completed(value: unknown): boolean {
      begin();
      const record = read();
      if (!record?.orderRef || !isRecord(value) || (value.orderRef !== record.orderRef && value.originalOrderRef !== record.orderRef)) return false;
      clear();
      return true;
    },
  };
}
