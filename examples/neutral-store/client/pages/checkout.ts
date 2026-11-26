import { createQuoteAcceptance } from '../quote-acceptance.ts';
import { authenticatedRepairPage } from '../recovery-page.ts';
import type { PageContext } from '../context.ts';
import { validateCart, isRecord } from '../../shared/offer.ts';
import { routes } from '../../shared/routes.ts';
import type { ActionResult } from '../../shared/api.ts';
import { checkoutContinuationCopy, checkoutStateCopy } from '../../shared/limits.ts';
import {
  CheckoutAnswerUncertain, CheckoutStorageUnavailable, checkoutRecordKey, classifyCheckoutAnswer, createCheckoutBindings, storageAvailable,
  type CheckoutPayload, type CheckoutRequest, type CheckoutStorage,
} from '../../shared/storefront-bindings.ts';
import { append, el, link, button } from '../dom.ts';
import { actionForm, nativeActions, refusal } from '../forms.ts';
import { act, uncertainAction } from '../api.ts';
import { renderValue } from '../dom.ts';
import { offerIssues } from './storefront.ts';
import { continuationMessage, currentPurchase, forgetPurchase, rememberPurchase, visiblePurchase,
  type CheckoutContinuationText } from '../purchase.ts';
import { embeddedCheckoutBrowserMarkers } from '../../owned/quote-copy.ts';
import { createPurchaseContinuation, storefrontAnchor, type PurchaseContinuationSnapshot, type StatusReading } from '@openlup/platform/storefront';

/** The checkout form's fields and the storefront field anchor each one carries. */
export const checkoutFieldAnchors = {
  firstName: storefrontAnchor.field.first_name,
  lastName: storefrontAnchor.field.last_name,
  email: storefrontAnchor.field.email,
  phone: storefrontAnchor.field.phone,
  line1: storefrontAnchor.field.address_line1,
  line2: storefrontAnchor.field.address_line2,
  city: storefrontAnchor.field.city,
  postalCode: storefrontAnchor.field.postal_code,
  termsAccepted: storefrontAnchor.field.terms_accepted,
} as const satisfies Record<string, keyof typeof storefrontAnchor.field>;

type StateAnchor = (typeof storefrontAnchor.state)[keyof typeof storefrontAnchor.state];
type CheckoutStatus = PurchaseContinuationSnapshot['status'];
const attemptAnchors = new Map<unknown, StateAnchor>([
  ['refused', storefrontAnchor.state.declined],
  ['dispatched', storefrontAnchor.state.awaiting_authority], ['indeterminate', storefrontAnchor.state.awaiting_authority],
]);
/** The state anchor of the payment-status page for a payment attempt's state; other states name none. */
export function paymentAttemptAnchor(state: unknown): StateAnchor | null {
  return attemptAnchors.get(state) ?? null;
}

/** The state anchor the checkout page's status line carries for each controller status; `null` names none. */
export const checkoutStateAnchors = {
  idle: null,
  awaiting_payment: storefrontAnchor.state.awaiting_payment,
  awaiting_authority: storefrontAnchor.state.awaiting_authority,
  details_changed: storefrontAnchor.state.details_changed,
  declined: storefrontAnchor.state.declined,
  refused: null,
  closed: null,
  paid: storefrontAnchor.state.paid,
  paid_pending_activation: storefrontAnchor.state.paid_pending_activation,
  storage_unavailable: null,
  unknown: null,
} as const satisfies Record<CheckoutStatus, StateAnchor | null>;

/** A status this version does not know reads as `unknown`. */
const knownStatus = (status: string): CheckoutStatus => Object.hasOwn(checkoutStateAnchors, status) ? status as CheckoutStatus : 'unknown';

/** The one element of a page that names its state, with visible text for each state, so a reader that measures it sees it. */
function stateLine(context: PageContext) {
  const line = el('p', { role: 'status' });
  return {
    line,
    set(anchor: StateAnchor | null) {
      if (anchor) {
        line.setAttribute(storefrontAnchor.attribute.state, anchor);
        line.textContent = checkoutStateCopy[anchor][context.locale];
      } else {
        line.removeAttribute(storefrontAnchor.attribute.state);
        line.textContent = '';
      }
    },
  };
}

// Confirmation survives panel remounts; it never suppresses the send-again control.
export function createBuyerLinkConfirmation() {
  const sentOrders = new Set<string>();
  return { wasSent: (orderRef: string) => sentOrders.has(orderRef), markSent: (orderRef: string) => { sentOrders.add(orderRef); } };
}
const buyerLinkConfirmation = createBuyerLinkConfirmation();
export function isEmbeddedCheckoutBrowser(userAgent = navigator.userAgent): boolean {
  return embeddedCheckoutBrowserMarkers.some(marker => userAgent.includes(marker));
}
function buyerLinkControl(context: PageContext, orderRef: string): HTMLElement {
  const buyerLinkSent = buyerLinkConfirmation.wasSent(orderRef);
  const status = el('p', { role: 'status' }, buyerLinkSent ? context.t('buyerLinkSent') : '');
  const control = button(context.t(buyerLinkSent ? 'buyerLinkResend' : 'buyerLinkSend'), async () => {
    if (control.disabled) return; control.disabled = true;
    const result = await act('checkout.paymentLink', {}, crypto.randomUUID());
    control.disabled = false;
    if (!section.isConnected) return;
    if (result.ok) { buyerLinkConfirmation.markSent(orderRef); status.textContent = context.t('buyerLinkSent'); control.textContent = context.t('buyerLinkResend'); }
    else status.textContent = context.t('buyerLinkFailed');
  });
  const section = el('section', { 'data-buyer-link': '', 'aria-label': context.t('buyerLinkPrompt') },
    el('p', {}, context.t('buyerLinkPrompt')), status, control);
  return section;
}

let panelCounter = 0;

