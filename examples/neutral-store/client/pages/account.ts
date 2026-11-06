import type { PageContext } from '../context.ts';
import type { CopyKey } from '../../owned/copy.ts';
import { isRecord } from '../../shared/offer.ts';
import type { Operation } from '../../shared/api.ts';
import { routes } from '../../shared/routes.ts';
import { el, link } from '../dom.ts';
import { actionForm, nativeActions, readPanel, type FieldSpec } from '../forms.ts';
import { subscriptionEditorEntries } from '../editors/entries.ts';

export function accountPage(context: PageContext): HTMLElement {
  return el('div', {}, el('h1', {}, context.t('account')),
    el('p', {}, context.t('accountBody')),
    el('div', { class: 'actions' }, link(context.t('signIn'), routes.auth[context.locale], 'button-link'),
      link(context.t('invoices'), routes.invoices[context.locale], 'button-link secondary')),
    readPanel(context, 'account', 'account.read'),
    readPanel(context, 'orders', 'account.orders'),
    el('section', { class: 'panel' }, el('h2', {}, context.t('subscriptions')),
      el('p', {}, context.t('subscriptionInvariant')),
      subscriptionEditorEntries(context),
      subscriptionCommands(context)),
    communicationChoices(context),
    nativeActions(context, ['N5', 'N6', 'N7', 'N8', 'N9']),
    actionForm(context, { operation: 'auth.signOut', submit: 'signOut' }));
}

export function invoicesPage(context: PageContext): HTMLElement {
  return el('div', {}, el('h1', {}, context.t('orders')),
    readPanel(context, 'orders', 'account.orders'),
    actionForm(context, {
      operation: 'account.invoice', title: 'invoices', submit: 'download',
      fields: [{ name: 'orderRef', label: 'orderRef' }],
    }),
    link(context.t('account'), routes.account[context.locale]));
}

function communicationChoices(context: PageContext): HTMLElement {
  return el('section', { class: 'panel' }, el('h2', {}, context.t('communication')),
    ...(['newsletter', 'offersConsent'] as const).map(purpose => el('section', {},
      el('h3', {}, context.t(purpose)),
      ...([true, false] as const).map(granted => actionForm(context, {
        operation: 'account.consent', submit: granted ? 'grant' : 'withdraw',
        input: () => ({ purpose: purpose === 'newsletter' ? 'marketing_newsletter' : 'marketing_launch_offer',
          granted, policyVersion: context.config.legal.revision }),
      })))));
}

function subscriptionCommands(context: PageContext): HTMLElement {
  const reference: FieldSpec = { name: 'subscriptionRef', label: 'subscriptionRef' };
  const command = (title: CopyKey, action: string, fields: FieldSpec[] = []) => actionForm(context, {
    operation: 'subscription.command', title, submit: title,
    fields: [reference, ...fields], input: () => ({ action }),
  });
  return el('div', { class: 'form-grid' },
    command('reschedule', 'reschedule', [{ name: 'nextDate', label: 'nextDelivery', type: 'date' }]),
    addressForm(context, 'subscription.address'),
    actionForm(context, {
      operation: 'subscription.command', title: 'cancelSubscription', submit: 'confirmCancel',
      fields: [reference, { name: 'reason', label: 'cancelReason', type: 'textarea' },
        { name: 'confirmed', label: 'confirmCancel', type: 'checkbox' }],
      input: () => ({ action: 'cancel' }),
    }));
}

export function addressForm(context: PageContext, operation: Operation): HTMLElement {
  return actionForm(context, {
    operation, title: 'changeAddress', submit: 'save',
    resultMessage: addressOutcomeMessage,
    fields: [
      { name: 'subscriptionRef', label: 'subscriptionRef' },
      { name: 'recipientName', maxLength: context.config.purchase.inputLimits.text, label: 'firstName' },
      { name: 'line1', maxLength: context.config.purchase.inputLimits.text, label: 'address' },
      { name: 'line2', maxLength: context.config.purchase.inputLimits.text, label: 'address2', required: false },
      { name: 'postalCode', maxLength: context.config.purchase.inputLimits.postalCode, label: 'postalCode' },
      { name: 'city', maxLength: context.config.purchase.inputLimits.text, label: 'city' },
      { name: 'phone', maxLength: context.config.purchase.inputLimits.phone, label: 'phone', type: 'tel' },
    ], input: () => ({ countryCode: context.config.market.country }),
  });
}

export function addressOutcomeMessage(value: unknown): CopyKey | undefined {
  if (!isRecord(value)) return undefined;
  return value.outcome === 'applied' ? 'addressApplied'
    : value.outcome === 'applied_from_next_parcel' ? 'addressNextParcel' : undefined;
}

export function authPage(context: PageContext): HTMLElement {
  return el('div', {}, el('h1', {}, context.t('signIn')),
    el('p', {}, context.t('signInBody')),
    actionForm(context, {
      operation: 'auth.request', submit: 'sendSignIn',
      fields: [{ name: 'email', maxLength: context.config.purchase.inputLimits.email, label: 'email', type: 'email', value: 'customer@example.test' }],
    }),
    actionForm(context, {
      operation: 'auth.verify', submit: 'verifyOtp',
      fields: [{ name: 'token', label: 'otp', type: 'password', maxLength: 43 }],
    }),
    nativeActions(context, ['N10']));
}

export function callbackPage(context: PageContext): HTMLElement {
  return el('div', {}, el('h1', {}, context.t('authCallback')),
    el('p', {}, context.t('authCallbackBody')),
    actionForm(context, {
      operation: 'auth.callback', submit: 'continue',
      input: () => ({ token: context.query.get('token') ?? '', state: context.query.get('state') ?? '' }),
    }), link(context.t('account'), routes.account[context.locale]));
}
