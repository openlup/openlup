import type { SizedParcelLeverKind, SizedEditContext, SizedEditRequest } from '@openlup/platform/subscriptions/contracts';
import type { EditorCandidate, SubscriptionEditorConfig } from '../../shared/subscription-edit.ts';
import { units } from './classic-model.ts';

export interface SizedLine extends EditorCandidate { qty: number; withdrawn: boolean }
export interface SizedDraft { cadenceDays: number; dailyNeed: number; constraint: Record<string, unknown>; lines: SizedLine[] }
type Policy = SubscriptionEditorConfig['sized'];
export function sizedBaseline(context: SizedEditContext,catalog: readonly EditorCandidate[],policy: Policy): SizedDraft | null {
  const pending = context.marker && context.paidCycleCount+1 === policy.graduationCycle && context.templateVersion === context.marker.basisTemplateVersion;
  const constraint = pending ? context.marker!.graduation.sizeConstraint ?? context.compositionConstraint : context.compositionConstraint;
  if (constraint?.kind !== 'unit_count' || !Number.isSafeInteger(constraint.dailyNeed) || Number(constraint.dailyNeed) < 1
    || new Set(catalog.map(item => item.variantId)).size !== catalog.length || new Set(catalog.map(item => item.sku)).size !== catalog.length) return null;
  const core = (pending ? context.graduationLines : context.lines).filter(line => !line.isAddon), lines: SizedLine[] = [];
  for (const saved of core) {
    const product = catalog.find(item => item.variantId === saved.variantId && item.sku === saved.sku && item.groupId === saved.groupId);
    if (!product || !Number.isSafeInteger(product.physicalSize) || product.physicalSize <= 0 || !Number.isSafeInteger(product.demandPerUnit) || product.demandPerUnit <= 0) return null;
    lines.push({ ...product,qty: saved.qty,withdrawn: !product.sellable });
  }
  const draft = { cadenceDays: pending ? context.marker!.graduation.cadenceDays : context.cadenceDays,dailyNeed: Number(constraint.dailyNeed),constraint,lines };
  return validSized(draft,policy) ? draft : null;
}
export function validSized(draft: SizedDraft,policy: Policy): boolean {
  return draft.lines.length > 0 && draft.lines.length <= policy.maximumCoreLines && units(draft.lines) >= policy.minimumCoreUnits
    && policy.allowedCadences.includes(draft.cadenceDays) && new Set(draft.lines.map(line => line.groupId)).size === draft.lines.length
    && draft.lines.every(line => Number.isSafeInteger(line.qty) && line.qty > 0 && line.qty <= policy.maximumQuantity);
}
export function changeableSized(before: SizedDraft,after: SizedDraft,policy: Policy): boolean {
  return validSized(after,policy) && after.lines.every(line => {
    const old = before.lines.find(item => item.variantId === line.variantId);
    return (!line.withdrawn || old?.qty === line.qty) && (line.sellable || old !== undefined && line.qty <= old.qty)
      && (line.sellableNow !== null && line.qty <= line.sellableNow || old !== undefined && line.qty <= old.qty);
  });
}
export function changeSizedQuantity(draft: SizedDraft,id: string,direction: -1 | 1,policy: Policy): SizedDraft | null {
  const line = draft.lines.find(item => item.variantId === id);
  if (!line || line.withdrawn || direction < 0 && line.qty <= 1 || direction > 0 && (!line.sellable || !line.selectable)) return null;
  const after = { ...draft,lines: draft.lines.map(item => item === line ? { ...item,qty: item.qty+direction } : item) };
  return changeableSized(draft,after,policy) ? after : null;
}
export function preferredSized(catalog: readonly EditorCandidate[],group: string,policy: Policy,count = 1,nominalOnly = false,excluded?: string): EditorCandidate | null {
  const eligible = catalog.filter(item => item.groupId === group && !item.isAddon && item.variantId !== excluded && item.sellable && item.selectable
    && item.sellableNow !== null && item.sellableNow >= count && (!nominalOnly || policy.nominalSizes.includes(item.physicalSize)));
  return [...eligible].sort((a,b) => Number(!policy.nominalSizes.includes(a.physicalSize))-Number(!policy.nominalSizes.includes(b.physicalSize))
    || Math.abs(a.physicalSize-policy.preferredSize)-Math.abs(b.physicalSize-policy.preferredSize) || a.physicalSize-b.physicalSize)[0] ?? null;
}
export function toggleSizedGroup(draft: SizedDraft,group: string,catalog: readonly EditorCandidate[],policy: Policy): SizedDraft | null {
  const current = draft.lines.find(line => line.groupId === group),product = current ? null : preferredSized(catalog,group,policy);
  const lines = current ? draft.lines.filter(line => line !== current) : product ? [...draft.lines,{ ...product,qty: 1,withdrawn: false }] : [];
  const after = { ...draft,lines };
  return changeableSized(draft,after,policy) ? after : null;
}
export function sizedSizeAllowed(current: SizedLine,target: EditorCandidate): boolean {
  return current.variantId === target.variantId || target.sellable && target.selectable && target.sellableNow !== null && target.sellableNow >= current.qty;
}
export function chooseSizedSize(draft: SizedDraft,group: string,id: string,catalog: readonly EditorCandidate[],policy: Policy): SizedDraft | null {
  const current = draft.lines.find(line => line.groupId === group),target = catalog.find(item => item.groupId === group && item.variantId === id);
  if (!current || !target || !sizedSizeAllowed(current,target)) return null;
  const after = { ...draft,lines: draft.lines.map(line => line === current ? { ...target,qty: line.qty,withdrawn: !target.sellable } : line) };
  return changeableSized(draft,after,policy) ? after : null;
}
export function recoverSizedCatalog(draft: SizedDraft,catalog: readonly EditorCandidate[],policy: Policy): SizedDraft {
  let next = { ...draft,lines: draft.lines.map(line => {
    const product = catalog.find(item => item.variantId === line.variantId && item.sku === line.sku);
    return product ? { ...product,qty: line.qty,withdrawn: !product.sellable } : { ...line,sellable: false,sellableNow: null,withdrawn: true };
  }) };
  for (const line of next.lines) {
    // Only known stock loss admits local nominal-size recovery. Unknown stock preserves the exact line.
    if (line.sellableNow === null || line.sellableNow >= line.qty) continue;
    const replacement = preferredSized(catalog,line.groupId,policy,line.qty,true,line.variantId);
    if (replacement) next = chooseSizedSize(next,line.groupId,replacement.variantId,catalog,policy) ?? next;
  }
  return next;
}
export function sizedFacts(draft: SizedDraft) {
  const demand = draft.lines.reduce((sum,line) => sum+line.qty*line.demandPerUnit,0);
  return { units: units(draft.lines),mass: draft.lines.reduce((sum,line) => sum+line.qty*line.physicalSize,0),
    coverageDays: Math.round(demand/draft.dailyNeed*10)/10,shortfall: demand<draft.dailyNeed*draft.cadenceDays };
}
export function sizedChanged(before: SizedDraft,after: SizedDraft): boolean {
  return before.cadenceDays !== after.cadenceDays || before.lines.length !== after.lines.length
    || after.lines.some(line => before.lines.find(old => old.variantId === line.variantId)?.qty !== line.qty);
}
export function sizedRequest(context: SizedEditContext,draft: SizedDraft,optIn: boolean,hash?: string): SizedEditRequest {
  return { subscriptionId: context.subscriptionId,action: 'resize_bundle',cadenceDays: draft.cadenceDays,
    expectedTemplateVersion: context.templateVersion,compositionConstraint: { ...draft.constraint,value: units(draft.lines) },
    resizeLever: { kind: 'subscription.sized.parcel' satisfies SizedParcelLeverKind,value: { coreLines: draft.lines.map(line => ({ variantId: line.variantId,qty: line.qty })),...(optIn ? { optInToSized: true } : {}) } },
    ...(hash ? { acceptedQuoteHash: hash } : {}) };
}