/** What the page shows for one answer: its code and texts, the choices still offered and the payment link. */
export interface ContinuationView {
  code?: string;
  /** A managed text from `checkoutContinuationCopy`. */
  text?: CheckoutContinuationText;
  /** An owned order-state text. */
  copy?: 'recoveryPaid' | 'recoveryCancelled';
  /** Complete payment and start over, complete payment only, or neither. */
  choices: 'both' | 'resume' | 'none';
  /** Whether "Start a different purchase" is offered. */
  different: boolean;
  /** Whether the payment link stays or goes. */
  link: 'keep' | 'remove';
  /** No answer arrived: the code is shown as a refusal. */
  uncertain?: true;
  value?: Record<string, unknown>;
}

const managed = (code: string): CheckoutContinuationText | undefined =>
  Object.hasOwn(checkoutContinuationCopy, code) ? code as CheckoutContinuationText : undefined;
const paidStatuses: readonly unknown[] = ['paid', 'fulfillment_pending', 'fulfilled'];
/** Refusals of a create that say an order exists under the key, or that the key belongs to another sign-in state. */
const earlierOrder: readonly string[] = ['starter_checkout_changed', 'starter_checkout_in_progress', 'starter_checkout_not_abandonable',
  'starter_checkout_expired', 'starter_checkout_paid', 'starter_checkout_not_payable', 'starter_checkout_session_changed'];

/**
 * The answer table of the earlier-order panel: what a continuation answer, or a create refusal about the earlier
 * order, shows. `reading` is the abandon's reading; `ordered` is whether the record had recorded an order.
 */
export function continuationView(answer: ActionResult, reading: StatusReading | null, operation: 'create' | 'resume' | 'abandon',
  ordered: boolean): ContinuationView {
  const both = { choices: 'both', different: false, link: 'keep' } as const;
  const gone = { choices: 'none', different: false, link: 'remove' } as const;
  const notPayable = { choices: 'resume', different: true, link: 'keep', code: 'starter_checkout_not_payable', text: 'starter_checkout_not_payable' } as const;
  if (!answer.ok) {
    const code = answer.code, text = managed(code);
    const coded = { code, ...(text ? { text } : {}) };
    if (uncertainAction(answer)) return { ...both, ...coded, uncertain: true };
    if (operation === 'abandon' && code === 'starter_checkout_paid') return { ...gone, copy: 'recoveryPaid' };
    if (['starter_checkout_not_payable', 'starter_checkout_paid', 'starter_checkout_not_abandonable'].includes(code)) {
      return { choices: 'resume', different: true, link: 'keep', ...coded };
    }
    if (code === 'starter_checkout_expired') return { ...both, different: true, ...coded };
    // The record stays: the same details continue this purchase, other details need a different purchase.
    if (code === 'starter_checkout_not_found' && operation === 'resume' && !ordered) {
      return { choices: 'both', different: true, link: 'remove', code, text: 'resumeNotFound' };
    }
    return { ...both, ...coded };
  }
  const value = isRecord(answer.value) ? answer.value : undefined;
  if (!value) return both;
  if (operation === 'abandon' && typeof value.abandoned === 'boolean') {
    if (value.abandoned) return { ...gone, text: 'abandoned' };
    if (value.orderRef === undefined) {
      if (reading?.kind === 'terminal') return { ...gone, code: 'starter_checkout_not_found', text: 'starter_checkout_not_found' };
      const code = ordered ? 'starter_checkout_session_changed' : 'starter_checkout_in_progress';
      return { ...both, code, text: code };
    }
    if (paidStatuses.includes(value.status)) return { ...gone, copy: 'recoveryPaid' };
    if (value.status === 'cancelled' || value.status === 'refunded') return { ...gone, copy: 'recoveryCancelled' };
    if (value.status !== 'pending_payment') return notPayable;
    return { ...both, value };
  }
  // The pinned read behind a not payable continuation names the expired order.
  if (value.status === 'expired') return notPayable;
  // A paid or cancelled order ends the purchase: only a different purchase is left.
  if (paidStatuses.includes(value.status)) return { ...gone, different: true, copy: 'recoveryPaid' };
  if (value.status === 'cancelled' || value.status === 'refunded') return { ...gone, different: true, copy: 'recoveryCancelled' };
  if (value.status === 'pending_payment' && typeof value.token !== 'string') return { ...both, text: 'limited', value };
  return { ...both, value };
}

/** What the page last learned about the order under the record: payable, or the code that named it otherwise. */
export type KnownOrderState = 'payable' | 'starter_checkout_not_payable' | 'starter_checkout_paid' | 'starter_checkout_expired'
  | 'starter_checkout_not_abandonable';
const namedStates: readonly string[] = ['starter_checkout_not_payable', 'starter_checkout_paid', 'starter_checkout_expired', 'starter_checkout_not_abandonable'];

const paidOrder: readonly unknown[] = ['paid', 'fulfillment_pending', 'fulfilled'];

/**
 * The state an answer names for an order, with that order when the answer names it: a create, read or continuation
 * answer of the checkout page, or an answer the payment-status page reads. `null` when it names no state.
 */
export function orderStateOf(answer: ActionResult | null): { orderRef?: string; state: KnownOrderState } | null {
  if (!answer) return null;
  if (!answer.ok) {
    if (namedStates.includes(answer.code)) return { state: answer.code as KnownOrderState };
    return ['starter_checkout_changed', 'starter_checkout_in_progress'].includes(answer.code) ? { state: 'payable' } : null;
  }
  const value = isRecord(answer.value) ? answer.value : null;
  const orderRef = typeof value?.orderRef === 'string' ? value.orderRef : typeof value?.originalOrderRef === 'string' ? value.originalOrderRef : undefined;
  if (!value || orderRef === undefined) return null;
  const named = (state: KnownOrderState) => ({ orderRef, state });
  if (value.terminalStatus === 'paid') return named('starter_checkout_paid');
  if (value.terminalStatus === 'cancelled') return named('starter_checkout_not_payable');
  // The payment-status page offers a replacement only for an expired order.
  if (value.recoveryKind === 'recreate_expired') return named('starter_checkout_not_payable');
  if (typeof value.status !== 'string') return null;
  if (value.status === 'pending_payment') return named('payable');
  // An order in status `expired`, `cancelled` or `refunded` is closed: it reads as not payable, as a resume of it does.
  return named(paidOrder.includes(value.status) ? 'starter_checkout_paid' : 'starter_checkout_not_payable');
}

