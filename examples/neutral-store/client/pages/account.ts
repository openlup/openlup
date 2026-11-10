import { rememberPurchase } from '../purchase.ts';
import { act } from '../api.ts';
import { careAvailability, saveOfferKind, saveRescheduleTarget, type CareAction, type PortalSubscription } from '../../shared/renewal-config.ts';
import { currentRecoveryToken } from '../recovery-session.ts';
import type { PageContext } from '../context.ts';
import type { CopyKey } from '../../owned/copy.ts';
import { isRecord } from '../../shared/offer.ts';
import type { Operation } from '../../shared/api.ts';
import { routes } from '../../shared/routes.ts';
import { downloadInvoice } from '../invoice-download.ts';
import { el, link, append, button, renderValue } from '../dom.ts';
import { actionForm, nativeActions, readPanel, refusal, type FieldSpec } from '../forms.ts';
import { subscriptionEditorEntries } from '../editors/entries.ts';

export function accountPage(context: PageContext): HTMLElement {
  return el('div', {}, el('h1', {}, context.t('account')),
    el('p', {}, context.t('accountBody')),
    el('div', { class: 'actions' }, link(context.t('signIn'), routes.auth[context.locale] + '?' + new URLSearchParams({ returnTo: accountReturn(context) }), 'button-link'),
      link(context.t('invoices'), routes.invoices[context.locale], 'button-link secondary')),
    readPanel(context, 'account', 'account.read'),
    orderPortal(context), profileEditor(context),
    subscriptionPortal(context),
    subscriptionEditorEntries(context),
    addressForm(context, 'subscription.address'),
    communicationChoices(context),
    nativeActions(context, ['N5', 'N6', 'N8', 'N9']),
    actionForm(context, { operation: 'auth.signOut', submit: 'signOut' }));
}

export function invoicesPage(context: PageContext): HTMLElement {
  const corrections = el('section', { 'data-invoice-corrections': '' });
  return el('div', {}, el('h1', {}, context.t('orders')),
    readPanel(context, 'orders', 'account.orders'),
    el('p', {}, context.t('sandboxInvoice')),
    actionForm(context, { operation: 'account.invoice', title: 'invoiceHistory', submit: 'read',
      fields: [{ name: 'orderRef', label: 'orderRef' }], onSuccess(value) {
        corrections.replaceChildren();
        if (!isRecord(value) || !Array.isArray(value.documents)) return;
        for (const document of value.documents) {
          if (!isRecord(document) || document.isCurrent !== true || typeof document.documentRef !== 'string') continue;
          append(corrections, actionForm(context, { operation: 'account.invoiceCorrection', title: 'invoiceCorrection', submit: 'save',
            fields: [{ name: 'reason', label: 'reason', type: 'textarea', maxLength: 500 },
              { name: 'requestedFields', label: 'correctionFields', required: false, maxLength: 500 },
              { name: 'note', label: 'note', type: 'textarea', required: false, maxLength: 500 }],
            transform: values => ({ invoiceId: document.documentRef, reason: values.reason,
              requestedFields: String(values.requestedFields).split(',').map(value => value.trim()).filter(Boolean), note: values.note || null }),
            resultMessage: () => 'correctionRecorded' }));
        }
      } }),
    corrections,
    actionForm(context, {
      operation: 'account.invoice', title: 'invoices', submit: 'download',
      fields: [{ name: 'orderRef', label: 'orderRef' }, { name: 'documentRef', label: 'documentRef' }],
      onSuccess: downloadInvoice,
      display: value => isRecord(value) ? { contentType: value.contentType, fileName: value.fileName } : value,
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
      onSuccess: () => { if (currentRecoveryToken()) context.navigate(routes.repair[context.locale]);
        else { const path = context.query.get('returnTo'); context.navigate(path && (path === routes.account[context.locale] || path.startsWith(routes.account[context.locale] + '?')) ? path : routes.account[context.locale]); } },
      fields: [{ name: 'token', label: 'otp', type: 'password', maxLength: 43 }],
    }),
    nativeActions(context, ['N10']));
}

