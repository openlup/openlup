import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classicDraft, classicChanged, changeClassicQuantity, removeClassicLine, addClassicLine, distributeClassic, toggleClassicAddon,
  classicRequest, units } from '../client/editors/classic-model.ts';
import { sizedBaseline, sizedChanged, sizedFacts, sizedRequest, changeSizedQuantity, chooseSizedSize, toggleSizedGroup,
  recoverSizedCatalog, preferredSized } from '../client/editors/sized-model.ts';
import { configurations } from '../owned/store.config.ts';
import type { EditorCandidate, EditorSubscription } from '../shared/subscription-edit.ts';
import type { SizedEditContext } from '@openlup/platform/subscriptions/contracts';

const config = configurations.supplements!,policy = config.subscriptionEditing.sized;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const subscription: EditorSubscription = { subscriptionId: id(90),status: 'active',cadenceDays: 28,
  nextCycleAt: '2026-12-20T12:00:00.000Z',editCutoffAt: '2026-12-17T12:00:00.000Z',templateVersion: 3,
  compositionConstraint: { kind: 'plan_days',value: 14 },offerVersion: 'classic',canEditUpcomingPackage: true,editBlockedReason: null,recurringTotal: null,
  lines: [[1,8,false,1],[2,7,false,0],[3,2,true,2]].map(([n,qty,isAddon,sort]) => ({ lineId: id(Number(n)+20),variantId: id(Number(n)),qty: Number(qty),
    isAddon: Boolean(isAddon),sortOrder: Number(sort),sku: `ITEM-${n}`,title: `Item ${n}`,unitPrice: null,lineSubtotal: null })) };
const base = () => classicDraft(structuredClone(subscription));
test('classic opening sorts base lines, restores the saved add-on quantity and uses nominal plan days', () => {
  assert.deepEqual(base(),{ base: [{ variantId: id(2),qty: 7 },{ variantId: id(1),qty: 8 }],addons: [{ variantId: id(3),qty: 2 }],planDays: 14 });
  assert.equal(classicDraft({ ...subscription,compositionConstraint: null }).planDays,28);
});
test('classic increment/decrement changes only its target and respects configured bounds', () => {
  const draft = base(),next = changeClassicQuantity(draft,id(1),1,6,99);
  assert.deepEqual(next.base.map(line => line.qty),[7,9]);
  assert.deepEqual(changeClassicQuantity(next,id(1),-1,6,99),draft);
  assert.equal(changeClassicQuantity(draft,id(1),1,6,8),draft);
});
test('classic visible decrement stops at one and cannot cross the minimum', () => {
  const draft = { ...base(),base: [{ variantId: id(1),qty: 1 },{ variantId: id(2),qty: 5 }] };
  assert.equal(changeClassicQuantity(draft,id(1),-1,6,99),draft);
  assert.equal(changeClassicQuantity(draft,id(2),-1,6,99),draft);
});
test('classic removal never redistributes; last-line and below-minimum removal refuse', () => {
  assert.deepEqual(removeClassicLine(base(),id(2),6)?.base,[{ variantId: id(1),qty: 8 }]);
  assert.equal(removeClassicLine(base(),id(2),9),null);
  assert.equal(removeClassicLine({ ...base(),base: [{ variantId: id(1),qty: 15 }] },id(1),6),null);
});
test('classic candidates append one unit, refuse duplicates and respect group count', () => {
  const draft = base(),next = addClassicLine(draft,id(4),6);
  assert.deepEqual(next.base.at(-1),{ variantId: id(4),qty: 1 }); assert.equal(units(next.base),16);
  assert.equal(addClassicLine(draft,id(1),6),draft); assert.equal(addClassicLine(draft,id(4),2),draft);
});
test('classic even split assigns the remainder to the earlier lines', () => {
  const draft = { ...base(),base: [{ variantId: id(1),qty: 8 },{ variantId: id(2),qty: 5 },{ variantId: id(4),qty: 1 }] };
  assert.deepEqual(distributeClassic(draft).base.map(line => line.qty),[5,5,4]);
});
test('classic plan changes never resize and change detection ignores base ordering', () => {
  const draft = base(); assert.equal(classicChanged(draft,{ ...draft,base: [...draft.base].reverse() }),false);
  assert.equal(classicChanged(draft,{ ...draft,planDays: 28 }),true);
  assert.deepEqual(classicRequest(subscription,{ ...draft,planDays: 28 }).base,draft.base);
});
test('classic extras remove/restore only an agreed item at its saved quantity', () => {
  const draft = base(),removed = toggleClassicAddon(draft,draft,id(3));
  assert.deepEqual(removed.addons,[]); assert.deepEqual(toggleClassicAddon(removed,draft,id(3)),draft);
  assert.equal(toggleClassicAddon(draft,draft,id(5)),draft);
});
test('classic request carries only desired terms, the account version and explicit quote acceptance', () => {
  assert.deepEqual(classicRequest(subscription,base(),'a'.repeat(64)),{ subscriptionId: id(90),planDays: 14,base: base().base,addons: base().addons,
    expectedTemplateVersion: 3,acceptedQuoteHash: 'a'.repeat(64) });
});