const orderStateName = (configuration: string) => `neutral-store:checkout-order-state:v1:${configuration}`;
function storedRecord(storage: CheckoutStorage, configuration: string): { id: string; orderRef?: string } | null {
  try {
    const record: unknown = JSON.parse(storage.getItem(checkoutRecordKey(configuration)) ?? 'null');
    return isRecord(record) && typeof record.id === 'string'
      ? { id: record.id, ...(typeof record.orderRef === 'string' ? { orderRef: record.orderRef } : {}) } : null;
  } catch { return null; }
}
/** What the page last learned about the order under the stored record, kept beside it in the same storage. */
function knownOrderState(storage: CheckoutStorage, configuration: string): KnownOrderState | null {
  const record = storedRecord(storage, configuration);
  try {
    const stored: unknown = JSON.parse(storage.getItem(orderStateName(configuration)) ?? 'null');
    return record && isRecord(stored) && stored.id === record.id && typeof stored.state === 'string' ? stored.state as KnownOrderState : null;
  } catch { return null; }
}
/**
 * Records the state an answer names for the order under the stored record; an answer about another order changes
 * nothing. When the write fails, the stale state is removed, so the next read falls back to "unknown"; if the removal
 * fails too, a later read that also fails still reads "unknown".
 */
function rememberOrderState(storage: CheckoutStorage, configuration: string, answer: ActionResult | null): void {
  const learned = orderStateOf(answer), record = storedRecord(storage, configuration);
  if (!learned || !record) return;
  if (learned.orderRef !== undefined && record.orderRef !== undefined && learned.orderRef !== record.orderRef) return;
  const key = orderStateName(configuration);
  try { storage.setItem(key, JSON.stringify({ id: record.id, state: learned.state })); }
  catch {
    try { storage.removeItem(key); } catch { /* Only the changed-details text depends on it. */ }
  }
}

/**
 * Changed details name what is known about the recorded order: an unpaid order only when it is known payable, the
 * code that named it otherwise, and, when nothing is known, that an order may exist.
 */
export function changedDetailsView(state: KnownOrderState | null): ContinuationView {
  if (state === 'payable') return { choices: 'both', different: false, link: 'keep', code: 'starter_checkout_changed', text: 'starter_checkout_changed' };
  if (state) return continuationView({ ok: false, code: state }, null, 'create', true);
  return { choices: 'both', different: true, link: 'keep', code: 'starter_checkout_changed', text: 'changedUnconfirmed' };
}

/** The earlier order of this purchase: complete its payment, cancel it, or (after some answers) start a different purchase. */
function continuationPanel(text: (key: CheckoutContinuationText) => string,
  handlers: { resume(): void; abandon(): void; different(): void }) {
  const id = `continuation-${++panelCounter}`;
  const status = el('div', { role: 'status', 'aria-live': 'polite' });
  const resume = button(text('resume'), handlers.resume);
  const abandon = button(text('abandon'), handlers.abandon, 'secondary');
  abandon.setAttribute('aria-describedby', `${id}-abandon`);
  abandon.setAttribute(storefrontAnchor.attribute.action, storefrontAnchor.action.start_over);
  const different = button(text('different'), handlers.different, 'secondary');
  different.setAttribute('aria-describedby', `${id}-different`);
  const choices = el('div', {});
  const section = el('section', { class: 'panel', tabindex: -1, 'aria-labelledby': `${id}-heading`, 'data-checkout-continuation': '' },
    el('h2', { id: `${id}-heading` }, text('heading')), el('p', {}, text('intro')), choices, status);
  const host = el('div', {});
  return {
    node: host, section, resume,
    /** Choices act on the stored key: the page offers them only while a record is stored. */
    offer(choice: ContinuationView['choices'], withDifferent: boolean) {
      choices.replaceChildren(...(choice === 'none' ? [] : [el('div', { class: 'actions' }, resume, choice === 'both' ? abandon : null),
        ...(choice === 'both' ? [el('p', { id: `${id}-abandon`, class: 'small' }, text('abandonDetail'))] : [])]),
      ...(withDifferent ? [different, el('p', { id: `${id}-different`, class: 'small' }, text('differentDetail'))] : []));
    },
    say(...nodes: Array<Node | string>) { status.replaceChildren(...nodes); },
    show(focus = false) {
      if (!section.isConnected) host.replaceChildren(section);
      if (focus) section.focus();
    },
    hide() { host.replaceChildren(); },
    busy(value: boolean) {
      for (const control of [resume, abandon, different]) control.disabled = value;
      if (value) section.setAttribute('aria-busy', 'true');
      else section.removeAttribute('aria-busy');
    },
    /** The payment link the panel shows, if any. */
    link(): HTMLAnchorElement | null { return section.isConnected ? status.querySelector('a') : null; },
    /** The resume button is on screen. */
    resumeShown(): boolean { return section.isConnected && resume.isConnected; },
  };
}

/** In-memory storage of one checkout record, seeded with the record that tab storage held, if any. */
function memoryStorage(name: string, seed: string | null): CheckoutStorage {
  const data = new Map<string, string>(seed === null ? [] : [[name, seed]]);
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: key => { data.delete(key); },
  };
}

/** The last record text tab storage held in this document, per record name. */
const remembered = new Map<string, string | null>();
/**
 * Tab storage that serves the last record it read or wrote when a later read throws, so a read failing after load
 * keeps the purchase's key. Writes and removals still throw, so a refused write is never hidden.
 */
function rememberedTabStorage(storage: CheckoutStorage): CheckoutStorage {
  return {
    getItem(key) {
      try { const value = storage.getItem(key); remembered.set(key, value); return value; }
      catch (error) { if (remembered.has(key)) return remembered.get(key)!; throw error; }
    },
    setItem(key, value) { storage.setItem(key, value); remembered.set(key, value); },
    removeItem(key) { storage.removeItem(key); remembered.set(key, null); },
  };
}

/** The managed page's bindings over `storage`; the payment-status page uses them only to settle the record. */
function pageBindings(context: PageContext, storage: CheckoutStorage,
  onContinuationAnswer?: (answer: ActionResult, reading: StatusReading | null) => void) {
  return createCheckoutBindings({
    configuration: context.config.id, storage, act, now: () => Date.now(), nextId: () => crypto.randomUUID(),
    token: () => currentPurchase(context.config.id)?.token ?? null, locale: () => context.locale,
    ...(onContinuationAnswer ? { onContinuationAnswer } : {}),
  });
}

