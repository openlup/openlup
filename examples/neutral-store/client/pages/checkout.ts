import { createQuoteAcceptance } from '../quote-acceptance.ts';
import { authenticatedRepairPage } from '../recovery-page.ts';
import type { PageContext } from '../context.ts';
import { validateCart, isRecord } from '../../shared/offer.ts';
import { routes } from '../../shared/routes.ts';
import { append, el, link, button } from '../dom.ts';
import { actionForm, nativeActions, refusal, type FormContinuation } from '../forms.ts';
import { act } from '../api.ts';
import { renderValue } from '../dom.ts';
import { offerIssues } from './storefront.ts';
import { checkoutContinuation, continuationMessage, currentPurchase, rememberPurchase, visiblePurchase,
  type CheckoutContinuationText, type CheckoutOutcome } from '../purchase.ts';
import { embeddedCheckoutBrowserMarkers } from '../../owned/quote-copy.ts';

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
type Continuation = ReturnType<typeof checkoutContinuation>;

/** The earlier order of this purchase: complete its payment, cancel it, or (after some answers) start a different purchase. */
function continuationPanel(context: PageContext, continuation: Continuation, links: HTMLElement, storageFailed: () => void,
  choosing: (busy: boolean) => void) {
  const text = (key: CheckoutContinuationText) => continuationMessage(key, context.locale, context.config.purchase.attemptLimits.windowMs);
  const id = `continuation-${++panelCounter}`;
  const status = el('div', { role: 'status', 'aria-live': 'polite' });
  const choose = (key: 'resume' | 'abandon') => button(text(key), () => run(key), key === 'resume' ? undefined : 'secondary');
  const resume = choose('resume'), abandon = choose('abandon');
  abandon.setAttribute('aria-describedby', `${id}-abandon`);
  const different = button(text('different'), () => {
    if (continuation.inFlight()) return;
    if (!continuation.startDifferent()) storageFailed();
    links.replaceChildren();
    // The panel stays to say what happens next; the pressed button is gone, so focus stays in the panel.
    offer(false, false);
    status.replaceChildren(el('p', {}, text('differentStarted')));
    section.focus();
  }, 'secondary');
  different.setAttribute('aria-describedby', `${id}-different`);
  const choices = el('div', {});
  const section = el('section', { class: 'panel', tabindex: -1, 'aria-labelledby': `${id}-heading`, 'data-checkout-continuation': '' },
    el('h2', { id: `${id}-heading` }, text('heading')), el('p', {}, text('intro')), choices, status);
  const host = el('div', {});
  // Choices act on the stored key, so none is offered once the record is gone.
  function offer(open: boolean, withDifferent: boolean) {
    choices.replaceChildren(...(open && continuation.current() ? [el('div', { class: 'actions' }, resume, abandon),
      el('p', { id: `${id}-abandon`, class: 'small' }, text('abandonDetail')),
      ...(withDifferent ? [different, el('p', { id: `${id}-different`, class: 'small' }, text('differentDetail'))] : [])] : []));
  }
  function show(open: boolean, focus = false) {
    if (!open) { host.replaceChildren(); return; }
    if (!section.isConnected) host.replaceChildren(section);
    if (focus) section.focus();
  }
  // While a choice or a create of this purchase is in flight in this document, the choices wait for its answer.
  function refresh() {
    const busy = continuation.inFlight();
    for (const control of [resume, abandon, different]) control.disabled = busy;
  }
  async function run(action: 'resume' | 'abandon') {
    if (continuation.inFlight()) return;
    const pending = continuation.continue(action, context.locale);
    section.setAttribute('aria-busy', 'true');
    refresh();
    choosing(true);
    status.replaceChildren(el('p', {}, context.t('loading')));
    try {
      const outcome = await pending;
      if (!outcome.stored) storageFailed();
      if (outcome.link === 'remove') links.replaceChildren();
      if (!section.isConnected) return;
      offer(outcome.choices, outcome.different);
      status.replaceChildren(message(context, outcome, text, true));
      // The pressed button may be gone; focus stays in the panel that holds the answer.
      section.focus();
    } finally {
      section.removeAttribute('aria-busy');
      refresh();
      choosing(false);
    }
  }
  return {
    node: host,
    /** Opens the panel on load, without moving focus, when the record shows an order or an uncertain create. */
    restore() { if (continuation.pending()) { offer(true, false); status.replaceChildren(); show(true); } },
    /** A create of this purchase was sent or has returned. */
    refresh,
    /** Applies a create answer: the panel opens, closes or stays. */
    created(outcome: CheckoutOutcome) {
      if (outcome.panel === 'keep') return;
      if (outcome.panel === 'close') { show(false); return; }
      offer(outcome.choices, outcome.different);
      status.replaceChildren();
      show(true, true);
    },
  };
}

