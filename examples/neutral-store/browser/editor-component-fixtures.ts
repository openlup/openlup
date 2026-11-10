import type { Page, Route } from '@playwright/test';
import type { EditorCandidate, EditorSubscription } from '../shared/subscription-edit.ts';
import type { SizedEditContext } from '@openlup/platform/subscriptions/contracts';

export const fixtureId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const fixtureMoney = (amountMinor: number) => ({ amountMinor,currency: 'XTS' });
export function componentSubscription(): EditorSubscription {
  return { subscriptionId: fixtureId(90),status: 'active',cadenceDays: 28,nextCycleAt: '2030-11-20T12:00:00.000Z',editCutoffAt: '2030-11-17T12:00:00.000Z',
    templateVersion: 3,compositionConstraint: null,offerVersion: 'classic',canEditUpcomingPackage: true,editBlockedReason: null,recurringTotal: fixtureMoney(14000),
    lines: [[1,8,false],[2,5,false],[3,1,false],[8,2,true]].map(([n,qty,isAddon],index) => ({ lineId: fixtureId(20+index),variantId: fixtureId(Number(n)),qty: Number(qty),isAddon: Boolean(isAddon),sortOrder: index,
      sku: `ITEM-${n}`,title: `Item ${n}`,unitPrice: fixtureMoney(1000),lineSubtotal: fixtureMoney(Number(qty)*1000) })) };
}
export function componentCatalog(): EditorCandidate[] {
  return [1,2,3,4].map(n => ({ variantId: fixtureId(n),sku: `ITEM-${n}`,groupId: fixtureId(n+100),name: { en: `Item ${n}`,pl: `Pozycja ${n}` },
    isAddon: false,sellable: true,selectable: true,physicalSize: 250,demandPerUnit: 40,sellableNow: 99 })).concat([
    { variantId: fixtureId(5),sku: 'ITEM-5',groupId: fixtureId(101),name: { en: 'Item 1',pl: 'Pozycja 1' },
      isAddon: false,sellable: true,selectable: true,physicalSize: 500,demandPerUnit: 80,sellableNow: 99 }]);
}
export function componentPreview() {
  return { preview: { subscriptionId: fixtureId(90),action: 'resize_bundle',canApply: true,blockedReason: null,nextCycleAt: '2030-11-20T12:00:00.000Z',editCutoffAt: null,templateVersion: 3 },
    lockedCycle: { locked: false,status: null },futureTemplate: { templateVersion: 3,effectiveCycleAt: '2030-12-01T12:00:00.000Z',priceAgreementPolicy: 'lock_until_edit' },
    quoteHash: 'a'.repeat(64),currentTotal: fixtureMoney(14000),newTotal: fixtureMoney(15000),delta: fixtureMoney(1000),
    packageEdit: { currentRecurringPrice: fixtureMoney(14000),newRecurringPrice: fixtureMoney(15000),delta: fixtureMoney(1000),quoteHash: 'a'.repeat(64),
      effectiveCycleAt: '2030-12-01T12:00:00.000Z',priceAgreementPolicy: 'lock_until_edit' } };
}
export async function editorComponent(page: Page,options: { sized?: boolean; optIn?: boolean } = {}) {
  const sub = componentSubscription();
  if (options.sized) { sub.offerVersion = 'sized.v1'; sub.compositionConstraint = { kind: 'unit_count',value: 14,dailyNeed: 40 }; }
  const state = { sub,catalog: componentCatalog(),preview: componentPreview(),readbackFails: false,applyFails: false,catalogFails: false,
    requests: [] as { operation: string; payload: Record<string,unknown>; key: string }[],
    previewReply: null as null | ((route: Route) => Promise<void>),marker: null as SizedEditContext['marker'],paidCycleCount: 4 };
  const reply = (route: Route,value: unknown,status = 200) => route.fulfill({ status,contentType: 'application/json',body: JSON.stringify(value) });
  await page.route('**/api/actions/*',async route => {
    const request = route.request(),operation = new URL(request.url()).pathname.split('/').at(-1)!;
    state.requests.push({ operation,payload: request.postDataJSON(),key: request.headers()['idempotency-key']! });
    if (operation === 'account.read') return reply(route,state.readbackFails ? { ok: false,code: 'starter_dependency_unavailable' } : { ok: true,value: {
      subscriptionEditors: [state.sub],renewal: { subscriptions: [{ subscriptionId: sub.subscriptionId,status: sub.status,
        nextCycleAt: sub.nextCycleAt,editCutoffAt: sub.editCutoffAt,blocker: null,action: null,payment: { healthState: 'healthy' },pause: null,winback: null }] },
    } },state.readbackFails ? 503 : 200);
    if (operation === 'subscription.catalog') {
      const context = { subscriptionId: sub.subscriptionId,clientId: fixtureId(91),binding: sub.offerVersion,templateVersion: sub.templateVersion,
        cadenceDays: sub.cadenceDays,compositionConstraint: sub.compositionConstraint ?? { kind: 'unit_count',value: 14,dailyNeed: 40 },nextCycleAt: sub.nextCycleAt,
        paidCycleCount: state.paidCycleCount,marker: state.marker,graduationLines: [],
        lines: sub.lines.map(line => ({ ...line,groupId: fixtureId(Number(line.sku!.split('-')[1])+100),quoteLine: {} })) };
      return reply(route,state.catalogFails ? { ok: false,code: 'starter_subscription_catalog_unavailable' } : { ok: true,value: { candidates: state.catalog,context } },state.catalogFails ? 503 : 200);
    }
    if (operation === 'subscription.preview') return state.previewReply ? state.previewReply(route) : reply(route,{ ok: true,value: state.preview });
    if (operation === 'subscription.command') return reply(route,state.applyFails ? { ok: false,code: 'subscription_edit_quote_expired' } : { ok: true,value: { status: 'applied' } },state.applyFails ? 409 : 200);
    return reply(route,{ ok: false,code: 'host_binding_required' },409);
  });
  return state;
}