export function callbackPage(context: PageContext): HTMLElement {
  return el('div', {}, el('h1', {}, context.t('authCallback')),
    el('p', {}, context.t('authCallbackBody')),
    actionForm(context, {
      operation: 'auth.callback', submit: 'continue',
      onSuccess: () => { if (currentRecoveryToken()) context.navigate(routes.repair[context.locale]);
        else { const path = context.query.get('returnTo'); context.navigate(path && (path === routes.account[context.locale] || path.startsWith(routes.account[context.locale] + '?')) ? path : routes.account[context.locale]); } },
      input: () => ({ token: context.query.get('token') ?? '', state: context.query.get('state') ?? '' }),
    }), link(context.t('account'), routes.account[context.locale]));
}

const labels: Record<CareAction, CopyKey> = { skip: 'careSkip', slide: 'reschedule', pause: 'carePause', resume: 'careResume',
  cancel: 'cancelSubscription', order_now: 'careOrderNow', reactivate: 'careReactivate' };
export function subscriptionPortal(context: PageContext): HTMLElement {
  const output = el('div', { 'aria-live': 'polite' });
  const section = el('section', { class: 'panel', id: 'subscriptions' }, el('h2', {}, context.t('subscriptions')),
    el('p', {}, context.t('subscriptionInvariant')));
  const target = context.query.get('sub');
  async function refresh() {
    const result = await act('account.read', {}, crypto.randomUUID());
    output.replaceChildren();
    if (!result.ok) { append(output, refusal(context, result.code)); return; }
    const data = isRecord(result.value) && isRecord(result.value.renewal) ? result.value.renewal.subscriptions : null;
    if (!Array.isArray(data) || !data.length) { append(output, el('p', {}, context.t('careMissing'))); return; }
    let found = false;
    for (const value of data) {
      if (!isRecord(value) || typeof value.subscriptionId !== 'string') continue;
      const row = value as unknown as PortalSubscription;
      const card = el('article', { class: 'panel', id: `subscription-${row.subscriptionId}`, tabindex: -1,
        'data-subscription': row.subscriptionId }, el('h3', {}, row.subscriptionId),
      el('p', { 'data-care-state': row.status }, `${context.t('careStatus')}: ${row.status}`),
      el('p', {}, `${context.t('careNext')}: ${row.nextCycleAt ?? '—'}`));
      if (row.pause) append(card, renderValue(row.pause));
      if (row.action || context.query.get('sekcja') === 'payments' && target === row.subscriptionId) {
        append(card, el('section', { 'aria-label': context.t('carePayment') }, el('h4', {}, context.t('carePayment')), renderValue(row.action), renderValue(row.payment)));
      }
      if (row.winback) append(card, el('section', { 'data-winback': row.winback.status }, el('h4', {}, context.t('careWinback')),
        renderValue(row.winback), el('p', {}, context.t('careConsent'))));
      const choices: CareAction[] = row.status === 'active' ? ['skip', 'slide', 'order_now', 'pause', 'cancel']
        : row.status === 'paused' ? ['resume', 'cancel'] : row.status === 'cancelled' ? ['reactivate'] : [];
      const actions = el('div', { class: 'actions' });
      for (const action of choices) {
        const reason = action === 'cancel' && row.status === 'paused' ? null : careAvailability(row, action);
        const control = button(context.t(labels[action]), () => openAction(row, action));
        if (reason) { control.disabled = true; control.title = `${context.t('careUnavailable')} ${reason}`; }
        append(actions, control);
      }
      append(card, actions); append(output, card);
      if (target === row.subscriptionId) { found = true; queueMicrotask(() => { card.focus(); card.scrollIntoView(); }); }
    }
    if (target && !found) append(output, el('p', { role: 'status' }, context.t('careNotFound')));
  }
  function duration(value: string): FieldSpec {
    const terms = context.config.renewal.subscriptionCare.terms;
    return { name: 'pausePreset', label: 'careDuration', type: 'select', value, options: [
      { value: '2_weeks', text: `${context.t('careTwoWeeks')} (${terms.pauseDays})` },
      { value: '1_month', text: `${context.t('careMonth')} (${terms.pauseMonths})` },
      { value: 'indefinite', text: context.t('careIndefinite') }] };
  }
  function openAction(row: PortalSubscription, action: CareAction) {
    const dialog = el('dialog', { 'aria-label': context.t(labels[action]) }, el('h2', {}, context.t(labels[action])));
    const close = () => { dialog.close(); dialog.remove(); };
    let accepted = false;
    const targetDate = saveRescheduleTarget(row.nextCycleAt, context.config.renewal.subscriptionCare);
    const fields: FieldSpec[] = [];
    const timing = action === 'order_now' || action === 'reactivate' || action === 'resume' && row.action?.blockedReason === 'payment_expired';
    if (timing) {
      append(dialog, el('p', {}, action === 'order_now'
        ? `${context.t('careOrderTiming')} ${context.config.renewal.subscriptionCare.terms.orderNowDelayMinutes}`
        : `${context.t('careTiming')} ${new Date(Date.now() + context.config.renewal.subscriptionCare.terms.reactivateDelayDays * 86400000).toLocaleDateString(context.locale)}`));
      fields.push({ name: 'confirmedChargeTiming', label: 'careConfirmed', type: 'checkbox' });
    }
    if (action === 'pause') fields.push(duration('2_weeks'));
    if (action === 'slide') fields.push({ name: 'newNextCycleAt', label: 'nextDelivery', type: 'date' });
    if (action === 'cancel') {
      const reasonLabels: Record<string, CopyKey> = { too_much_product: 'careTooMuch', delivery_issue: 'careDelivery', too_expensive: 'carePrice', not_a_good_fit: 'careFit', other: 'careOther' };
      fields.push({ name: 'reasonCode', label: 'cancelReason', type: 'select', options: context.config.renewal.subscriptionCare.retentionReasons.map(value => ({ value, text: reasonLabels[value] ? context.t(reasonLabels[value]) : value.replaceAll('_', ' ') })) },
        { name: 'comment', label: 'note', type: 'textarea', maxLength: 240, required: false }, duration('1_month'));
    }
    const offered = el('p', { 'data-save-offer': '' });
    const form = actionForm(context, { operation: 'subscription.command', submit: action === 'cancel' ? 'confirmCancel' : labels[action], fields,
      transform(values) {
        const common = { subscriptionRef: row.subscriptionId, action, ...values };
        if (action === 'slide') return { ...common, newNextCycleAt: new Date(`${String(values.newNextCycleAt)}T12:00:00`).toISOString() };
        if (action === 'pause') return { ...common, reason: `pause_duration=${String(values.pausePreset)}` };
        if (action !== 'cancel') return common;
        const reason = String(values.reasonCode), kind = saveOfferKind(reason), preset = String(values.pausePreset);
        const note = String(values.comment).trim();
        const offerId = kind === 'pause' ? `pause-${preset}` : kind;
        if (accepted && kind === 'skip') return { subscriptionRef: row.subscriptionId, action: 'skip', reason: `save_offer=skip;cancel_reason=${reason}` };
        if (accepted && kind === 'reschedule') return { subscriptionRef: row.subscriptionId, action: 'slide', newNextCycleAt: targetDate, reason: `save_offer=reschedule;cancel_reason=${reason}` };
        return { subscriptionRef: row.subscriptionId, action: accepted ? 'pause' : 'cancel',
          ...(accepted ? { pausePreset: preset } : {}),
          survey: { reasonCode: reason, comment: note || null, acceptedSaveOfferId: accepted ? offerId : null },
          saveOffer: { offerId, kind, accepted },
          reason: accepted ? `save_offer=pause;pause_duration=${preset};cancel_reason=${reason}`
            : [`cancel_reason=${reason}`, `save_offer_declined=${kind === 'pause' ? `pause:${preset}` : kind}`, ...(note ? [`note=${note}`] : [])].join(';') };
      }, onSuccess() { close(); void refresh(); },
    });
    if (action === 'cancel') {
      const chooser = form.querySelector<HTMLSelectElement>('[name=reasonCode]')!;
      const presets = form.querySelector<HTMLSelectElement>('[name=pausePreset]')!;
      const offerButton = el('button', { type: 'submit' }, context.t('careAccept'));
      form.addEventListener('submit', event => { accepted = (event as SubmitEvent).submitter === offerButton; }, { capture: true });
      const update = () => {
        const kind = saveOfferKind(chooser.value);
        offered.textContent = `${context.t('careOffer')}: ${context.t(kind === 'skip' ? 'careSkip' : kind === 'reschedule' ? 'reschedule' : 'carePause')}${kind === 'reschedule' ? ` — ${targetDate}` : ''}`;
        presets.parentElement!.hidden = kind !== 'pause';
        const refusal = kind === 'skip' || kind === 'reschedule' ? careAvailability(row, kind === 'skip' ? 'skip' : 'slide') : careAvailability(row, 'pause');
        offerButton.disabled = refusal !== null;
        if (refusal) offerButton.title = `${context.t('careUnavailable')} ${refusal}`;
      };
      chooser.addEventListener('change', update);
      append(form, offered, offerButton, el('p', {}, context.t('careGuidance'))); update();
    }
    append(dialog, form, button(context.t('cancel'), close, 'secondary'));
    section.append(dialog); dialog.showModal();
    dialog.addEventListener('cancel', () => dialog.remove());
  }
  append(section, button(context.t('careRead'), refresh, 'secondary'), output);
  void refresh();
  return section;
}

