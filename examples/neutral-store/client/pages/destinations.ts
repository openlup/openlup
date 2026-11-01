import type { PageContext } from '../context.ts';
import type { CopyKey } from '../../owned/copy.ts';
import { messageDestinations, routes } from '../../shared/routes.ts';
import { nativeLimits, otherLimits } from '../../shared/limits.ts';
import { append, el, link } from '../dom.ts';
import { actionForm, otherRefusal, readPanel, refusedAction } from '../forms.ts';

export function returnsPage(context: PageContext): HTMLElement {
  return el('div', {}, el('h1', {}, context.t('returns')),
    el('p', {}, context.t('returnsBody')),
    el('p', {}, `${context.t('returnDays')}: ${context.config.legal.returnsDays}`),
    actionForm(context, {
      operation: 'return.request', submit: 'requestReturn',
      fields: [{ name: 'orderRef', label: 'orderRef' }, { name: 'reason', label: 'returnReason', type: 'textarea' }],
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

export function inquiryPage(context: PageContext): HTMLElement {
  const support = context.route.key === 'support';
  return el('div', {}, el('h1', {}, context.t(support ? 'support' : 'inquiry')),
    el('p', {}, context.t('supportBody')),
    actionForm(context, {
      operation: 'inquiry.submit', submit: 'sendInquiry',
      fields: [
        { name: 'email', label: 'email', type: 'email', value: 'customer@example.test' },
        { name: 'subject', label: 'subject' },
        { name: 'message', label: 'message', type: 'textarea' },
      ], input: () => ({ source: support ? 'support' : 'inquiry' }),
    }));
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
  inquiry: 'inquiry', support: 'support', tracking: 'tracking', review: 'review',
};

export function destinationsPage(context: PageContext): HTMLElement {
  const list = el('table', {}, el('thead', {}, el('tr', {},
    el('th', { scope: 'col' }, context.t('actionRef')),
    el('th', { scope: 'col' }, 'English'), el('th', { scope: 'col' }, 'Polski'))));
  const body = el('tbody');
  for (const destination of messageDestinations) {
    append(body, el('tr', {}, el('th', { scope: 'row' }, destination.id),
      ...(['en', 'pl'] as const).map(locale => el('td', {},
        link(context.t(destinationLabels[destination.route] ?? 'open'),
          routes[destination.route][locale] + (destination.query ? `?${destination.query}` : ''))))));
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
    el('div', { class: 'table-wrap' }, table),
    readPanel(context, 'bindingStatus', 'application.status'));
}
