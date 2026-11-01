import type { PageContext } from '../context.ts';
import type { ActionInput } from '../../shared/api.ts';
import { evaluateOffer, isRecord } from '../../shared/offer.ts';
import { routes } from '../../shared/routes.ts';
import { append, el, link } from '../dom.ts';
import { actionForm, nativeActions, readPanel } from '../forms.ts';
import { offerIssues } from './storefront.ts';

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
        { name: 'firstName', label: 'firstName', value: 'Demo' },
        { name: 'lastName', label: 'lastName', value: 'Customer' },
        { name: 'email', label: 'email', type: 'email', value: 'customer@example.test' },
        { name: 'phone', label: 'phone', type: 'tel', value: '+48500100200' },
        { name: 'line1', label: 'address', value: 'Example Street 1' },
        { name: 'line2', label: 'address2', required: false },
        { name: 'city', label: 'city', value: 'Example City' },
        { name: 'postalCode', label: 'postalCode', value: '00-001' },
        { name: 'termsAccepted', label: 'termsAccept', type: 'checkbox' },
      ],
      input: () => ({ cart: context.getCart(), configuration: context.config.id,
        country: context.config.market.country, termsRevision: context.config.legal.revision }),
      onSuccess: value => {
        if (!isRecord(value) || typeof value.orderRef !== 'string' || typeof value.accessGrant !== 'string') return;
        const query = new URLSearchParams({ order: value.orderRef, grant: value.accessGrant });
        continuation.replaceChildren(link(context.t('completion'),
          `${routes.completion[context.locale]}?${query}`, 'button-link'));
      },
    }), context.fragments.checkoutSummary(context, result.quote)),
    continuation,
    el('section', { class: 'panel' }, link(context.t('terms'), routes.terms[context.locale]),
      el('p', {}, context.config.copy.shippingNote[context.locale])),
    nativeActions(context, ['N1', 'N6']));
  return page;
}

export function completionPage(context: PageContext): HTMLElement {
  const reference = context.query.get('order') ?? '';
  const grant = context.query.get('grant') ?? '';
  const input = (): ActionInput => ({ orderRef: reference, accessGrant: grant });
  return el('div', {}, el('h1', {}, context.t('completion')),
    el('p', {}, context.t('completionBody')),
    el('p', { class: 'notice' }, context.t('sandboxOnly')),
    readPanel(context, 'order', 'checkout.read', input()),
    el('section', { class: 'panel' }, el('h2', {}, context.t('payment')),
      ...(['succeeded', 'declined', 'expired'] as const).map(outcome =>
        actionForm(context, {
          operation: 'payment.simulate',
          submit: outcome === 'succeeded' ? 'simulatePaid' : outcome === 'declined' ? 'simulateDeclined' : 'simulateExpired',
          input: () => ({ ...input(), outcome }),
        }))),
    link(context.t('account'), routes.account[context.locale]));
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
