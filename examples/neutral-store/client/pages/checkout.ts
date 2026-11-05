import type { PageContext } from '../context.ts';
import { evaluateOffer, isRecord } from '../../shared/offer.ts';
import { routes } from '../../shared/routes.ts';
import { append, el, link } from '../dom.ts';
import { actionForm, nativeActions } from '../forms.ts';
import { act } from '../api.ts';
import { renderValue } from '../dom.ts';
import { offerIssues } from './storefront.ts';
import { currentPurchase, rememberPurchase, visiblePurchase } from '../purchase.ts';

export function checkoutPage(context: PageContext): HTMLElement {
  const result = evaluateOffer(context.config, context.getCart());
  const page = el('div', {}, el('h1', {}, context.t('checkout')),
    el('p', { class: 'notice' }, context.t('sandboxOnly')),
    el('p', {}, context.t('demoContact')));
  if (!result.ok) {
    append(page, offerIssues(context, result), link(context.t('builder'), routes.builder[context.locale]));
    return page;
  }
  const continuation = el('div', { 'aria-live': 'polite' });
  append(page, el('div', { class: 'checkout-layout' },
    actionForm(context, {
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
      input: () => ({ cart: context.getCart(), configuration: context.config.id,
        country: context.config.market.country, termsRevision: context.config.legal.revision }),
      display: visiblePurchase,
      onSuccess: value => {
        if (!isRecord(value) || typeof value.orderRef !== 'string') return;
        rememberPurchase(context.config.id, value);
        continuation.replaceChildren(link(context.t('completion'),
          routes.completion[context.locale], 'button-link'));
      },
    }), context.fragments.checkoutSummary(context, result.quote)),
    continuation,
    el('section', { class: 'panel' }, link(context.t('terms'), routes.terms[context.locale]),
      el('p', {}, context.config.copy.shippingNote[context.locale])),
    nativeActions(context, ['N1', 'N6']));
  return page;
}

export function completionPage(context: PageContext): HTMLElement {
  const state = el('section', { class: 'panel', 'aria-live': 'polite' }, el('p', {}, context.t('loading')));
  const page = el('div', {}, el('h1', {}, context.t('completion')), state,
    link(context.t('account'), routes.account[context.locale]));
  const inspect = async () => {
    const result = await act('checkout.read', { ...currentPurchase(context.config.id) }, crypto.randomUUID());
    if (!page.isConnected) return;
    if (!result.ok || !isRecord(result.value)) {
      const code = result.ok ? 'starter_recovery_unavailable' : result.code;
      state.replaceChildren(el('p', {}, context.t(code === 'starter_recovery_expired' ? 'recoveryExpired'
        : code === 'starter_recovery_cancelled' ? 'recoveryCancelled' : 'recoveryUnavailable')), el('code', {}, code));
      return;
    }
    if (result.value.status === 'paid') {
      state.replaceChildren(el('p', {}, context.t('recoveryPaid')), renderValue({ status: 'paid' }));
      return;
    }
    if (result.value.status !== 'pending_payment') {
      state.replaceChildren(el('p', {}, context.t(result.value.status === 'cancelled' ? 'recoveryCancelled' : 'recoveryUnavailable')));
      return;
    }
    rememberPurchase(context.config.id, { ...currentPurchase(context.config.id), orderRef: result.value.orderRef });
    state.replaceChildren(el('p', {}, context.t('sandboxOnly')), renderValue(result.value),
      el('h2', {}, context.t('payment')),
      ...(['captured', 'refused', 'expired', 'indeterminate'] as const).map(outcome => actionForm(context, {
        operation: 'payment.simulate',
        submit: outcome === 'captured' ? 'simulatePaid' : outcome === 'refused' ? 'simulateDeclined' : outcome === 'expired' ? 'simulateExpired' : 'simulateIndeterminate',
        input: () => ({ ...currentPurchase(context.config.id), outcome }),
        onSuccess: () => { void inspect(); },
      })));
  };
  void inspect();
  return page;
}

export function repairPage(context: PageContext): HTMLElement {
  return el('div', {}, el('h1', {}, context.t('repair')),
    el('p', {}, context.t('repairBody')),
    actionForm(context, {
      operation: 'payment.recover', submit: 'repairAction',
      fields: [{ name: 'token', label: 'recoveryToken', value: context.query.get('token') ?? '', maxLength: 1024 }],
    }),
    el('p', { class: 'notice' }, context.t('subscriptionInvariant')),
    nativeActions(context, ['N6']));
}
