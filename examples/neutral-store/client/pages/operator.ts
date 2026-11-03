import type { PageContext } from '../context.ts';
import type { Operation } from '../../shared/api.ts';
import type { CopyKey } from '../../owned/copy.ts';
import { isRecord } from '../../shared/offer.ts';
import { routes } from '../../shared/routes.ts';
import { el, link } from '../dom.ts';
import { actionForm, nativeActions, otherRefusal, readPanel, refusedAction, type FieldSpec } from '../forms.ts';

const orderRef: FieldSpec = { name: 'orderRef', label: 'orderRef' };
const customerRef: FieldSpec = { name: 'customerRef', label: 'customerRef' };
const shipmentRef: FieldSpec = { name: 'shipmentRef', label: 'shipmentRef' };

export function operatorPage(context: PageContext): HTMLElement {
  const navItems: Array<[string, CopyKey]> = [
    ['orders', 'orders'], ['customers', 'customer360'], ['shipments', 'shipments'],
    ['returns', 'returns'], ['catalogue', 'bundles'], ['reviews', 'review'],
    ['partners', 'partners'], ['risk', 'risk'], ['market', 'market'], ['ingest', 'ingest'],
  ];
  return el('div', {}, el('h1', {}, context.t('admin')),
    el('p', {}, context.t('operatorBody')),
    el('section', { id: 'operator-sign-in', class: 'panel' },
      actionForm(context, { operation: 'auth.operator', submit: 'operatorRequestSignIn',
        fields: [{ name: 'email', label: 'email', type: 'email', autocomplete: 'email' }] }),
      operatorTokenForm(context)),
    el('nav', { 'aria-label': context.t('admin'), class: 'section-nav' },
      ...navItems.map(([anchor, label]) => link(context.t(label), `${routes.admin[context.locale]}#${anchor}`))),
    readPanel(context, 'bindingStatus', 'application.status'),
    orderActions(context), customerActions(context), shipmentActions(context), returnActions(context),
    bundleActions(context), reviewActions(context), partnerActions(context),
    el('section', { id: 'risk', class: 'panel' }, el('h2', {}, context.t('risk')),
      el('p', {}, context.t('riskBody')), refusedAction(context, 'riskAction', 'starter_risk_disabled')),
    marketInputs(context), ingestActions(context),
    nativeActions(context, ['N1', 'N2', 'N3', 'N4', 'N9']));
}

function operatorTokenForm(context: PageContext): HTMLElement {
  const form = actionForm(context, { operation: 'auth.operator', submit: 'operatorRedeemToken',
    fields: [{ name: 'token', label: 'operatorToken', type: 'password', maxLength: 43,
      pattern: '(?:[A-Za-z0-9_]|-){43}', autocomplete: 'one-time-code' }],
    onSuccess: () => { (form as HTMLFormElement).reset(); },
  });
  return form;
}

function orderActions(context: PageContext): HTMLElement {
  const make = (operation: Operation, title: CopyKey, fields: FieldSpec[]) => actionForm(context, {
    operation, title, submit: title, fields: [orderRef, ...fields],
  });
  return el('section', { id: 'orders', class: 'panel' }, el('h2', {}, context.t('orders')),
    readPanel(context, 'orders', 'operator.orders'),
    el('div', { class: 'form-grid' },
      make('operator.order', 'read', []),
      make('operator.hold', 'hold', [{ name: 'reason', label: 'reason', type: 'textarea' }]),
      make('operator.release', 'releaseHold', [{ name: 'holdRef', label: 'holdRef' }]),
      make('operator.cancelUnpaid', 'cancelUnpaid', [{ name: 'reason', label: 'reason' }]),
      make('operator.externalRefund', 'externalRefund', [
        { name: 'externalRefundRef', label: 'externalRefundRef' },
        { name: 'amountMinor', label: 'amountMinor', type: 'number', min: 1 },
        { name: 'confirmed', label: 'externalRefund', type: 'checkbox' },
      ]),
      make('operator.invoice', 'invoiceRequest', [])));
}

