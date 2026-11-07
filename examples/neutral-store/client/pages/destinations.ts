import type { PageContext } from '../context.ts';
import type { CopyKey } from '../../owned/copy.ts';
import { messageDestinations, routes } from '../../shared/routes.ts';
import { nativeLimits, otherLimits, releaseLimits } from '../../shared/limits.ts';
import { append, el, link } from '../dom.ts';
import { actionForm, otherRefusal, readPanel, refusedAction } from '../forms.ts';

export function returnsPage(context: PageContext): HTMLElement {
  return el('div', {}, el('h1', {}, context.t('returns')),
    el('p', {}, context.t('returnsBody')),
    el('p', {}, `${context.t('returnDays')}: ${context.config.legal.returnsDays}`),
    actionForm(context, {
      operation: 'return.request', submit: 'requestReturn',
      fields: [{ name: 'orderRef', label: 'orderRef' },
        { name: 'reasonCode', label: 'reasonCode', type: 'select', options: context.config.returns.reasons.map(choice =>
          ({ value: choice.code, text: choice.label[context.locale] })) },
        { name: 'orderItemId', label: 'orderItemRef' }, { name: 'quantity', label: 'quantity', type: 'number', min: 1 },
        { name: 'note', label: 'note', type: 'textarea', required: false }],
      transform: values => ({ orderRef: values.orderRef, reasonCode: values.reasonCode, customerNote: values.note,
        lines: [{ orderItemId: values.orderItemId, quantity: values.quantity }] }),
    }),
    el('section', { class: 'panel' },
      ...(['receiveReturn', 'restockReturn', 'refundReturn'] as const).map(key => otherRefusal(context, key))),
    link(context.t('terms'), routes.terms[context.locale]));
}

export function termsPage(context: PageContext): HTMLElement {
  return el('article', { class: 'prose' }, el('h1', {}, context.t('terms')),
    el('p', {}, context.t('termsBody')),
    el('p', {}, context.t('termsOwn')),
    el('h2', {}, context.t('privacy')),
    el('p', {}, context.t('privacyBody')),
    el('h2', {}, context.t('subscription')),
    el('p', {}, context.t('subscriptionInvariant')),
    el('p', {}, context.t('sandboxOnly')),
    link(context.t('limits'), routes.limits[context.locale]),
    el('h2', {}, context.t('returns')),
    link(context.t('returns'), routes.returns[context.locale]));
}

export function reviewPage(context: PageContext): HTMLElement {
  const grant = context.query.get('grant') ?? '';
  return el('div', {}, el('h1', {}, context.t('review')),
    el('p', {}, context.t('reviewBody')),
    readPanel(context, 'review', 'review.read', { grant }),
    actionForm(context, {
      operation: 'review.submit', submit: 'submitReview',
      fields: [
        { name: 'grant', label: 'reviewGrant', value: grant, maxLength: 1024 },
        { name: 'rating', label: 'rating', type: 'number', min: 1, max: 5, value: '5' },
        { name: 'comment', label: 'comment', type: 'textarea', required: false },
      ],
    }), otherRefusal(context, 'reviewMedia'));
}

export function unsubscribePage(context: PageContext): HTMLElement {
  if (context.route.key === 'legacyUnsubscribe') {
    return el('div', {}, el('h1', {}, context.t('legacyUnsubscribe')),
      el('p', {}, context.t('legacyBody')), otherRefusal(context, 'legacyUnsubscribe'));
  }
  return el('div', {}, el('h1', {}, context.t('unsubscribe')),
    el('p', {}, context.t('unsubscribeBody')),
    actionForm(context, {
      operation: 'unsubscribe.apply', submit: 'unsubscribeAction',
      input: () => ({ token: context.query.get('token') ?? '' }),
    }));
}

export function supportPage(context: PageContext): HTMLElement {
  return el('div', {}, el('h1', {}, context.t('support')),
    el('p', {}, context.t('supportBody')),
    el('p', { 'data-support-contact': '' }, context.config.supportEmail ?? context.t('supportContactAbsent')),
    link(context.t('account'), routes.account[context.locale]));
}

export function trackingPage(context: PageContext): HTMLElement {
  return el('div', {}, el('h1', {}, context.t('tracking')),
    el('p', {}, context.t('trackingBody')),
    actionForm(context, {
      operation: 'tracking.read', submit: 'lookup',
      fields: [{ name: 'shipmentRef', label: 'shipmentRef', value: context.query.get('shipment') ?? '' }],
      input: () => ({ grant: context.query.get('grant') ?? '' }),
    }));
}

const destinationLabels: Record<string, CopyKey> = {
  builder: 'builder', account: 'account', repair: 'repair', completion: 'completion',
  returns: 'returns', terms: 'terms', invoices: 'invoices', admin: 'admin',
  unsubscribe: 'unsubscribe', legacyUnsubscribe: 'legacyUnsubscribe', auth: 'signIn',
  support: 'support', tracking: 'tracking', review: 'review',
};

export function destinationsPage(context: PageContext): HTMLElement {
  const list = el('table', {}, el('thead', {}, el('tr', {},
    el('th', { scope: 'col' }, context.t('actionRef')),
    el('th', { scope: 'col' }, context.t('languageEnglish')), el('th', { scope: 'col' }, context.t('languagePolish')))));
  const body = el('tbody');
  for (const destination of messageDestinations) {
    append(body, el('tr', {}, el('th', { scope: 'row' }, destination.id),
      ...(['en', 'pl'] as const).map(locale => el('td', {},
        link(context.t(destinationLabels[destination.route] ?? 'open'),
          routes[destination.route][locale] + (destination.query ? `?${destination.query}` : '') + (destination.hash ? `#${destination.hash}` : ''))))));
  }
  append(list, body);
  return el('div', {}, el('h1', {}, context.t('destinations')),
    el('p', {}, context.t('destinationsBody')), el('div', { class: 'table-wrap' }, list));
}

export function limitsPage(context: PageContext): HTMLElement {
  const table = el('table', {}, el('thead', {}, el('tr', {},
    el('th', { scope: 'col' }, context.t('limitAction')),
    el('th', { scope: 'col' }, context.t('limitCode')),
    el('th', { scope: 'col' }, context.t('limitReason')))));
  const body = el('tbody');
  for (const limit of nativeLimits) {
    append(body, el('tr', {},
      el('th', { scope: 'row' }, limit.id, ...limit.actions.map(action => refusedAction(context, action))),
      el('td', {}, el('code', {}, limit.code)), el('td', {}, limit.explanation[context.locale])));
  }
  for (const [key, code] of Object.entries(otherLimits)) {
    append(body, el('tr', {}, el('th', { scope: 'row' }, context.t(key as CopyKey)),
      el('td', {}, el('code', {}, code)), el('td', {}, context.t('notSubmitted'))));
  }
  append(table, body);
  return el('div', {}, el('h1', {}, context.t('limits')),
    el('p', { class: 'notice' }, context.t('sandboxOnly')),
    ...releaseLimits.map(key => el('p', {}, context.t(key))),
    el('div', { class: 'table-wrap' }, table),
    readPanel(context, 'bindingStatus', 'application.status'));
}