/** Only an application-local owned account path survives the sign-in trip. */
export function accountReturn(context: PageContext): string {
  const path = new URL(routes.account[context.locale], location.origin);
  for (const key of ['sub', 'sekcja']) { const value = context.query.get(key); if (value) path.searchParams.set(key, value); }
  return path.pathname + path.search;
}


/** The owned pending order supplies the target; the actor port decides recoverability. */
function orderPortal(context: PageContext): HTMLElement {
  const output = el('div', { 'aria-live': 'polite' });
  const section = el('section', { class: 'panel', 'data-account-orders': '' }, el('h2', {}, context.t('orders')),
    button(context.t('readStatus'), refresh), output);
  async function refresh() {
    const result = await act('account.orders', {}, crypto.randomUUID());
    output.replaceChildren();
    if (!result.ok) { append(output, refusal(context, result.code)); return; }
    if (!isRecord(result.value) || !Array.isArray(result.value.orders)) return;
    for (const order of result.value.orders) {
      if (!isRecord(order) || typeof order.orderId !== 'string') continue;
      const card = el('article', { class: 'panel', 'data-order': order.orderId }, el('h3', {}, order.orderId), renderValue(order));
      if (order.recoverableCheckout === true) append(card, actionForm(context, { operation: 'checkout.recoveryStart', submit: 'completeOrderPayment',
        input: () => ({ orderRef: order.orderId }), onSuccess(value) {
          if (!isRecord(value)) return;
          if (value.recoverable === true && typeof value.token === 'string') {
            rememberPurchase(context.config.id, { token: value.token, orderRef: order.orderId });
            context.navigate(routes.completion[context.locale]);
          } else context.navigate(value.fallback === 'fresh_checkout' ? routes.builder[context.locale] : routes.account[context.locale]);
        } }));
      append(output, card);
    }
  }
  void refresh(); return section;
}

function profileEditor(context: PageContext): HTMLElement {
  const output = el('div', { 'aria-live': 'polite' });
  const section = el('section', { class: 'panel', 'data-profile-editor': '' }, el('h2', {}, context.t('editProfile')), output);
  async function refresh() {
    const result = await act('account.read', {}, crypto.randomUUID());
    if (!section.isConnected) return;
    output.replaceChildren();
    if (!result.ok || !isRecord(result.value) || !isRecord(result.value.profile)) {
      append(output, refusal(context, result.ok ? 'customer_session_required' : result.code)); return;
    }
    const profile = result.value.profile;
    append(output, el('p', {}, `${context.t('email')}: ${String(profile.email ?? '')}`),
      actionForm(context, { operation: 'account.profile', submit: 'save', fields: [
        { name: 'firstName', label: 'firstName', required: false, maxLength: 80, value: String(profile.firstName ?? '') },
        { name: 'lastName', label: 'lastName', required: false, maxLength: 80, value: String(profile.lastName ?? '') },
        { name: 'phone', label: 'phone', required: false, type: 'tel', maxLength: 30, value: String(profile.phone ?? '') }],
      onSuccess: () => { void refresh(); } }));
  }
  void refresh(); return section;
}