function candidate(n: number,group = n,size = 250): EditorCandidate {
  return { variantId: id(n),sku: `ITEM-${n}`,groupId: id(group+100),name: { en: `Item ${group}`,pl: `Pozycja ${group}` },
    isAddon: false,sellable: true,selectable: true,physicalSize: size,demandPerUnit: size/5,sellableNow: 99 };
}
const catalog = () => [candidate(1),candidate(2),candidate(4,1,500),candidate(5,3)];
function context(): SizedEditContext {
  return { subscriptionId: id(90),clientId: id(91),binding: 'sized.v1',templateVersion: 3,cadenceDays: 28,
    compositionConstraint: { kind: 'unit_count',value: 14,dailyNeed: 20 },nextCycleAt: subscription.nextCycleAt,paidCycleCount: 4,marker: null,graduationLines: [],
    lines: [candidate(1),candidate(2)].map((item,index) => ({ lineId: id(index+10),variantId: item.variantId,sku: item.sku,groupId: item.groupId,qty: index ? 4 : 10,isAddon: false,quoteLine: {} as never })) };
}
const sized = () => sizedBaseline(context(),catalog(),policy)!;
test('sized baseline refuses missing facts, duplicate identities or mixed sizes of one group', () => {
  assert.equal(sizedBaseline(context(),[],policy),null);
  assert.equal(sizedBaseline(context(),[...catalog(),candidate(1)],policy),null);
  const current = context(); current.lines[1]!.groupId = current.lines[0]!.groupId;
  assert.equal(sizedBaseline(current,catalog(),policy),null);
});
test('sized size change keeps the full group count and every other line', () => {
  const next = chooseSizedSize(sized(),candidate(1).groupId,id(4),catalog(),policy)!;
  assert.deepEqual(next.lines.map(line => [line.variantId,line.qty]),[[id(4),10],[id(2),4]]);
  assert.equal(next.cadenceDays,28);
  assert.equal(sizedChanged(sized(),next),true);
});
test('sized replacement must support the full count; unknown stock never proves it', () => {
  for (const stock of [9,null]) {
    const facts = catalog(); facts[2]!.sellableNow = stock;
    assert.equal(chooseSizedSize(sized(),candidate(1).groupId,id(4),facts,policy),null);
  }
});
test('sized addition/removal touches one group and re-add starts at one', () => {
  const removed = toggleSizedGroup(sized(),candidate(2).groupId,catalog(),policy)!;
  assert.deepEqual(removed.lines.map(line => line.qty),[10]);
  assert.deepEqual(toggleSizedGroup(removed,candidate(2).groupId,catalog(),policy)!.lines.map(line => line.qty),[10,1]);
});
test('sized removal cannot cross the core floor and a decrement never removes a line', () => {
  const draft = sized(); draft.lines[0]!.qty = 2;
  assert.equal(toggleSizedGroup(draft,candidate(2).groupId,catalog(),policy),null);
  draft.lines[0]!.qty = 1; assert.equal(changeSizedQuantity(draft,id(1),-1,policy),null);
});
test('sized counts can be reduced at zero stock and increases require the absolute cap', () => {
  const draft = sized(); draft.lines[0]!.sellableNow = 0;
  assert.equal(changeSizedQuantity(draft,id(1),-1,policy)!.lines[0]!.qty,9);
  assert.equal(changeSizedQuantity(draft,id(1),1,policy),null);
  draft.lines[0]!.sellableNow = 10; assert.equal(changeSizedQuantity(draft,id(1),1,policy),null);
});
test('sized withdrawn lines keep their exact agreement and cannot change count', () => {
  const draft = sized(); draft.lines[0]!.withdrawn = true; draft.lines[0]!.sellable = false;
  assert.equal(changeSizedQuantity(draft,id(1),-1,policy),null);
  assert.equal(changeSizedQuantity(draft,id(1),1,policy),null);
  assert.ok(toggleSizedGroup(draft,candidate(1).groupId,catalog(),{ ...policy,minimumCoreUnits: 4 }));
});
test('sized known shortage recovers only to a configured nominal sibling; unknown stock keeps the exact SKU', () => {
  const facts = catalog(); facts[0]!.sellableNow = 0;
  const next = recoverSizedCatalog(sized(),facts,policy);
  assert.deepEqual(next.lines.map(line => [line.variantId,line.qty]),[[id(4),10],[id(2),4]]);
  facts[0]!.sellableNow = null;
  assert.equal(recoverSizedCatalog(sized(),facts,policy).lines[0]!.variantId,id(1));
});
test('sized catalogue omission keeps the exact physical label and marks the line withdrawn', () => {
  const next = recoverSizedCatalog(sized(),catalog().filter(item => item.variantId !== id(1)),policy);
  assert.equal(next.lines[0]!.physicalSize,250); assert.equal(next.lines[0]!.qty,10); assert.equal(next.lines[0]!.withdrawn,true);
});
test('sized conflicting candidates cannot be added, but compatible counts can repair a selected conflict', () => {
  const facts = catalog(); facts[0]!.selectable = false; facts[2]!.selectable = false;
  assert.equal(preferredSized(facts,candidate(1).groupId,policy),null);
  const draft = recoverSizedCatalog(sized(),facts,policy),added = toggleSizedGroup(draft,candidate(5,3).groupId,facts,policy)!;
  assert.equal(added.lines.at(-1)!.qty,1);
  assert.equal(changeSizedQuantity(draft,id(1),1,policy),null);
});
test('sized coverage uses exact size/count and rounded demand coverage, with a nonblocking raw shortfall', () => {
  assert.deepEqual(sizedFacts(sized()),{ units: 14,mass: 3500,coverageDays: 35,shortfall: false });
  const draft = sized(); draft.dailyNeed = 100; assert.equal(sizedFacts(draft).shortfall,true);
});
test('sized request keeps pinned need/count/cadence; only opt-in carries explicit consent', () => {
  const current = context(),draft = sized(),request = sizedRequest(current,draft,true);
  assert.equal(request.action,'resize_bundle');
  if (request.action !== 'resize_bundle') throw new Error('fixture');
  assert.deepEqual(request.resizeLever,{ kind: 'subscription.sized.parcel',value: { coreLines: [{ variantId: id(1),qty: 10 },{ variantId: id(2),qty: 4 }],optInToSized: true } });
  assert.deepEqual(request.compositionConstraint,{ kind: 'unit_count',value: 14,dailyNeed: 20 });
  assert.equal(sizedChanged(draft,{ ...draft,cadenceDays: 14 }),true);
});
test('sized graduation baseline is frozen core, while ordinary baseline uses the current agreement', () => {
  const current = context(); current.paidCycleCount = 2;
  current.marker = { basisTemplateVersion: 3,graduation: { cadenceDays: 56,sizeConstraint: { kind: 'unit_count',value: 6,dailyNeed: 20 },lines: [] } };
  current.graduationLines = [{ ...current.lines[0]!,qty: 6 }];
  const draft = sizedBaseline(current,catalog(),policy)!; assert.equal(draft.cadenceDays,56); assert.equal(units(draft.lines),6);
});