type Checkout = ReturnType<typeof pageBindings>;
type Controller = ReturnType<typeof createPurchaseContinuation<CheckoutPayload, CheckoutRequest, ActionResult>>;
interface Instance {
  storage: CheckoutStorage;
  checkout: Checkout;
  controller: Controller;
  unsubscribe(): void;
  /** The last continuation answer this instance received, with its abandon reading. */
  answer: { answer: ActionResult; reading: StatusReading | null } | null;
  /** The last read answer this instance received, kept when the controller could not apply it. */
  read: ActionResult | null;
}

export function checkoutPage(context: PageContext): HTMLElement {
  const result = validateCart(context.config, context.getCart());
  const page = el('div', {}, el('h1', {}, context.t('checkout')),
    el('p', { class: 'notice' }, context.t('sandboxOnly')),
    el('p', {}, context.t('demoContact')));
  if (!result.ok) {
    append(page, offerIssues(context, result), link(context.t('builder'), routes.builder[context.locale]));
    return page;
  }
  const configuration = context.config.id;
  const name = checkoutRecordKey(configuration);
  const text = (key: CheckoutContinuationText) => continuationMessage(key, context.locale, context.config.purchase.attemptLimits.windowMs);
  // The payment link of the purchase, below the form.
  const links = el('div', { 'aria-live': 'polite' });
  const summary = el('div', { 'aria-live': 'polite' });
  const quote = createQuoteAcceptance(context, summary);
  const state = stateLine(context);
  const notice = el('div', {});
  let submitButton: HTMLButtonElement | null = null;
  let output: HTMLElement | null = null;
  const newAction = button(context.t('newAction'), () => { void startNew(); }, 'secondary');
  const panel = continuationPanel(text, {
    resume: () => { void choose('resume'); },
    abandon: () => { void choose('abandon'); },
    different: () => { void startDifferent(); },
  });

  // One checkout key per purchase in this tab; without tab storage the page keeps the purchase in its own memory.
  let tab: CheckoutStorage | null = null;
  try { if (storageAvailable(sessionStorage)) tab = rememberedTabStorage(sessionStorage); } catch { tab = null; }
  let instance: Instance | undefined;
  const current = (): Instance => instance!;
  /** An answer renders only while it came from the current instance of a page still on screen. */
  const live = (own: Instance) => own === instance && page.isConnected;

  function mount(storage: CheckoutStorage): void {
    instance?.unsubscribe();
    const own = { storage, answer: null, read: null } as Instance;
    own.checkout = pageBindings(context, storage, (answer, reading) => { own.answer = { answer, reading }; });
    const { transport } = own.checkout.bindings;
    own.controller = createPurchaseContinuation({ ...own.checkout.bindings, transport: { ...transport,
      read: async purchase => { own.read = null; const answer = await transport.read(purchase); own.read = answer; return answer; } } });
    own.unsubscribe = own.controller.subscribe(() => { if (own === instance) reflect(); });
    instance = own;
    void own.controller.begin();
    reflect();
  }

  function storageNotice(): void {
    notice.replaceChildren(el('p', { class: 'notice', 'data-storage-notice': '' }, el('code', {}, 'starter_storage_unavailable'), ' ',
      text('starter_storage_unavailable')), el('div', { class: 'actions' }, newAction));
  }

  /** Tab storage failed after load: the purchase moves to page memory under the same key, when the record can still be read. */
  function toMemory(): void {
    if (!tab) return;
    let seed: string | null = null, state: string | null = null;
    try { seed = tab.getItem(name); } catch { seed = null; }
    try { state = tab.getItem(stateName); } catch { state = null; }
    tab = null;
    const memory = memoryStorage(name, seed);
    if (state !== null) memory.setItem(stateName, state);
    mount(memory);
    storageNotice();
  }

  const stateName = orderStateName(configuration);
  const knownState = (storage: CheckoutStorage) => knownOrderState(storage, configuration);
  const noteState = (storage: CheckoutStorage, answer: ActionResult | null) => { rememberOrderState(storage, configuration, answer); };

  /** Whether the stored record had recorded an order, read before a command that may clear it. */
  function ordered(storage: CheckoutStorage): boolean {
    try {
      const record: unknown = JSON.parse(storage.getItem(name) ?? 'null');
      return isRecord(record) && record.ordered === true;
    } catch { return false; }
  }

  /** At most one visible element carries the continue-payment action: the payment link when one is shown, else the resume button. */
  function placeContinue(): void {
    const below = links.querySelector('a');
    const candidates = [panel.link(), below, panel.resume];
    for (const candidate of candidates) candidate?.removeAttribute(storefrontAnchor.attribute.action);
    const carrier = panel.link() ?? below ?? (panel.resumeShown() ? panel.resume : null);
    carrier?.setAttribute(storefrontAnchor.attribute.action, storefrontAnchor.action.continue_payment);
  }

  /** Renders what every snapshot carries: the state line, and busy controls. */
  function reflect(): void {
    const snapshot = current().controller.getSnapshot();
    state.set(checkoutStateAnchors[knownStatus(snapshot.status)]);
    if (submitButton) submitButton.disabled = snapshot.busy;
    newAction.disabled = snapshot.busy;
    panel.busy(snapshot.busy);
    placeContinue();
  }

  const paymentLink = () => link(context.t('completion'), routes.completion[context.locale], 'button-link');
  const tokenKnown = (orderRef: unknown) => typeof orderRef === 'string' && currentPurchase(configuration)?.orderRef === orderRef
    && typeof currentPurchase(configuration)?.token === 'string';

  /** Order-open and closed answers name their code and managed text, never "No success has been recorded." */
  function lines(view: Pick<ContinuationView, 'code' | 'text' | 'copy' | 'uncertain' | 'value'>, withLink: boolean): HTMLElement {
    if (view.uncertain || (view.code && !view.value && !view.text && !view.copy)) {
      // The panel's own status region announces it; no nested status and no "No success has been recorded."
      return el('div', { class: 'refusal' }, el('strong', {}, context.t('refusal')), el('code', {}, view.code ?? 'starter_response_invalid'),
        view.text ? el('p', {}, text(view.text)) : null);
    }
    const shown: HTMLElement[] = [];
    if (view.code) shown.push(el('code', {}, view.code));
    if (view.copy) shown.push(el('p', {}, context.t(view.copy)));
    if (view.text) shown.push(el('p', {}, text(view.text)));
    const value = view.value;
    if (value && typeof value.orderRef === 'string') {
      shown.push(el('p', { 'data-order-ref': '' }, value.orderRef));
      if (typeof value.status === 'string') shown.push(el('p', {}, value.status));
      const total = isRecord(value.total) && typeof value.total.amountMinor === 'number' ? value.total.amountMinor : undefined;
      if (total !== undefined) shown.push(el('p', { 'data-order-total': '' }, context.money(total)));
      // The order's own total comes before the way to pay it.
      if (withLink) shown.push(paymentLink());
    }
    return el('div', { class: 'continuation-answer' }, ...shown);
  }

  /** Opens the panel with the choices a view leaves, offered only while a record is stored. */
  function openPanel(view: Pick<ContinuationView, 'choices' | 'different'>, focus: boolean, ...status: Array<Node | string>): void {
    panel.offer(current().controller.getSnapshot().hasContinuation ? view.choices : 'none', view.different);
    panel.say(...status);
    panel.show(focus);
  }

  /** A payable order: remembered, and its payment link shown where this answer belongs. */
  function payable(value: Record<string, unknown>, inPanel: boolean, focus: boolean): void {
    rememberPurchase(configuration, value);
    const token = typeof value.token === 'string';
    const show = tokenKnown(value.orderRef);
    if (!inPanel) {
      if (show) links.replaceChildren(paymentLink());
      else links.replaceChildren();
      return;
    }
    openPanel({ choices: 'both', different: false }, focus, lines({ ...(token ? {} : { text: 'limited' as const }), value }, show));
  }

  // The view of the last create, applied only while the form's view is current.
  let createView: (() => HTMLElement | null | undefined) | null = null;

  async function send(payload: CheckoutPayload): Promise<ActionResult | null> {
    createView = null;
    let own = current();
    if (own.controller.getSnapshot().busy) return null;
    try { own.checkout.adoptFingerprint(payload.reviewed); }
    catch {
      toMemory();
      own = current();
      own.checkout.adoptFingerprint(payload.reviewed);
    }
    const before = own.controller.getSnapshot().result;
    const known = knownState(own.storage);
    const { accepted, snapshot } = await own.controller.submit({ payload });
    const error = snapshot.error;
    const applied = accepted && (snapshot.source === 'submit' || snapshot.source === 'replay') && snapshot.result !== null
      && snapshot.result !== before;
    const answer = !accepted ? null : error instanceof CheckoutAnswerUncertain ? error.answer : applied ? snapshot.result : null;
    noteState(own.storage, answer);
    if (!live(own)) return answer;
    const status = knownStatus(snapshot.status);
    if (error instanceof CheckoutStorageUnavailable || status === 'storage_unavailable') {
      // Nothing was sent: tab storage refused a write. The purchase moves to page memory under the same key.
      toMemory();
      createView = () => el('div', { class: 'refusal' }, el('strong', {}, context.t('refusal')),
        el('code', {}, 'starter_checkout_storage_unavailable'), el('p', {}, text('starter_checkout_storage_unavailable')));
      return null;
    }
    if (!accepted) {
      // A paid purchase takes no further submit until the buyer starts a different purchase.
      if (snapshot.outcome === 'settled' && !snapshot.busy) {
        createView = () => {
          links.replaceChildren();
          openPanel({ choices: 'none', different: true }, true);
          return lines({ code: 'starter_checkout_paid', text: 'starter_checkout_paid' }, false);
        };
      }
      return null;
    }
    const value = answer?.ok && isRecord(answer.value) ? answer.value : null;
    const views: Record<CheckoutStatus, () => HTMLElement | null | undefined> = {
      idle: () => undefined,
      details_changed: () => {
        const view = changedDetailsView(known);
        openPanel(view, true);
        return lines(view, false);
      },
      awaiting_payment: () => {
        if (!value) return undefined;
        const token = typeof value.token === 'string';
        if (snapshot.source === 'submit' && token) {
          payable(value, false, false);
          panel.hide();
          return undefined;
        }
        if (token) { payable(value, true, true); return undefined; }
        // Without a token the order is shown with the request-limit text; the link stays only for a known token.
        rememberPurchase(configuration, value);
        if (tokenKnown(value.orderRef)) links.replaceChildren(paymentLink());
        else links.replaceChildren();
        openPanel({ choices: 'both', different: false }, true);
        return lines({ text: 'limited', value }, false);
      },
      awaiting_authority: () => views.awaiting_payment(),
      declined: () => views.awaiting_payment(),
      paid: () => {
        links.replaceChildren();
        openPanel({ choices: 'none', different: true }, true);
        return lines({ copy: 'recoveryPaid', ...(value ? { value } : {}) }, false);
      },
      paid_pending_activation: () => views.paid(),
      closed: () => {
        links.replaceChildren();
        openPanel({ choices: 'none', different: false }, true, el('p', {}, context.t('recoveryCancelled')));
        return undefined;
      },
      refused: () => answer && !answer.ok ? refusal(context, answer.code, managed(answer.code) ? text(managed(answer.code)!) : undefined) : undefined,
      storage_unavailable: () => undefined,
      unknown: () => {
        if (!answer) return null;
        if (uncertainAction(answer)) {
          // No answer arrived and the one repeat failed too: the transport code, with the panel open.
          openPanel({ choices: 'both', different: false }, true);
          return undefined;
        }
        if (!answer.ok && earlierOrder.includes(answer.code)) {
          const view = continuationView(answer, null, 'create', false);
          if (view.link === 'remove') links.replaceChildren();
          openPanel(view, true);
          return lines(view, false);
        }
        if (!answer.ok) return refusal(context, answer.code, managed(answer.code) ? text(managed(answer.code)!) : undefined);
        return undefined;
      },
    };
    createView = views[status];
    return answer;
  }

  async function choose(action: 'resume' | 'abandon'): Promise<void> {
    const own = current();
    const before = own.controller.getSnapshot();
    if (before.busy) return;
    own.answer = null;
    const hadOrder = ordered(own.storage);
    panel.say(el('p', {}, context.t('loading')));
    let snapshot: PurchaseContinuationSnapshot<ActionResult>;
    let moved = false;
    try {
      snapshot = (action === 'resume' ? await own.controller.resume() : await own.controller.startOver()).snapshot;
    } catch {
      if (!live(own)) return;
      // Only a storage failure rejects a command here: the purchase moves to page memory, and the answer still shows.
      // A terminal start-over answer ended the purchase, so its record does not move with it.
      toMemory();
      moved = true;
      // So did a read answering the order paid or cancelled.
      const read = own.read as ActionResult | null;
      const terminal = (own.answer as Instance['answer'])?.reading?.kind === 'terminal'
        || (action === 'resume' && read !== null && ['settled', 'closed'].includes(classifyCheckoutAnswer(read)));
      if (terminal) { current().checkout.clearLocally(); mount(current().storage); }
      if (action === 'resume' && read !== null) own.answer = { answer: read, reading: null };
      snapshot = before;
    }
    if (!page.isConnected || (!moved && own !== instance)) return;
    const received = own.answer as Instance['answer'];
    let view: ContinuationView;
    const applied = action === 'resume' && snapshot.source === 'read' && snapshot.result !== null && snapshot.result !== before.result;
    if (applied) {
      const answer = snapshot.result!;
      const value = answer.ok && isRecord(answer.value) ? answer.value : undefined;
      const status = knownStatus(snapshot.status);
      const payableView = () => {
        if (!value) return continuationView(answer, null, 'resume', hadOrder);
        rememberPurchase(configuration, value);
        return { choices: 'both', different: false, link: 'keep', ...(typeof value.token === 'string' ? {} : { text: 'limited' }), value } as ContinuationView;
      };
      const byStatus: Record<CheckoutStatus, () => ContinuationView> = {
        awaiting_payment: payableView, awaiting_authority: payableView, declined: payableView,
        paid: () => ({ ...continuationView(answer, null, 'resume', hadOrder), ...(value ? { value } : {}) }),
        paid_pending_activation: () => byStatus.paid(),
        closed: () => ({ ...continuationView(answer, null, 'resume', hadOrder), ...(value ? { value } : {}) }),
        idle: () => continuationView(answer, null, 'resume', hadOrder),
        details_changed: () => continuationView(answer, null, 'resume', hadOrder),
        refused: () => continuationView(answer, null, 'resume', hadOrder),
        storage_unavailable: () => continuationView(answer, null, 'resume', hadOrder),
        unknown: () => continuationView(answer, null, 'resume', hadOrder),
      };
      view = byStatus[status]();
    } else if (received) {
      view = continuationView(received.answer, received.reading, action, hadOrder);
      if (received.answer.ok && isRecord(received.answer.value) && received.answer.value.abandoned === true
        && typeof received.answer.value.orderRef === 'string') forgetPurchase(configuration, received.answer.value.orderRef);
    } else {
      panel.say();
      reflect();
      return;
    }
    noteState(current().storage, applied ? snapshot.result : received?.answer ?? null);
    if (view.link === 'remove') links.replaceChildren();
    const withLink = view.link !== 'remove' && view.value !== undefined && tokenKnown(view.value.orderRef);
    openPanel(view, false, lines(view, withLink));
    // The pressed button may be gone; focus stays in the panel that holds the answer.
    panel.section.focus();
    reflect();
  }

  /** "Start a different purchase": the record of the earlier purchase is cleared, and the next submit places a new order. */
  async function startDifferent(): Promise<void> {
    const own = current();
    const snapshot = own.controller.getSnapshot();
    if (snapshot.busy) return;
    if (snapshot.outcome === 'settled') {
      // A paid purchase already cleared its record: starting over sends nothing and readies the form.
      await own.controller.startOver();
      if (!live(own)) return;
    } else {
      try { own.checkout.clearLocally(); }
      catch { toMemory(); current().checkout.clearLocally(); }
      mount(current().storage);
    }
    links.replaceChildren();
    panel.offer('none', false);
    panel.say(el('p', {}, text('differentStarted')));
    panel.section.focus();
    reflect();
  }

  /** "Start a new action" in the storage notice: a new purchase in page memory. */
  function startNew(): void {
    const own = current();
    if (own.controller.getSnapshot().busy) return;
    own.checkout.clearLocally();
    mount(own.storage);
    links.replaceChildren();
    panel.hide();
    output?.replaceChildren();
  }

  mount(tab ?? memoryStorage(name, null));
  if (!tab) storageNotice();
  append(page, notice, el('div', { class: 'checkout-layout' },
    (() => { const form = actionForm(context, {
      send, submit: 'placeOrder', submitAnchor: storefrontAnchor.action.place_order,
      fields: [
        { name: 'firstName', anchor: checkoutFieldAnchors.firstName, maxLength: context.config.purchase.inputLimits.name, label: 'firstName', value: context.t('demoFirstName') },
        { name: 'lastName', anchor: checkoutFieldAnchors.lastName, maxLength: context.config.purchase.inputLimits.name, label: 'lastName', value: context.t('demoCustomer') },
        { name: 'email', anchor: checkoutFieldAnchors.email, maxLength: context.config.purchase.inputLimits.email, label: 'email', type: 'email', value: 'customer@example.test' },
        { name: 'phone', anchor: checkoutFieldAnchors.phone, maxLength: context.config.purchase.inputLimits.phone, label: 'phone', type: 'tel', value: '+48500100200' },
        { name: 'line1', anchor: checkoutFieldAnchors.line1, maxLength: context.config.purchase.inputLimits.text, label: 'address', value: context.t('demoStreet') },
        { name: 'line2', anchor: checkoutFieldAnchors.line2, maxLength: context.config.purchase.inputLimits.text, label: 'address2', required: false },
        { name: 'city', anchor: checkoutFieldAnchors.city, maxLength: context.config.purchase.inputLimits.text, label: 'city', value: context.t('demoCity') },
        { name: 'postalCode', anchor: checkoutFieldAnchors.postalCode, maxLength: context.config.purchase.inputLimits.postalCode, label: 'postalCode', value: '00-001' },
        { name: 'termsAccepted', anchor: checkoutFieldAnchors.termsAccepted, label: 'termsAccept', type: 'checkbox', required: false },
      ],
      input: quote.input,
      prepare: quote.prepare,
      onRefusal: quote.refused,
      display: visiblePurchase,
      answerView: () => {
        const view = createView;
        createView = null;
        const shown = view?.();
        reflect();
        return shown;
      },
    }); quote.attach(form); submitButton = form.querySelector('button[type="submit"]'); output = form.querySelector('.action-result'); return form; })(), summary),
    state.line, links, panel.node,
    el('section', { class: 'panel' }, link(context.t('terms'), routes.terms[context.locale])),
    nativeActions(context, ['N1', 'N6']));
  // Opens the panel on load, without moving focus, when the record shows an order or an uncertain create.
  if (current().checkout.pending()) openPanel({ choices: 'both', different: false }, false);
  reflect();
  return page;
}

