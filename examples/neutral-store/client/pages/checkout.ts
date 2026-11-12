import { createQuoteAcceptance } from '../quote-acceptance.ts';
import { authenticatedRepairPage } from '../recovery-page.ts';
import type { PageContext } from '../context.ts';
import { validateCart, isRecord } from '../../shared/offer.ts';
import { routes } from '../../shared/routes.ts';
import { append, el, link, button } from '../dom.ts';
import { actionForm, nativeActions } from '../forms.ts';
import { act } from '../api.ts';
import { renderValue } from '../dom.ts';
import { offerIssues } from './storefront.ts';
import { currentPurchase, rememberPurchase, visiblePurchase } from '../purchase.ts';

// Confirmation survives panel remounts; it never suppresses the resend control.
let buyerLinkSent = false;
export function isEmbeddedCheckoutBrowser(userAgent = navigator.userAgent): boolean {
  return ['FBAN/','FB_IAB/','Instagram'].some(marker => userAgent.includes(marker));
}
function buyerLinkControl(context: PageContext): HTMLElement {
  const status = el('p', { role: 'status' }, buyerLinkSent ? context.t('buyerLinkSent') : '');
  const control = button(context.t(buyerLinkSent ? 'buyerLinkResend' : 'buyerLinkSend'), async () => {
    if (control.disabled) return; control.disabled = true;
    const result = await act('checkout.paymentLink', {}, crypto.randomUUID());
    control.disabled = false;
    if (!section.isConnected) return;
    if (result.ok) { buyerLinkSent = true; status.textContent = context.t('buyerLinkSent'); control.textContent = context.t('buyerLinkResend'); }
    else status.textContent = context.t('buyerLinkFailed');
  });
  const section = el('section', { 'data-buyer-link': '', 'aria-label': context.t('buyerLinkPrompt') },
    el('p', {}, context.t('buyerLinkPrompt')), status, control);
  return section;
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
  append(page, el('div', { class: 'checkout-layout' },
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
        { name: 'termsAccepted', label: 'termsAccept', type: 'checkbox' },
      ],
      input: quote.input,
      prepare: quote.prepare,
      onFailure: quote.refused,
      display: visiblePurchase,
      onSuccess: value => {
        if (!isRecord(value) || typeof value.orderRef !== 'string') return;
        rememberPurchase(context.config.id, value);
        continuation.replaceChildren(link(context.t('completion'),
          routes.completion[context.locale], 'button-link'));
      },
    }); quote.attach(form); return form; })(), summary),
    continuation,
    el('section', { class: 'panel' }, link(context.t('terms'), routes.terms[context.locale])),
    nativeActions(context, ['N1', 'N6']));
  return page;
}

export function completionPage(context: PageContext): HTMLElement {
  const state = el('section', { class: 'panel', 'aria-live': 'polite' }, el('p', {}, context.t('loading')));
  const page = el('div', {}, el('h1', {}, context.t('completion')), state,
    link(context.t('account'), routes.account[context.locale]));
  const credential = Object.freeze({ ...currentPurchase(context.config.id) });
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
        ...forms, ...(value.continuationAvailable === true && isEmbeddedCheckoutBrowser() ? [buyerLinkControl(context)] : []));
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
      state.replaceChildren(el('p', {}, context.t('recoveryPaid')), renderValue(result.value));
      return;
    }
    if (result.value.status !== 'pending_payment') {
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
      ...(value?.continuationAvailable === true && isEmbeddedCheckoutBrowser() ? [buyerLinkControl(context)] : []),
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
