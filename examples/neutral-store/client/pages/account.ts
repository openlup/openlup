import { accountPreferencePolicy } from '../../owned/renewal.config.ts';
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
    accountPreferences(context), billingProfiles(context),
    subscriptionPortal(context),
    subscriptionEditorEntries(context),
    addressForm(context, 'subscription.address'),
    communicationChoices(context),
    nativeActions(context, ['N5', 'N6', 'N8', 'N9']),
    actionForm(context, { operation: 'auth.signOut', submit: 'signOut' }));
}

export function invoicesPage(context: PageContext): HTMLElement {
  const corrections = el('section', { 'data-invoice-corrections': '' });
  const buyer = el('section', { 'data-invoice-buyer': '' });
  return el('div', {}, el('h1', {}, context.t('orders')),
    readPanel(context, 'orders', 'account.orders'),
    el('p', {}, context.t('sandboxInvoice')),
    actionForm(context, { operation: 'account.invoice', title: 'invoiceHistory', submit: 'read',
      fields: [{ name: 'orderRef', label: 'orderRef' }], onSuccess(value) {
        corrections.replaceChildren();buyer.replaceChildren();
        if (isRecord(value) && isRecord(value.buyerSnapshot)) append(buyer, el('h2', {}, context.t('invoiceBuyer')), renderValue(value.buyerSnapshot));
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
    buyer, corrections,
    actionForm(context, {
      operation: 'account.invoice', title: 'invoices', submit: 'download',
      fields: [{ name: 'orderRef', label: 'orderRef' }, { name: 'documentRef', label: 'documentRef' }],
      onSuccess: downloadInvoice,
      display: value => isRecord(value) ? { contentType: value.contentType, fileName: value.fileName } : value,
    }),
    link(context.t('account'), routes.account[context.locale]));
}

function billingProfiles(context: PageContext): HTMLElement {
  const book = el('div', { 'data-billing-book': '', 'aria-live': 'polite' });
  const section = el('section', { class: 'panel', 'data-billing-profiles': '' }, el('h2', {}, context.t('billing')),
    el('p', {}, context.t('billingEffect')), el('p', {}, context.t('billingCommitNote')));
  function show(value: unknown) {
    if (!section.isConnected || !isRecord(value) || !Array.isArray(value.ordererProfiles)) return;
    book.replaceChildren();
    for (const row of value.ordererProfiles) {
      if (!isRecord(row) || typeof row.profileId !== 'string') continue;
      append(book, el('article', { 'data-billing-profile': row.profileId }, el('h3', {}, String(row.label || row.fullName)), renderValue(row),
        form(row), actionForm(context, { operation: 'account.billing', submit: 'billingDelete',
          input: () => ({ action: 'delete', profileId: row.profileId }), onSuccess: show })));
    }
  }
  function form(row: Record<string, unknown> = {}) {
    const fields: FieldSpec[] = [
      ...(['label','fullName','email','phone','companyName','taxId','companyIdentitySource','companyIdentityEvidenceHash'] as const).map(name => ({ name,
        label: ({ label: 'savedAddressLabel', fullName: 'billingName', email: 'email', phone: 'phone', companyName: 'addressCompany', taxId: 'addressTaxId', companyIdentitySource: 'billingSource', companyIdentityEvidenceHash: 'billingEvidence' } as const)[name],
        type: name === 'email' ? 'email' as const : 'text' as const, value: typeof row[name] === 'string' ? String(row[name]) : '',
        required: ['fullName','email'].includes(name), maxLength: ({ label: 120, fullName: 200, email: 320, phone: 64, companyName: 200, taxId: 64, companyIdentitySource: 120, companyIdentityEvidenceHash: 160 } as const)[name] })),
      { name: 'companyVerificationLevel', label: 'billingVerification', type: 'select', required: false, value: String(row.companyVerificationLevel || ''), options: [
        ['', 'billingUnspecified'], ['registry_verified','billingRegistry'], ['provider_verified','billingProvider'], ['manual_unverified','billingManual'], ['invalid','billingInvalid'],
      ].map(([value, key]) => ({ value: value!, text: context.t(key as CopyKey) })) },
      { name: 'isDefault', label: 'addressDefault', type: 'checkbox', required: false },
    ];
    const result = actionForm(context, { operation: 'account.billing', title: row.profileId ? 'billingEdit' : 'billingAdd', submit: 'save', fields,
      input: () => ({ action: 'upsert', ...(row.profileId ? { profileId: row.profileId } : {}) }),
      transform: values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === '' && !['fullName','email'].includes(key) ? null : value])), onSuccess: show });
    if (row.isDefault) result.querySelector<HTMLInputElement>('[name=isDefault]')!.checked = true;
    return result;
  }
  append(section, actionForm(context, { operation: 'account.billing', submit: 'billingLoad', input: () => ({ action: 'read' }), onSuccess: show }), book, form(),
    el('p', {}, context.t('defaultsEffect')), actionForm(context, { operation: 'account.defaults', submit: 'defaultsRead', fields: [
      { name: 'checkoutKind', label: 'purchaseMode', type: 'select', options: [{ value: 'one_time', text: context.t('oneTime') }, { value: 'subscription_initial', text: context.t('subscription') }] },
    ] }));
  return section;
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
      append(card, actions);
      if (['active','paused'].includes(row.status)) append(card, savedSelection(context, row.subscriptionId, typeof value.shippingSavedAddressId === 'string' ? value.shippingSavedAddressId : null));
      append(output, card);
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


function savedSelection(context: PageContext, subscriptionRef: string, initial: string | null): HTMLElement {
  const output = el('div', { 'aria-live': 'polite' });
  const pointer = el('p', { 'data-saved-address-pointer': '' }, initial ?? context.t('savedAddressNone'));
  let generation = 0;
  const section = el('section', { 'data-saved-selection': subscriptionRef }, el('h4', {}, context.t('savedAddressSelect')), pointer);
  const load = button(context.t('savedAddressLoad'), async () => {
    const current = ++generation;
    const result = await act('account.addresses', { action: 'read' }, crypto.randomUUID());
    if (!section.isConnected || current !== generation) return;
    output.replaceChildren();
    if (!result.ok) { append(output, refusal(context, result.code)); return; }
    const rows = isRecord(result.value) && Array.isArray(result.value.addresses) ? result.value.addresses.filter(isRecord)
      .filter(row => ['shipping','both'].includes(String(row.kind)) && typeof row.addressId === 'string') : [];
    if (!rows.length) { append(output, el('p', {}, context.t('savedAddressNone'))); return; }
    append(output, actionForm(context, { operation: 'subscription.savedAddress', submit: 'savedAddressSelect',
      input: () => ({ subscriptionRef }), resultMessage: () => 'savedAddressSelected',
      fields: [{ name: 'savedAddressId', label: 'savedAddresses', type: 'select', options: rows.map(row =>
        ({ value: String(row.addressId), text: `${row.label || row.line1} · ${row.city}` })) },
        { name: 'reason', label: 'reason', required: false }],
      onSuccess: value => { if (isRecord(value)) pointer.textContent = typeof value.shippingAddressId === 'string' ? value.shippingAddressId : context.t('savedAddressNone'); } }));
  });
  append(section, el('p', {}, context.t('savedAddressEffect')), load, output);
  return section;
}

function accountPreferences(context: PageContext): HTMLElement {
  const book = el('div', { 'data-address-book': '', 'aria-live': 'polite' });
  const section = el('section', { id: 'account-preferences', class: 'panel' }, el('h2', {}, context.t('accountPreferences')),
    el('p', {}, context.t('preferencesEffect')), el('p', {}, context.t('savedAddressCommitNote')));
  const addressFields = (row: Record<string, unknown> = {}): FieldSpec[] => {
    const text = (name: string) => typeof row[name] === 'string' ? String(row[name]) : '';
    return [{ name: 'kind', label: 'addressKind', type: 'select', value: text('kind') || 'shipping', options: [
      { value: 'shipping', text: context.t('addressShipping') }, { value: 'billing', text: context.t('addressBilling') }, { value: 'both', text: context.t('addressBoth') }] },
      ...(['label','recipientName','contactPhone','companyName','taxId','line1','line2','city','postalCode','country','deliveryNotes','courierInstructions'] as const).map(name => ({ name,
        label: ({ label: 'savedAddressLabel', recipientName: 'savedRecipientName', contactPhone: 'phone', companyName: 'addressCompany', taxId: 'addressTaxId', line1: 'address', line2: 'address2',
          city: 'city', postalCode: 'postalCode', country: 'country', deliveryNotes: 'deliveryNotes', courierInstructions: 'courierInstructions' } as const)[name],
        value: text(name) || (name === 'country' ? context.config.market.country : ''), maxLength: ['deliveryNotes','courierInstructions'].includes(name) ? 500 : 240,
        required: ['line1','city','postalCode','country'].includes(name) })),
      { name: 'isDefault', label: 'addressDefault', type: 'checkbox', required: false, value: row.isDefault ? 'true' : '' }];
  };
  function showBook(value: unknown) {
    if (!section.isConnected || !isRecord(value) || !Array.isArray(value.addresses)) return;
    book.replaceChildren();
    for (const row of value.addresses) {
      if (!isRecord(row) || typeof row.addressId !== 'string') continue;
      const article = el('article', { 'data-saved-address': row.addressId }, el('h3', {}, String(row.label || row.line1)), renderValue(row));
      append(article, addressFormFor(row), actionForm(context, { operation: 'account.addresses', submit: 'deleteSavedAddress',
        input: () => ({ action: 'delete', addressId: row.addressId }), onSuccess: showBook }));
      append(book, article);
    }
    if (!book.children.length) append(book, el('p', {}, context.t('savedAddressNone')));
  }
  function addressFormFor(row?: Record<string, unknown>) {
    const form = actionForm(context, { operation: 'account.addresses', title: row ? 'editSavedAddress' : 'addSavedAddress', submit: 'save', fields: addressFields(row),
      transform: values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === '' && !['kind','line1','city','postalCode','country'].includes(key) ? null : value])),
      input: () => ({ action: 'upsert', ...(row ? { addressId: row.addressId } : {}) }), onSuccess: showBook });
    if (row?.isDefault) form.querySelector<HTMLInputElement>('[name=isDefault]')!.checked = true;
    return form;
  }
  append(section, actionForm(context, { operation: 'account.addresses', submit: 'savedAddressLoad', input: () => ({ action: 'read' }), onSuccess: showBook }), book, addressFormFor());
  const scopes = [{ value: 'one_time', text: context.t('preferenceOneTime') }, { value: 'subscription', text: context.t('subscription') }, { value: 'any', text: context.t('preferenceAny') }];
  append(section, el('section', { 'data-payment-preferences': '' }, el('h3', {}, context.t('paymentPreference')),
    readPanel(context, 'paymentPreference', 'account.paymentPreference', { action: 'read' }),
    actionForm(context, { operation: 'account.paymentPreference', submit: 'save', input: () => ({ action: 'save' }), fields: [
      { name: 'scope', label: 'preferenceScope', type: 'select', options: scopes },
      { name: 'methodKind', label: 'payment', type: 'select', options: Object.entries(accountPreferencePolicy.methods).map(([key, value]) =>
        ({ value, text: context.t(key === 'card' ? 'preferenceCard' : key === 'instant' ? 'preferenceInstant' : 'preferenceTransfer') })) }] })),
    el('section', { 'data-delivery-preferences': '' }, el('h3', {}, context.t('deliveryPreference')), el('p', {}, context.t('lockerPreferenceEffect')),
      readPanel(context, 'deliveryPreference', 'account.deliveryPreference', { action: 'read' }),
      actionForm(context, { operation: 'account.deliveryPreference', submit: 'save', fields: [
        { name: 'scope', label: 'preferenceScope', type: 'select', options: scopes },
        { name: 'deliveryKind', label: 'deliveryPreference', type: 'select', options: [{ value: 'courier', text: context.t('preferenceCourier') }, { value: 'parcel-locker', text: context.t('preferenceLocker') }] },
        { name: 'providerKind', label: 'shipmentProvider', type: 'select', options: Object.entries(accountPreferencePolicy.providers).map(([key, value]) => ({ value, text: context.t(key === 'warehouse' ? 'preferenceWarehouse' : key === 'carrier' ? 'preferenceCarrier' : key === 'manual' ? 'preferenceManual' : 'preferenceSimulator') })) },
        { name: 'carrierKind', label: 'preferenceCarrierKind', value: 'demo-carrier' }, { name: 'carrierCode', label: 'preferenceCarrierCode', value: 'demo-courier' },
        { name: 'serviceCode', label: 'preferenceService', value: 'demo-standard' },
        ...(['pickupId','pickupName','pickupLine1','pickupPostalCode','pickupCity','pickupCountry'] as const).map(name => ({ name,
          label: ({ pickupId: 'pickupId', pickupName: 'pickupName', pickupLine1: 'address', pickupPostalCode: 'postalCode', pickupCity: 'city', pickupCountry: 'country' } as const)[name], required: false })),
      ], input: () => ({ action: 'save' }), transform: values => {
        const { pickupId, pickupName, pickupLine1, pickupPostalCode, pickupCity, pickupCountry, ...rest } = values;
        return { ...rest, pickupPoint: pickupId || pickupName ? { id: pickupId, name: pickupName,
          address: pickupLine1 || pickupPostalCode || pickupCity || pickupCountry ? { line1: pickupLine1, postalCode: pickupPostalCode, city: pickupCity, country: pickupCountry } : null } : null };
      } })));
  return section;
}
