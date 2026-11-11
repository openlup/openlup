import { createQuoteAcceptance } from '../quote-acceptance.ts';
import { authenticatedRepairPage } from '../recovery-page.ts';
import type { PageContext } from '../context.ts';
import { validateCart, isRecord } from '../../shared/offer.ts';
import { routes } from '../../shared/routes.ts';
import { append, el, link } from '../dom.ts';
import { actionForm, nativeActions } from '../forms.ts';
import { act } from '../api.ts';
import { renderValue } from '../dom.ts';
import { offerIssues } from './storefront.ts';
import { currentPurchase, rememberPurchase, visiblePurchase } from '../purchase.ts';

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
    const started = Object.freeze({ token: credential.token, orderRef: result.latestOrderRef, attemptRef: result.attemptRef });
    state.replaceChildren(renderValue(result), ...(['captured', 'refused', 'expired', 'indeterminate'] as const).map(outcome =>
      actionForm(context, { operation: 'checkout.recovery',
        submit: outcome === 'captured' ? 'simulatePaid' : outcome === 'refused' ? 'simulateDeclined' : outcome === 'expired' ? 'simulateExpired' : 'simulateIndeterminate',
        input: () => ({ ...started, action: 'simulate', outcome }), onSuccess: () => { void inspect(); } })));
  };
  const inspect = async () => {
    const recovered = credential.token ? await act('checkout.recovery', { token: credential.token, action: 'inspect' }, crypto.randomUUID()) : null;
    if (!page.isConnected) return;
    if (recovered?.ok && isRecord(recovered.value)) {
      const value = recovered.value;
      if (value.terminalStatus === 'paid') {
        state.replaceChildren(el('p', {}, context.t('recoveryPaid')), renderValue(value)); return;
      }
      if (value.recoverable === true && !value.terminalStatus && isRecord(value.recreatedAttempt)) { showStarted(value.recreatedAttempt); return; }
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
    if (!page.isConnected) return;
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
    state.replaceChildren(el('p', {}, context.t('sandboxOnly')), renderValue(result.value),
      el('h2', {}, context.t('payment')),
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
