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
export function changeClassicQuantity(draft: ClassicDraft,id: string,direction: -1 | 1,minimum: number,maximum: number): ClassicDraft {
  const line = draft.base.find(item => item.variantId === id);
  if (!line || direction < 0 && (line.qty <= 1 || units(draft.base) <= minimum) || direction > 0 && line.qty >= maximum) return draft;
  return { ...draft,base: draft.base.map(item => item === line ? { ...item,qty: item.qty+direction } : item) };
}
export function removeClassicLine(draft: ClassicDraft,id: string,minimum: number): ClassicDraft | null {
  const next = draft.base.filter(line => line.variantId !== id);
  return next.length < 1 || units(next) < minimum ? null : { ...draft,base: next };
}
export function addClassicLine(draft: ClassicDraft,id: string,maximumLines: number): ClassicDraft {
  return draft.base.length >= maximumLines || draft.base.some(line => line.variantId === id) ? draft
    : { ...draft,base: [...draft.base,{ variantId: id,qty: 1 }] };
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