function customerActions(context: PageContext): HTMLElement {
  return el('section', { id: 'customers', class: 'panel' }, el('h2', {}, context.t('customer360')),
    el('p', {}, context.t('supportRosterBody')),
    actionForm(context, {
      operation: 'operator.customerSearch', submit: 'searchCustomer',
      fields: [{ name: 'query', label: 'search' }],
    }),
    actionForm(context, {
      operation: 'operator.customer', submit: 'read', fields: [customerRef],
    }),
    actionForm(context, {
      operation: 'operator.recovery', submit: 'repairAction',
      fields: [customerRef, { name: 'subscriptionRef', label: 'subscriptionRef' }],
    }));
}

function shipmentActions(context: PageContext): HTMLElement {
  const make = (operation: Operation, title: CopyKey, fields: FieldSpec[]) => actionForm(context, {
    operation, title, submit: title, fields: [shipmentRef, ...fields],
  });
  return el('section', { id: 'shipments', class: 'panel' }, el('h2', {}, context.t('shipments')),
    el('p', {}, context.t('trackingBody')),
    readPanel(context, 'shipments', 'operator.shipments'),
    el('div', { class: 'form-grid' },
      make('operator.shipment', 'read', []),
      make('operator.label', 'label', [{ name: 'labelRef', label: 'actionRef' }]),
      make('operator.handoff', 'handoff', [{ name: 'evidenceRef', label: 'actionRef' }]),
      make('operator.delivery', 'delivery', [{ name: 'evidenceRef', label: 'actionRef' }])));
}

function returnActions(context: PageContext): HTMLElement {
  return el('section', { id: 'returns', class: 'panel' }, el('h2', {}, context.t('returns')),
    readPanel(context, 'returns', 'operator.returns'),
    ...(['operator.returnApprove', 'operator.returnReject'] as const).map(operation => actionForm(context, {
      operation, submit: operation === 'operator.returnApprove' ? 'approveReturn' : 'rejectReturn',
      fields: [{ name: 'returnRef', label: 'returnRef' }, { name: 'reason', label: 'reason', type: 'textarea' }],
    })),
    ...(['receiveReturn', 'restockReturn', 'refundReturn'] as const).map(key => otherRefusal(context, key)));
}

function bundleActions(context: PageContext): HTMLElement {
  const make = (label: CopyKey, action: string, fields: FieldSpec[] = []) => actionForm(context, {
    operation: 'operator.bundleCommand', title: label, submit: label,
    fields: [{ name: 'bundleCode', label: 'bundleCode' }, ...fields], input: () => ({ action }),
  });
  return el('section', { id: 'catalogue', class: 'panel' }, el('h2', {}, context.t('bundles')),
    el('p', {}, context.t('catalogAuthoringBody')),
    readPanel(context, 'bundles', 'operator.bundles'),
    actionForm(context, {
      operation: 'operator.bundle', submit: 'read', fields: [{ name: 'bundleCode', label: 'bundleCode' }],
    }),
    el('div', { class: 'form-grid' },
      make('bundleDraft', 'create', [{ name: 'title', label: 'bundleTitle' }]),
      actionForm(context, {
        operation: 'operator.bundleCommand', title: 'bundleComposition', submit: 'bundleComposition',
        fields: [{ name: 'bundleCode', label: 'bundleCode' },
          { name: 'components', label: 'ingestJson', type: 'textarea', value: JSON.stringify([
            { sku: context.config.offer.products[0]?.sku, quantity: 1, isAddon: false },
          ], null, 2) }],
        transform: values => {
          const components: unknown = JSON.parse(String(values.components));
          if (!Array.isArray(components)) throw new Error('starter_input_invalid');
          return { action: 'set_composition', bundleCode: values.bundleCode, components };
        },
      }),
      make('bundleTarget', 'set_target_price', [
        { name: 'amountMinor', label: 'amountMinor', type: 'number', min: 1 },
      ]),
      make('bundleActivate', 'activate'), make('bundleDeactivate', 'deactivate'),
      make('bundleArchive', 'archive'), make('bundleRestore', 'restore'),
      make('bundleClone', 'clone', [{ name: 'newCode', label: 'actionRef' }])) ,
    catalogDraftActions(context),
    otherRefusal(context, 'publishCatalog'));
}

