import { admitsTerms, quantityChoices, type SubscriptionOffer } from '../../shared/subscription-offer.ts';
import type { EditorCandidate } from '../../shared/subscription-edit.ts';
import type { PackageEditLine, PackageEditRequest } from '@openlup/platform/subscriptions/contracts';
import type { EditorSubscription } from '../../shared/subscription-edit.ts';

export interface ClassicDraft { base: PackageEditLine[]; addons: PackageEditLine[]; planDays: number }
export const units = (lines: readonly PackageEditLine[]) => lines.reduce((sum,line) => sum + line.qty,0);
export function classicDraft(subscription: EditorSubscription): ClassicDraft {
  const constraint = subscription.compositionConstraint;
  return { base: subscription.lines.filter(line => !line.isAddon).sort((a,b) => a.sortOrder-b.sortOrder).map(line => ({ variantId: line.variantId,qty: line.qty })),
    addons: subscription.lines.filter(line => line.isAddon).map(line => ({ variantId: line.variantId,qty: line.qty })),
    planDays: constraint?.kind === 'plan_days' && typeof constraint.value === 'number' ? constraint.value : subscription.cadenceDays };
}
const equalLines = (left: readonly PackageEditLine[],right: readonly PackageEditLine[]) => left.length === right.length
  && left.every(line => right.some(other => line.variantId === other.variantId && line.qty === other.qty));
export function classicChanged(before: ClassicDraft,after: ClassicDraft): boolean {
  return before.planDays !== after.planDays || !equalLines(before.base,after.base) || !equalLines(before.addons,after.addons);
}
export function changeClassicQuantity(draft: ClassicDraft,id: string,direction: -1 | 1,minimum: number,maximum: number, offer?: SubscriptionOffer, catalog: readonly EditorCandidate[] = []): ClassicDraft {
  const line = draft.base.find(item => item.variantId === id);
  if (!line || direction < 0 && (line.qty <= 1 || units(draft.base) <= minimum) || direction > 0 && line.qty >= maximum) return draft;
  const quantities = offer ? quantityChoices(offer,catalog.find(item => item.variantId === id)?.sku ?? '',draft.planDays) : [];
  const quantity = offer ? (direction > 0 ? quantities.find(qty => qty > line.qty) : quantities.findLast(qty => qty < line.qty)) : line.qty+direction;
  if (quantity === undefined || units(draft.base)-line.qty+quantity < minimum) return draft;
  return { ...draft,base: draft.base.map(item => item === line ? { ...item,qty: quantity } : item) };
}
export function removeClassicLine(draft: ClassicDraft,id: string,minimum: number): ClassicDraft | null {
  const next = draft.base.filter(line => line.variantId !== id);
  return next.length < 1 || units(next) < minimum ? null : { ...draft,base: next };
}
export function addClassicLine(draft: ClassicDraft,id: string,maximumLines: number, quantity = 1): ClassicDraft {
  return draft.base.length >= maximumLines || draft.base.some(line => line.variantId === id) ? draft
    : { ...draft,base: [...draft.base,{ variantId: id,qty: quantity }] };
}
export function distributeClassic(draft: ClassicDraft): ClassicDraft {
  const total = units(draft.base),count = draft.base.length,base = Math.floor(total/count),remainder = total-base*count;
  return { ...draft,base: draft.base.map((line,index) => ({ ...line,qty: base+(index<remainder ? 1 : 0) })) };
}
export function toggleClassicAddon(draft: ClassicDraft,baseline: ClassicDraft,id: string): ClassicDraft {
  const saved = baseline.addons.find(line => line.variantId === id);
  if (!saved) return draft;
  return { ...draft,addons: draft.addons.some(line => line.variantId === id)
    ? draft.addons.filter(line => line.variantId !== id) : [...draft.addons,{ ...saved }] };
}
export function classicRequest(subscription: EditorSubscription,draft: ClassicDraft,hash?: string): PackageEditRequest {
  return { subscriptionId: subscription.subscriptionId,planDays: draft.planDays,base: draft.base,addons: draft.addons,
    expectedTemplateVersion: subscription.templateVersion,...(hash ? { acceptedQuoteHash: hash } : {}) };
}

export function validClassic(draft: ClassicDraft, offer: SubscriptionOffer, catalog: readonly Pick<EditorCandidate,'variantId' | 'sku'>[]): boolean {
  const resolve = (line: PackageEditLine) => ({ sku: catalog.find(item => item.variantId === line.variantId)?.sku ?? '',qty: line.qty });
  return admitsTerms(offer,draft.planDays,draft.base.map(resolve),draft.addons.map(resolve));
}
