import { accountPreferencePolicy } from '../../owned/renewal.config.ts';
import { rememberPurchase } from '../purchase.ts';
import { act, uncertainAction } from '../api.ts';
import { careAvailability, type CareAction, type PausePreset, type PortalSubscription } from '../../shared/renewal-config.ts';
import { currentRecoveryToken } from '../recovery-session.ts';
import type { PageContext } from '../context.ts';
import type { CopyKey } from '../../owned/copy.ts';
import { isRecord } from '../../shared/offer.ts';
import type { ActionInput, Operation, SubscriptionCancelFeedbackInput } from '../../shared/api.ts';
import type { SubscriptionSaveOfferPresentation } from '@openlup/platform/subscriptions/contracts';
import { routes } from '../../shared/routes.ts';
import { downloadInvoice } from '../invoice-download.ts';
import { el, link, append, button, renderValue } from '../dom.ts';
import { actionForm, field, nativeActions, readPanel, refusal, type FieldSpec } from '../forms.ts';
import { subscriptionEditorEntries } from '../editors/entries.ts';
import { date } from '../editors/view.ts';

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
const careRemedies = [
  ['starter_local_host_required starter_same_origin_required', 'Open the account on the configured store origin.', 'Otwórz konto pod skonfigurowanym adresem sklepu.'],
  ['starter_command_identity_required subscription_command_idempotency_conflict', 'Retry the original action with its original input and key.', 'Ponów pierwotną akcję z tymi samymi danymi i kluczem.'],
  ['starter_input_invalid', 'Reload the card and request the offer again if you want to use it.', 'Odśwież kartę i poproś ponownie o ofertę, jeśli chcesz z niej skorzystać.'],
  ['customer_session_required starter_subscription_not_found', 'Sign in and choose one of your subscriptions.', 'Zaloguj się i wybierz jedną ze swoich subskrypcji.'],
  ['starter_cancel_feedback_invalid_reason starter_cancel_feedback_reason_not_offered', 'Choose a current reason or skip feedback.', 'Wybierz aktualny powód lub pomiń opinię.'],
  ['starter_cancel_feedback_cancel_not_found', 'Retry the original cancellation before sending feedback.', 'Ponów pierwotne anulowanie przed wysłaniem opinii.'],
  ['starter_cancel_feedback_conflict', 'Retry with your original feedback choice.', 'Ponów próbę, wybierając wcześniej podany powód.'],
  ['starter_cancel_feedback_setup_required', 'Ask the store to update the feedback installation, then retry feedback.', 'Poproś sklep o zaktualizowanie obsługi opinii, a następnie spróbuj ponownie.'],
  ['starter_save_offer_unavailable starter_save_offer_stale starter_save_offer_consumed', 'Refresh the card to check which offers are available.', 'Odśwież kartę, aby sprawdzić dostępne oferty.'],
  ['subscription_command_operation_busy subscription_command_payment_blocked subscription_lifecycle_payment_blocked',
    'Wait for the operation to finish or resolve the payment issue, then refresh.', 'Poczekaj na zakończenie operacji lub rozwiąż problem z płatnością, a następnie odśwież kartę.'],
] as const;
export function subscriptionPortal(context: PageContext): HTMLElement {
  const care = context.config.renewal.subscriptionCare;
  const output = el('div', { 'aria-live': 'polite' });
  const section = el('section', { class: 'panel', id: 'subscriptions' }, el('h2', {}, context.t('subscriptions')),
    el('p', {}, context.t('subscriptionInvariant')));
  const target = context.query.get('sub');
  const cards = new Map<string, ReturnType<typeof makeCard>>();
  const notice = el('div', { role: 'status' });
  let readSequence = 0;
  type Row = PortalSubscription & { shippingSavedAddressId?: string };
  type Offer = SubscriptionSaveOfferPresentation;
  type Write = 'subscription.cancelDirect' | 'subscription.cancelFeedback' | 'subscription.acceptSaveOffer';
  type Pending = { operation: Write; input: ActionInput; key: string; running: boolean; interaction: Interaction | undefined };
  type Interaction = { generation: string | null; step: 'permission' | 'reading' | 'ready' | 'offer'; offer?: Offer; preset?: string };
  function makeCard(row: Row) {
    const evidence = el('div'), actions = el('div', { class: 'actions' }), slot = el('div');
    const card = el('article', { class: 'panel', id: `subscription-${row.subscriptionId}`, tabindex: -1,
      'data-subscription': row.subscriptionId }, el('h3', {}, row.subscriptionId), evidence, actions, slot);
    return { row, card, evidence, actions, slot, present: true, interaction: undefined as Interaction | undefined,
      pending: new Map<Write, Pending>(), cancelKey: '', reason: '', message: undefined as HTMLElement | undefined };
  }
  function cancellable(card: ReturnType<typeof makeCard>) {
    return card.present && ['active', 'paused'].includes(card.row.status);
  }
  function invalidateOffer(card: ReturnType<typeof makeCard>) {
    if (card.interaction?.step === 'reading' || card.interaction?.step === 'offer') card.interaction = undefined;
  }
  function careRefusal(code: string) {
    const remedy = careRemedies.find(([codes]) => codes.split(' ').includes(code));
    return refusal(context, code, remedy?.[context.locale === 'pl' ? 2 : 1] ?? context.t('careUnavailable'));
  }
  async function refresh() {
    const sequence = ++readSequence;
    const result = await act('account.read', {}, crypto.randomUUID());
    if (sequence !== readSequence || !output.isConnected) return;
    if (!result.ok) { notice.replaceChildren(careRefusal(result.code)); return; }
    const data = isRecord(result.value) && isRecord(result.value.renewal) ? result.value.renewal.subscriptions : null;
    const unseen = new Set(cards.keys());
    for (const value of Array.isArray(data) ? data : []) {
      if (!isRecord(value) || typeof value.subscriptionId !== 'string') continue;
      const row = value as unknown as Row;
      const existing = cards.get(row.subscriptionId), card = existing ?? makeCard(row);
      unseen.delete(row.subscriptionId);
      const invalidate = card.row.saveOfferGeneration !== row.saveOfferGeneration || !['active','paused'].includes(row.status);
      if (!existing || !card.present || JSON.stringify(card.row) !== JSON.stringify(row)) {
        card.row = row; card.present = true;
        if (invalidate) invalidateOffer(card);
        patchCard(card);
      }
      if (existing) continue;
      cards.set(row.subscriptionId, card);
      append(output, card.card);
      if (target === row.subscriptionId) queueMicrotask(() => { card.card.focus(); card.card.scrollIntoView(); });
    }
    for (const id of unseen) {
      const card = cards.get(id)!;
      card.present = false; invalidateOffer(card);
      if (card.pending.size || card.cancelKey) patchCard(card);
      else { card.card.remove(); cards.delete(id); }
    }
    notice.textContent = target && !cards.get(target)?.present ? context.t('careNotFound')
      : cards.size ? '' : context.t('careMissing');
  }
  function patchCard(card: ReturnType<typeof makeCard>) {
    const { row, evidence, actions } = card;
    evidence.hidden = actions.hidden = !card.present;
    evidence.replaceChildren(el('p', { 'data-care-state': row.status }, `${context.t('careStatus')}: ${row.status}`),
      el('p', {}, `${context.t('careNext')}: ${date(context, row.nextCycleAt)}`));
    if (row.pause) append(evidence, renderValue(row.pause));
    if (row.action || context.query.get('sekcja') === 'payments' && target === row.subscriptionId) {
      append(evidence, el('section', { 'aria-label': context.t('carePayment') }, el('h4', {}, context.t('carePayment')), renderValue(row.action), renderValue(row.payment)));
    }
    if (row.winback) append(evidence, el('section', { 'data-winback': row.winback.status }, el('h4', {}, context.t('careWinback')),
      renderValue(row.winback), el('p', {}, context.t('careConsent'))));
    const choices = Object.hasOwn(care.actions, row.status) ? care.actions[row.status as keyof typeof care.actions] : [];
    actions.replaceChildren(...choices.filter(action => action !== 'cancel').map(action => {
      const reason = careAvailability(row, action, care), control = button(context.t(labels[action]), () => openAction(row, action));
      if (reason) { control.disabled = true; control.title = `${context.t('careUnavailable')} ${reason}`; }
      return control;
    }));
    if (cancellable(card)) append(evidence, savedSelection(context, row.subscriptionId, row.shippingSavedAddressId ?? null));
    renderCare(card);
  }

  async function ask(card: ReturnType<typeof makeCard>, interaction: Interaction) {
    interaction.generation = card.row.saveOfferGeneration ?? null;
    interaction.step = 'reading'; renderCare(card);
    const result = await act('account.read', { saveOfferFor: card.row.subscriptionId }, crypto.randomUUID());
    if (card.interaction !== interaction || card.row.saveOfferGeneration !== interaction.generation || !cancellable(card)) return;
    interaction.step = 'ready';
    if (result.ok && isRecord(result.value)) {
      const offer = result.value.saveOffer as Offer | null;
      if (offer?.subscriptionRef === card.row.subscriptionId && offer.generation === interaction.generation) {
        interaction.step = 'offer'; interaction.offer = offer;
        if (offer.kind === 'pause') interaction.preset = offer.preselectedPausePreset;
      }
    } else if (!result.ok) card.message = careRefusal(result.code);
    renderCare(card);
  }
  async function write(card: ReturnType<typeof makeCard>, operation: Write, input: ActionInput) {
    if (card.pending.has(operation)) return;
    if (operation === 'subscription.cancelDirect') invalidateOffer(card);
    const pending = { operation, input, key: crypto.randomUUID(), running: false, interaction: card.interaction };
    card.pending.set(operation, pending);
    await send(card, pending);
  }
  async function send(card: ReturnType<typeof makeCard>, pending: Pending) {
    if (pending.running) return;
    const ownsInteraction = () => card.interaction === pending.interaction;
    pending.running = true;
    if (ownsInteraction()) card.message = undefined;
    renderCare(card);
    const result = await act(pending.operation, pending.input, pending.key);
    pending.running = false;
    const uncertain = uncertainAction(result);
    if (!uncertain) card.pending.delete(pending.operation);
    if (result.ok && pending.operation === 'subscription.cancelDirect' && (ownsInteraction() || !card.cancelKey)) {
      card.cancelKey = pending.key; card.reason = '';
    }
    if (result.ok && pending.operation === 'subscription.cancelFeedback' && card.cancelKey === pending.input.cancelCommandKey) {
      finishFeedback(card, 'careFeedbackRecorded');
    }
    if (ownsInteraction()) {
      if (uncertain) card.message = el('p', { role: 'status' }, context.locale === 'pl'
        ? 'Wynik jest nieznany. Ponów tę samą akcję.' : 'The result is uncertain. Retry this same action.');
      else {
        if (!result.ok) card.message = careRefusal(result.code);
        if (pending.operation === 'subscription.acceptSaveOffer'
          || result.ok && pending.operation === 'subscription.cancelDirect') card.interaction = undefined;
      }
    }
    renderCare(card);
    void refresh();
  }

  function finishFeedback(card: ReturnType<typeof makeCard>, key: 'careFeedbackSkipped' | 'careFeedbackRecorded') {
    card.cancelKey = ''; card.reason = ''; card.message = el('p', { role: 'status' }, context.t(key));
    renderCare(card);
  }
  function renderCare(card: ReturnType<typeof makeCard>) {
    const { row, slot, interaction, pending } = card, subscriptionRef = row.subscriptionId;
    slot.replaceChildren();
    if (card.cancelKey && !pending.has('subscription.cancelFeedback')) {
      const reasons: Record<string, CopyKey> = { too_much_product: 'careTooMuch', delivery_issue: 'careDelivery', too_expensive: 'carePrice', not_a_good_fit: 'careFit', other: 'careOther' };
      const { wrapper, control } = field(context, { name: 'reasonCode', label: 'cancelReason', type: 'select', value: card.reason, required: false,
        options: [{ value: '', text: context.t('careFeedbackSkipped') }, ...care.retentionReasons.map(value => ({ value, text: Object.hasOwn(reasons, value) ? context.t(reasons[value]!) : value.replaceAll('_', ' ') }))] });
      control.addEventListener('change', () => { card.reason = control.value; });
      append(slot, wrapper, button(context.t('careFeedbackSubmit'), () => {
        if (!card.reason) { finishFeedback(card, 'careFeedbackSkipped'); return; }
        const input: SubscriptionCancelFeedbackInput = { subscriptionRef, cancelCommandKey: card.cancelKey, reasonCode: card.reason };
        return write(card, 'subscription.cancelFeedback', input);
      }), button(context.t('careFeedbackSkipped'), () => finishFeedback(card, 'careFeedbackSkipped'), 'secondary'));
    }
    if (cancellable(card) && !pending.has('subscription.cancelDirect')) {
      append(slot, button(context.t('cancelSubscription'), () => {
        if (interaction || !row.saveOfferGeneration) return write(card, 'subscription.cancelDirect', { subscriptionRef });
        card.message = undefined;
        card.interaction = { generation: row.saveOfferGeneration, step: 'permission' };
        renderCare(card);
      }));
      if (interaction?.step === 'permission' && row.saveOfferGeneration) {
        append(slot, el('p', {}, context.t('careOfferPermission')), button(context.t('careOfferYes'), () => ask(card, interaction)),
          button(context.t('careOfferNo'), () => { interaction.step = 'ready'; renderCare(card); }, 'secondary'));
      }
      if (interaction?.step === 'reading') append(slot, el('p', {}, context.t('loading')));
      if (interaction?.step === 'reading' || interaction?.step === 'offer') {
        append(slot, button(context.t('careDismissOffer'), () => {
          card.interaction = { generation: interaction.generation, step: 'ready' }; renderCare(card);
        }, 'secondary'));
      }
      const offer = interaction?.offer;
      if (offer && interaction.step === 'offer') {
        const action = offer.kind === 'reschedule' ? 'slide' : offer.kind;
        append(slot, el('p', { 'data-save-offer': '' }, context.t(labels[action]),
          offer.kind === 'reschedule' ? ` — ${date(context, offer.newNextCycleAt.replace(/^(\d{5})-/u, '+0$1-'))}` : ''));
        if (offer.kind === 'pause') {
          const { wrapper, control } = field(context, { name: 'pausePreset', label: 'careDuration', type: 'select', value: interaction.preset ?? offer.preselectedPausePreset,
            options: offer.pausePresets.map(({ pausePreset, duration }) => ({ value: pausePreset, text: duration.unit === 'indefinite' ? context.t('careIndefinite')
              : new Intl.NumberFormat(context.locale, { style: 'unit', unit: duration.unit === 'days' ? 'day' : 'month', unitDisplay: 'long' }).format(duration.value) })) });
          control.addEventListener('change', () => { interaction.preset = control.value; });
          append(slot, wrapper);
        }
        if (!pending.size) append(slot, button(context.t('careAccept'), () => {
          const terms = offer.kind === 'pause' ? offer.pausePresets.find(option => option.pausePreset === interaction.preset)
            : offer.kind === 'reschedule' ? { newNextCycleAt: offer.newNextCycleAt } : {};
          if (terms) return write(card, 'subscription.acceptSaveOffer', { subscriptionRef, generation: offer.generation, kind: offer.kind, ...terms });
        }));
      }
    }
    for (const operation of pending.values()) {
      append(slot, operation.running ? el('p', { role: 'status' }, context.t('loading'))
        : button(context.t('retry'), () => send(card, operation), 'secondary'));
    }
    if (card.message) append(slot, card.message);
  }

  function duration(value: PausePreset = care.pausePresets.default): FieldSpec {
    const text = { '2_weeks': `${context.t('careTwoWeeks')} (${care.terms.pauseDays})`,
      '1_month': `${context.t('careMonth')} (${care.terms.pauseMonths})`, indefinite: context.t('careIndefinite') };
    return { name: 'pausePreset', label: 'careDuration', type: 'select', value,
      options: care.pausePresets.allowed.map(value => ({ value, text: text[value] })) };
  }
  function openAction(row: PortalSubscription, action: CareAction) {
    const dialog = el('dialog', { 'aria-label': context.t(labels[action]) }, el('h2', {}, context.t(labels[action])));
    const close = () => { dialog.close(); dialog.remove(); };
    const fields: FieldSpec[] = [];
    const timing = action === 'order_now' || action === 'reactivate' || action === 'resume' && row.action?.blockedReason === 'payment_expired';
    if (timing) {
      append(dialog, el('p', {}, action === 'order_now'
        ? `${context.t('careOrderTiming')} ${care.terms.orderNowDelayMinutes}`
        : `${context.t('careTiming')} ${new Date(Date.now() + care.terms.reactivateDelayDays * 86400000).toLocaleDateString(context.locale)}`));
      fields.push({ name: 'confirmedChargeTiming', label: 'careConfirmed', type: 'checkbox' });
    }
    if (action === 'pause') fields.push(duration());
    if (action === 'slide') fields.push({ name: 'newNextCycleAt', label: 'nextDelivery', type: 'date' });
    const form = actionForm(context, { operation: 'subscription.command', submit: labels[action], fields,
      transform(values) {
        const common = { subscriptionRef: row.subscriptionId, action, ...values };
        if (action === 'slide') return { ...common, newNextCycleAt: new Date(`${String(values.newNextCycleAt)}T12:00:00`).toISOString() };
        if (action === 'pause') return { ...common, reason: `pause_duration=${String(values.pausePreset)}` };
        return common;
      }, onSuccess() { close(); void refresh(); },
    });
    append(dialog, form, button(context.t('cancel'), close, 'secondary'));
    section.append(dialog); dialog.showModal();
    dialog.addEventListener('cancel', () => dialog.remove());
  }
  append(section, button(context.t('careRead'), refresh, 'secondary'), notice, output);
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