/** Order-open and closed answers name their code and managed text, never "No success has been recorded." */
function message(context: PageContext, outcome: CheckoutOutcome, text: (key: CheckoutContinuationText) => string, continued: boolean): HTMLElement {
  const value = outcome.value;
  if (outcome.kind === 'noAnswer' || (outcome.kind === 'other' && !value)) {
    // The panel's own status region announces it; no nested status and no "No success has been recorded."
    return el('div', { class: 'refusal' }, el('strong', {}, context.t('refusal')), el('code', {}, outcome.code ?? 'starter_response_invalid'),
      outcome.text ? el('p', {}, text(outcome.text)) : null);
  }
  const lines: HTMLElement[] = [];
  if (outcome.code) lines.push(el('code', {}, outcome.code));
  if (outcome.copy) lines.push(el('p', {}, context.t(outcome.copy)));
  if (outcome.text) lines.push(el('p', {}, text(outcome.text)));
  if (value && typeof value.orderRef === 'string') {
    lines.push(el('p', { 'data-order-ref': '' }, value.orderRef));
    if (typeof value.status === 'string') lines.push(el('p', {}, value.status));
    const total = isRecord(value.total) && typeof value.total.amountMinor === 'number' ? value.total.amountMinor : undefined;
    if (total !== undefined) lines.push(el('p', { 'data-order-total': '' }, context.money(total)));
    // The order's own total comes before the way to pay it.
    if (continued && outcome.link === 'show') lines.push(link(context.t('completion'), routes.completion[context.locale], 'button-link'));
  }
  return el('div', { class: 'continuation-answer' }, ...lines);
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
  const continuation = el('div', { 'aria-live': 'polite' });
  const summary = el('div', { 'aria-live': 'polite' });
  const quote = createQuoteAcceptance(context, summary);
  // One checkout key per purchase in this tab; without tab storage the form keeps today's in-memory key.
  const durable = checkoutContinuation(context.config.id);
  const notice = el('div', {});
  const storageFailed = () => {
    if (notice.childElementCount) return;
    notice.replaceChildren(el('p', { class: 'notice', 'data-storage-notice': '' }, el('code', {}, 'starter_storage_unavailable'), ' ',
      continuationMessage('starter_storage_unavailable', context.locale, context.config.purchase.attemptLimits.windowMs)));
  };
  const available = durable.available();
  if (!available) storageFailed();
  let submitButton: HTMLButtonElement | null = null;
  // While a panel choice is in flight, the form sends nothing.
  const choosing = (busy: boolean) => { if (submitButton) submitButton.disabled = busy; };
  const panel = available ? continuationPanel(context, durable, continuation, storageFailed, choosing) : undefined;
  const hooks: FormContinuation | undefined = panel && {
    dispatch() { const { key, stored } = durable.dispatch(); if (!stored) storageFailed(); panel.refresh(); return key; },
    settled: (key, result) => { durable.settled(key, result); panel.refresh(); },
    busy: () => durable.inFlight(),
    answer(key, result, current) {
      const outcome = durable.answer(key, result, current);
      if (!outcome.stored) storageFailed();
      if (!current) return undefined;
      if (outcome.link === 'remove') continuation.replaceChildren();
      if (outcome.link === 'show') continuation.replaceChildren(link(context.t('completion'), routes.completion[context.locale], 'button-link'));
      panel.created(outcome);
      // A create success with a token renders as before.
      if (outcome.kind === 'open' && result.ok && outcome.link === 'show' && outcome.panel === 'close') return undefined;
      const text = (name: CheckoutContinuationText) => continuationMessage(name, context.locale, context.config.purchase.attemptLimits.windowMs);
      if (outcome.kind === 'other' && !result.ok) return refusal(context, result.code, outcome.text ? text(outcome.text) : undefined);
      if (outcome.kind === 'noAnswer' || (outcome.kind === 'other' && result.ok)) return undefined;
      return message(context, outcome, text, false);
    },
  };
  append(page, notice, el('div', { class: 'checkout-layout' },
    (() => { const form = actionForm(context, {
      operation: 'checkout.create', submit: 'placeOrder',
      fields: [
        { name: 'firstName', maxLength: context.config.purchase.inputLimits.name, label: 'firstName', value: context.t('demoFirstName') },
        { name: 'lastName', maxLength: context.config.purchase.inputLimits.name, label: 'lastName', value: context.t('demoCustomer') },
        { name: 'email', maxLength: context.config.purchase.inputLimits.email, label: 'email', type: 'email', value: 'customer@example.test' },
        { name: 'phone', maxLength: context.config.purchase.inputLimits.phone, label: 'phone', type: 'tel', value: '+48500100200' },
        { name: 'line1', maxLength: context.config.purchase.inputLimits.text, label: 'address', value: context.t('demoStreet') },
        { name: 'line2', maxLength: context.config.purchase.inputLimits.text, label: 'address2', required: false },
        { name: 'city', maxLength: context.config.purchase.inputLimits.text, label: 'city', value: context.t('demoCity') },
        { name: 'postalCode', maxLength: context.config.purchase.inputLimits.postalCode, label: 'postalCode', value: '00-001' },
        { name: 'termsAccepted', label: 'termsAccept', type: 'checkbox', required: false },
      ],
      input: quote.input,
      prepare: quote.prepare,
      onRefusal: quote.refused,
      display: visiblePurchase,
      ...(hooks ? { continuation: hooks } : { onSuccess: (value: unknown) => {
        if (!isRecord(value) || typeof value.orderRef !== 'string') return;
        rememberPurchase(context.config.id, value);
        continuation.replaceChildren(link(context.t('completion'),
          routes.completion[context.locale], 'button-link'));
      } }),
    }); quote.attach(form); submitButton = form.querySelector('button[type="submit"]'); return form; })(), summary),
    continuation, panel?.node,
    el('section', { class: 'panel' }, link(context.t('terms'), routes.terms[context.locale])),
    nativeActions(context, ['N1', 'N6']));
  panel?.restore();
  return page;
}