function catalogDraftActions(context: PageContext): HTMLElement {
  const productId = crypto.randomUUID();
  return el('section', { id: 'catalogue-drafts' },
    readPanel(context, 'catalogDrafts', 'operator.catalogDrafts'),
    actionForm(context, { operation: 'operator.catalogDrafts', submit: 'catalogDraftRead',
      fields: [{ name: 'draftId', label: 'catalogDraftId' }], input: () => ({ action: 'get' }) }),
    actionForm(context, { operation: 'operator.catalogDrafts', title: 'catalogDraftCommand', submit: 'save',
      fields: [
        { name: 'action', label: 'catalogDraftAction', type: 'select', options:
          ([['create', 'catalogDraftCreate'], ['revise', 'catalogDraftRevise'], ['abandon', 'catalogDraftAbandon']] as const)
            .map(([value, label]) => ({ value, text: context.t(label) })) },
        { name: 'draftId', label: 'catalogDraftId', value: crypto.randomUUID() },
        { name: 'expectedRevision', label: 'catalogDraftRevision', type: 'number', min: 0, value: '0' },
        { name: 'payload', label: 'catalogDraftPayload', type: 'textarea', maxLength: 20000,
          value: JSON.stringify({ schemaVersion: 1, product: { id: productId,
            type: { key: 'starter:item', version: 1 }, dimensions: [], sharedContent: { title: 'Fictional item' } },
          skus: [] }, null, 2) },
      ], transform: values => ({ action: values.action, draftId: values.draftId,
        expectedRevision: values.expectedRevision,
        ...(values.action === 'abandon' ? {} : { payload: JSON.parse(String(values.payload)) as unknown }) }),
    }));
}

function reviewActions(context: PageContext): HTMLElement {
  return el('section', { id: 'reviews', class: 'panel' }, el('h2', {}, context.t('review')),
    readPanel(context, 'review', 'operator.reviews'),
    actionForm(context, {
      operation: 'operator.reviewModerate', submit: 'save',
      fields: [{ name: 'reviewRef', label: 'actionRef' },
        { name: 'action', label: 'status', type: 'select', options: [
          { value: 'publish', text: context.t('reviewPublish') }, { value: 'hide', text: context.t('reviewHide') },
        ] }],
    }));
}

function partnerActions(context: PageContext): HTMLElement {
  return el('section', { id: 'partners', class: 'panel' }, el('h2', {}, context.t('partners')),
    el('p', {}, context.t('partnersBody')),
    readPanel(context, 'partners', 'operator.partners'),
    actionForm(context, {
      operation: 'operator.partnerTransition', submit: 'save',
      fields: [{ name: 'id', label: 'caseRef' },
        { name: 'expectedVersion', label: 'actionRef', type: 'number', min: 1, value: '1' },
        { name: 'status', label: 'status', type: 'select', options: [
          { value: 'contacted', text: context.t('partnerContacted') }, { value: 'qualified', text: context.t('partnerQualified') },
          { value: 'disqualified', text: context.t('partnerDisqualified') },
          { value: 'closed_won', text: context.t('partnerClosedWon') }, { value: 'closed_lost', text: context.t('partnerClosedLost') },
        ] }],
    }));
}

function marketInputs(context: PageContext): HTMLElement {
  return el('section', { id: 'market', class: 'panel' }, el('h2', {}, context.t('market')),
    el('p', {}, context.t('marketBody')),
    el('dl', { class: 'response-fields' },
      el('dt', {}, context.t('country')), el('dd', {}, context.config.market.country),
      el('dt', {}, context.t('currency')), el('dd', {}, context.config.market.currency),
      el('dt', {}, context.t('language')), el('dd', {}, context.locale)));
}

function ingestActions(context: PageContext): HTMLElement {
  return el('section', { id: 'ingest', class: 'panel' }, el('h2', {}, context.t('ingest')),
    el('p', {}, context.t('ingestBody')),
    actionForm(context, {
      operation: 'ingest.submit', submit: 'ingestAction',
      fields: [{ name: 'order', label: 'ingestJson', type: 'textarea', maxLength: 20000 }],
      transform: values => {
        const order: unknown = JSON.parse(String(values.order));
        if (!isRecord(order)) throw new Error('starter_input_invalid');
        return { order };
      },
    }));
}