export function completionPage(context: PageContext): HTMLElement {
  const state = el('section', { class: 'panel', 'aria-live': 'polite' }, el('p', {}, context.t('loading')));
  // The one element that names the payment state: a sibling of the section that holds the forms, never around a form.
  const line = stateLine(context);
  const page = el('div', {}, el('h1', {}, context.t('completion')), line.line, state,
    link(context.t('account'), routes.account[context.locale]));
  const showState = (anchor: StateAnchor | null, ...nodes: Array<Node | string>) => {
    line.set(anchor);
    state.replaceChildren(...nodes);
  };
  const credential = Object.freeze({ ...currentPurchase(context.config.id) });
  // Only a host status naming the order under the checkout key as paid or cancelled ends that key; an expired order
  // keeps it, because a payment under it may still settle. A browser return settles nothing.
  const tabStorage = (): CheckoutStorage | null => { try { return rememberedTabStorage(sessionStorage); } catch { return null; } };
  const settled = (value: unknown) => {
    const storage = tabStorage();
    if (storage) pageBindings(context, storage).completed(value);
  };
  // Every order state this page reads is kept for the checkout page, through the same helper as its own answers.
  const learned = (value: unknown) => {
    const storage = tabStorage();
    if (storage) rememberOrderState(storage, context.config.id, { ok: true, value });
  };
  const showStarted = (result: unknown) => {
    if (!isRecord(result) || typeof result.latestOrderRef !== 'string' || typeof result.attemptRef !== 'string') return;
    if (result.state === 'captured') { showState(null, el('p', {}, context.t('loading'))); void inspect(); return; }
    const started = Object.freeze({ token: credential.token, orderRef: result.latestOrderRef, attemptRef: result.attemptRef });
    showState(paymentAttemptAnchor(result.state), renderValue(result), ...(result.state==='refused' && result.canTokenPay===true ? [freshPay({orderRef:result.latestOrderRef,token:credential.token}, true)] : []), ...(['captured', 'refused', 'expired', 'indeterminate'] as const).map(outcome =>
      actionForm(context, { operation: 'checkout.recovery',
        submit: outcome === 'captured' ? 'simulatePaid' : outcome === 'refused' ? 'simulateDeclined' : outcome === 'expired' ? 'simulateExpired' : 'simulateIndeterminate',
        input: () => ({ ...started, action: 'simulate', outcome }), onSuccess: () => { void inspect(); } })));
  };
  // After a refused attempt, paying again is the buyer's retry; the first payment is not.
  const freshPay = (inspected: {orderRef?: unknown;token?: string | undefined}, retry = false) => actionForm(context, { operation: 'checkout.tokenPay', submit: 'recoveryPay',
      ...(retry ? { submitAnchor: storefrontAnchor.action.retry_payment } : {}),
      fields: [{ name: 'methodKey', label: 'sandboxChoice', type: 'select', options: [
        { value: 'primary', text: context.t('sandboxPrimary') }, { value: 'secondary', text: context.t('sandboxSecondary') }] }],
      input: () => ({ token: inspected.token, executionRail: 'sandbox' }), onSuccess: () => { showState(null, el('p', {}, context.t('loading'))); void inspect(); } });
  const renderExecution = (inspected: {orderRef?: unknown;token?: string | undefined}, value: Record<string,unknown> | null): boolean => {
    if (value?.paymentBlocked === true) { showState(null, el('p', {}, context.t('recoveryUnavailable')),renderValue({orderRef:inspected.orderRef})); return true; }
    if (value && typeof value.attemptRef === 'string' && value.methodKey !== null) {
      const attemptRef = value.attemptRef;
      const forms: HTMLElement[] = [];
      if (value.state === 'refused') {
        if (value.canInlineRetry === true) {
          const retryRequestId = crypto.randomUUID();
          forms.push(actionForm(context, { operation: 'checkout.inlineRetry', submit: 'inlineRetry', submitAnchor: storefrontAnchor.action.retry_payment,
            fields: [{ name: 'methodKey', label: 'sandboxChoice', type: 'select', options: [
              { value: 'primary', text: context.t('sandboxPrimary') }, { value: 'secondary', text: context.t('sandboxSecondary') }] }],
            input: () => ({ orderRef: inspected.orderRef, expectedAttemptRef: attemptRef, retryRequestId, executionRail: 'sandbox' }),
            onSuccess: () => { void inspect(); }, onFailure: code => { if (code !== 'starter_transport_unavailable') void inspect(); } }));
        } else if (inspected.token) forms.push(freshPay(inspected, true));
      } else if (['dispatched','indeterminate'].includes(String(value.state))) {
        forms.push(...(['captured','refused','expired','indeterminate'] as const).map(outcome => actionForm(context, {
          operation: 'checkout.payment', submit: outcome === 'captured' ? 'simulatePaid' : outcome === 'refused' ? 'simulateDeclined' : outcome === 'expired' ? 'simulateExpired' : 'simulateIndeterminate',
          input: () => ({ ...inspected, action: 'simulate', attemptRef, outcome }), onSuccess: () => { void inspect(); } })));
      }
      showState(paymentAttemptAnchor(value.state), el('p', {}, context.t('sandboxOnly')), renderValue({ orderRef: inspected.orderRef, attemptRef, state: value.state }),
        ...(isRecord(value.recoveryGuidance) ? [el('section', { 'data-payment-guidance': '' }, el('h2', {}, context.t('guidanceTitle')), el('p', {}, context.t('guidanceBody')))] : []),
        ...forms, ...(value.continuationAvailable === true && typeof inspected.orderRef === 'string' && isEmbeddedCheckoutBrowser() ? [buyerLinkControl(context, inspected.orderRef)] : []));
      return true;
    }

    return false;
  };
  let inspectionGeneration = 0;
  const inspect = async () => {
    const generation = ++inspectionGeneration;
    const recovered = credential.token ? await act('checkout.recovery', { token: credential.token, action: 'inspect' }, crypto.randomUUID()) : null;
    if (!page.isConnected || generation !== inspectionGeneration) return;
    if (recovered?.ok && isRecord(recovered.value)) {
      const value = recovered.value;
      learned(value);
      if (value.terminalStatus === 'paid') {
        settled(value);
        showState(storefrontAnchor.state.paid, el('p', {}, context.t('recoveryPaid')), renderValue(value)); return;
      }
      let execution: Record<string,unknown> | null = null;
      if (!value.terminalStatus && typeof value.latestOrderRef === 'string') {
        const read=await act('checkout.payment',{action:'inspect',orderRef:value.latestOrderRef,token:credential.token},crypto.randomUUID());
        if (!page.isConnected || generation !== inspectionGeneration) return;
        execution=read.ok&&isRecord(read.value)?read.value:null;
        const admittedExecution = value.recoverable === true && value.recoveryKind !== 'recreate_expired'
          || isRecord(value.recreatedExecution) || execution?.continuationAvailable === true;
        if (admittedExecution && renderExecution({orderRef:value.latestOrderRef,token:credential.token},execution)) return;
      }
      if (!value.terminalStatus && isRecord(value.recreatedExecution) && value.recreatedExecution.state !== 'captured') { showStarted({...value.recreatedExecution,canTokenPay:execution?.canTokenPay===true}); return; }
      if (value.recoverable === true && value.recoveryKind === 'recreate_expired') {
        const pay = actionForm(context, { operation: 'checkout.recovery', submit: 'recoveryPay',
          input: () => ({ token: credential.token, action: 'pay' }),
          onSuccess: showStarted,
          onFailure: code => { showState(null, el('p', {}, context.t(code === 'starter_recovery_order_changed' ? 'recoveryChanged' : 'recoveryUnavailable')), link(context.t('builder'), routes.builder[context.locale])); },
        });
        showState(null, renderValue(value), pay); return;
      }
      if (value.terminalStatus === 'order_changed' || value.terminalStatus === 'cancelled') {
        if (value.terminalStatus === 'cancelled') settled(value);
        showState(null, el('p', {}, context.t(value.terminalStatus === 'cancelled' ? 'recoveryCancelled' : 'recoveryChanged')), renderValue(value),
          link(context.t('builder'), routes.builder[context.locale])); return;
      }
    }
    const result = await act('checkout.read', credential, crypto.randomUUID());
    if (!page.isConnected || generation !== inspectionGeneration) return;
    if (!result.ok || !isRecord(result.value)) {
      const code = result.ok ? 'starter_recovery_unavailable' : result.code;
      showState(null, el('p', {}, context.t(code === 'starter_recovery_expired' ? 'recoveryExpired'
        : code === 'starter_recovery_cancelled' ? 'recoveryCancelled' : 'recoveryUnavailable')), el('code', {}, code));
      return;
    }
    learned(result.value);
    if (result.value.status === 'paid') {
      settled(result.value);
      showState(storefrontAnchor.state.paid, el('p', {}, context.t('recoveryPaid')), renderValue(result.value));
      return;
    }
    if (result.value.status !== 'pending_payment') {
      if (result.value.status === 'cancelled' || result.value.status === 'expired') settled(result.value);
      showState(null, el('p', {}, context.t(result.value.status === 'cancelled' ? 'recoveryCancelled' : result.value.status === 'expired' ? 'recoveryExpired' : 'recoveryUnavailable')), renderValue({ orderRef: result.value.orderRef, status: result.value.status }));
      return;
    }
    const inspected = Object.freeze({ ...credential, orderRef: result.value.orderRef });
    rememberPurchase(context.config.id, inspected);
    const execution = await act('checkout.payment', { action: 'inspect', ...inspected }, crypto.randomUUID());
    if (!page.isConnected || generation !== inspectionGeneration) return;
    const value = execution.ok && isRecord(execution.value) ? execution.value : null;
    if (renderExecution(inspected,value)) return;
    showState(storefrontAnchor.state.awaiting_payment, el('p', {}, context.t('sandboxOnly')), renderValue(result.value),
      ...(isRecord(result.value.recoveryGuidance) ? [el('section', { 'data-payment-guidance': '' },
        el('h2', {}, context.t('guidanceTitle')), el('p', {}, context.t('guidanceBody')))] : []),
      el('h2', {}, context.t('payment')),
      ...(inspected.token ? [freshPay(inspected)] : []),
      ...(value?.continuationAvailable === true && typeof inspected.orderRef === 'string' && isEmbeddedCheckoutBrowser() ? [buyerLinkControl(context, inspected.orderRef)] : []),
      ...(['captured', 'refused', 'expired', 'indeterminate'] as const).map(outcome => actionForm(context, {
        operation: 'payment.simulate',
        submit: outcome === 'captured' ? 'simulatePaid' : outcome === 'refused' ? 'simulateDeclined' : outcome === 'expired' ? 'simulateExpired' : 'simulateIndeterminate',
        input: () => ({ ...inspected, outcome }),
        onSuccess: () => { void inspect(); },
      })));
  };
  void inspect();
  return page;
}

export function repairPage(context: PageContext): HTMLElement {
  return authenticatedRepairPage(context);
}