export function completionPage(context: PageContext): HTMLElement {
  const state = el('section', { class: 'panel', 'aria-live': 'polite' }, el('p', {}, context.t('loading')));
  const page = el('div', {}, el('h1', {}, context.t('completion')), state,
    link(context.t('account'), routes.account[context.locale]));
  const credential = Object.freeze({ ...currentPurchase(context.config.id) });
  // Only a host status for the order under the checkout key ends that key; a browser return settles nothing.
  const settled = (value: unknown) => { checkoutContinuation(context.config.id).completed(value); };
  const showStarted = (result: unknown) => {
    if (!isRecord(result) || typeof result.latestOrderRef !== 'string' || typeof result.attemptRef !== 'string') return;
    if (result.state === 'captured') { state.replaceChildren(el('p', {}, context.t('loading'))); void inspect(); return; }
    const started = Object.freeze({ token: credential.token, orderRef: result.latestOrderRef, attemptRef: result.attemptRef });
    state.replaceChildren(renderValue(result), ...(result.state==='refused' && result.canTokenPay===true ? [freshPay({orderRef:result.latestOrderRef,token:credential.token})] : []), ...(['captured', 'refused', 'expired', 'indeterminate'] as const).map(outcome =>
      actionForm(context, { operation: 'checkout.recovery',
        submit: outcome === 'captured' ? 'simulatePaid' : outcome === 'refused' ? 'simulateDeclined' : outcome === 'expired' ? 'simulateExpired' : 'simulateIndeterminate',
        input: () => ({ ...started, action: 'simulate', outcome }), onSuccess: () => { void inspect(); } })));
  };
  const freshPay = (inspected: {orderRef?: unknown;token?: string | undefined}) => actionForm(context, { operation: 'checkout.tokenPay', submit: 'recoveryPay',
      fields: [{ name: 'methodKey', label: 'sandboxChoice', type: 'select', options: [
        { value: 'primary', text: context.t('sandboxPrimary') }, { value: 'secondary', text: context.t('sandboxSecondary') }] }],
      input: () => ({ token: inspected.token, executionRail: 'sandbox' }), onSuccess: () => { state.replaceChildren(el('p', {}, context.t('loading'))); void inspect(); } });
  const renderExecution = (inspected: {orderRef?: unknown;token?: string | undefined}, value: Record<string,unknown> | null): boolean => {
    if (value?.paymentBlocked === true) { state.replaceChildren(el('p', {}, context.t('recoveryUnavailable')),renderValue({orderRef:inspected.orderRef})); return true; }
    if (value && typeof value.attemptRef === 'string' && value.methodKey !== null) {
      const attemptRef = value.attemptRef;
      const forms: HTMLElement[] = [];
      if (value.state === 'refused') {
        if (value.canInlineRetry === true) {
          const retryRequestId = crypto.randomUUID();
          forms.push(actionForm(context, { operation: 'checkout.inlineRetry', submit: 'inlineRetry',
            fields: [{ name: 'methodKey', label: 'sandboxChoice', type: 'select', options: [
              { value: 'primary', text: context.t('sandboxPrimary') }, { value: 'secondary', text: context.t('sandboxSecondary') }] }],
            input: () => ({ orderRef: inspected.orderRef, expectedAttemptRef: attemptRef, retryRequestId, executionRail: 'sandbox' }),
            onSuccess: () => { void inspect(); }, onFailure: code => { if (code !== 'starter_transport_unavailable') void inspect(); } }));
        } else if (inspected.token) forms.push(freshPay(inspected));
      } else if (['dispatched','indeterminate'].includes(String(value.state))) {
        forms.push(...(['captured','refused','expired','indeterminate'] as const).map(outcome => actionForm(context, {
          operation: 'checkout.payment', submit: outcome === 'captured' ? 'simulatePaid' : outcome === 'refused' ? 'simulateDeclined' : outcome === 'expired' ? 'simulateExpired' : 'simulateIndeterminate',
          input: () => ({ ...inspected, action: 'simulate', attemptRef, outcome }), onSuccess: () => { void inspect(); } })));
      }
      state.replaceChildren(el('p', {}, context.t('sandboxOnly')), renderValue({ orderRef: inspected.orderRef, attemptRef, state: value.state }),
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
      if (value.terminalStatus === 'paid') {
        settled(value);
        state.replaceChildren(el('p', {}, context.t('recoveryPaid')), renderValue(value)); return;
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
          onFailure: code => { state.replaceChildren(el('p', {}, context.t(code === 'starter_recovery_order_changed' ? 'recoveryChanged' : 'recoveryUnavailable')), link(context.t('builder'), routes.builder[context.locale])); },
        });
        state.replaceChildren(renderValue(value), pay); return;
      }
      if (value.terminalStatus === 'order_changed' || value.terminalStatus === 'cancelled') {
        if (value.terminalStatus === 'cancelled') settled(value);
        state.replaceChildren(el('p', {}, context.t(value.terminalStatus === 'cancelled' ? 'recoveryCancelled' : 'recoveryChanged')), renderValue(value),
          link(context.t('builder'), routes.builder[context.locale])); return;
      }
    }
    const result = await act('checkout.read', credential, crypto.randomUUID());
    if (!page.isConnected || generation !== inspectionGeneration) return;
    if (!result.ok || !isRecord(result.value)) {
      const code = result.ok ? 'starter_recovery_unavailable' : result.code;
      state.replaceChildren(el('p', {}, context.t(code === 'starter_recovery_expired' ? 'recoveryExpired'
        : code === 'starter_recovery_cancelled' ? 'recoveryCancelled' : 'recoveryUnavailable')), el('code', {}, code));
      return;
    }
    if (result.value.status === 'paid') {
      settled(result.value);
      state.replaceChildren(el('p', {}, context.t('recoveryPaid')), renderValue(result.value));
      return;
    }
    if (result.value.status !== 'pending_payment') {
      if (result.value.status === 'cancelled' || result.value.status === 'expired') settled(result.value);
      state.replaceChildren(el('p', {}, context.t(result.value.status === 'cancelled' ? 'recoveryCancelled' : result.value.status === 'expired' ? 'recoveryExpired' : 'recoveryUnavailable')), renderValue({ orderRef: result.value.orderRef, status: result.value.status }));
      return;
    }
    const inspected = Object.freeze({ ...credential, orderRef: result.value.orderRef });
    rememberPurchase(context.config.id, inspected);
    const execution = await act('checkout.payment', { action: 'inspect', ...inspected }, crypto.randomUUID());
    if (!page.isConnected || generation !== inspectionGeneration) return;
    const value = execution.ok && isRecord(execution.value) ? execution.value : null;
    if (renderExecution(inspected,value)) return;
    state.replaceChildren(el('p', {}, context.t('sandboxOnly')), renderValue(result.value),
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
