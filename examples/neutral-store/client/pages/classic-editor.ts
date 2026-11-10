import type { PackageEditPreview } from '@openlup/platform/subscriptions/contracts';
import type { EditorCandidate, EditorSubscription } from '../../shared/subscription-edit.ts';
import type { PageContext } from '../context.ts';
import { el, link } from '../dom.ts';
import { routes } from '../../shared/routes.ts';
import { classicDraft, classicChanged, classicRequest, changeClassicQuantity, removeClassicLine, addClassicLine,
  distributeClassic, toggleClassicAddon, units, type ClassicDraft } from '../editors/classic-model.ts';
import { editorAction, editorAccount, text, notice, control, date, quoteRows, key, replaceEditor } from '../editors/view.ts';
import { isRecord } from '../../shared/offer.ts';

export function classicEditorPage(context: PageContext): HTMLElement {
  const root = el('div',{},el('h1',{},text(context,'classic')),el('p',{ role: 'status' },text(context,'loading')));
  const values = context.config.subscriptionEditing;
  let subscription: EditorSubscription, baseline: ClassicDraft, draft: ClassicDraft;
  let catalog: EditorCandidate[] = [], catalogLoading = true, catalogFailed = false;
  let preview: PackageEditPreview['packageEdit'] | null = null, previewing = false, applying = false;
  let error = '', lineError: { id: string; message: string } | null = null;
  const id = context.query.get('subscription') ?? '';
  const label = (variantId: string) => catalog.find(product => product.variantId === variantId)?.name[context.locale]
    ?? subscription.lines.find(line => line.variantId === variantId)?.title ?? variantId;
  const changed = () => classicChanged(baseline,draft);
  function change(next: ClassicDraft) { draft = next; preview = null; error = ''; lineError = null; render(); }
  function render() {
    const page = el('section',{ class: 'panel','data-testid': 'classic-editor' },el('h1',{},text(context,preview ? 'reviewTitle' : 'classic')));
    if (!subscription.canEditUpcomingPackage) {
      page.append(el('p',{ role: 'alert' },notice(context,subscription.editBlockedReason ?? 'unavailable')),
        link(text(context,'close'),routes.account[context.locale])); replaceEditor(root,page); return;
    }
    if (preview) {
      page.append(quoteRows(context,preview.currentRecurringPrice,preview.newRecurringPrice,preview.delta),
        el('h2',{},text(context,'proposedPackage')),
        el('ul',{},...draft.base.map(line => el('li',{},`${line.qty} × ${label(line.variantId)}`)),
          ...draft.addons.map(line => el('li',{},`${line.qty} × ${label(line.variantId)}`))),
        el('p',{},text(context,'everyDays',{ days: draft.planDays })),
        el('p',{},text(context,'nextCycle',{ date: date(context,preview.effectiveCycleAt) })),
        el('p',{},text(context,'pricePolicy',{ date: date(context,preview.effectiveCycleAt) })),
        el('div',{ class: 'actions' },control(text(context,'back'),() => { preview = null; render(); },applying),
          control(text(context,'confirm'),confirm,applying || !changed())));
    } else {
      page.append(el('h2',{},text(context,'currentPackage')),
        el('ul',{},...subscription.lines.map(line => el('li',{},`${line.qty} × ${label(line.variantId)}`))),
        el('p',{},text(context,'minimum',{ count: values.minimumBaseUnits })));
      if (units(draft.base) < values.minimumBaseUnits) page.append(el('p',{ role: 'alert','data-testid': 'minimum-banner' },text(context,'belowMinimum')));
      const lines = el('fieldset',{},el('legend',{},text(context,'proposedPackage')));
      for (const line of draft.base) {
        const name = label(line.variantId), remaining = units(draft.base)-line.qty;
        const refusal = draft.base.length <= 1 ? text(context,'lastLine') : remaining < values.minimumBaseUnits
          ? text(context,'removeMinimum',{ remaining,minimum: values.minimumBaseUnits }) : null;
        const remove = control(text(context,'remove',{ name }),() => {
          const next = removeClassicLine(draft,line.variantId,values.minimumBaseUnits);
          if (next) change(next); else { lineError = { id: line.variantId,message: refusal! }; render(); }
        },previewing);
        const hint = `remove-${line.variantId}`;
        if (refusal) { remove.setAttribute('aria-disabled','true'); remove.setAttribute('aria-describedby',hint); }
        const row = el('div',{ class: 'panel','data-testid': `editor-line-${line.variantId}` },el('h3',{},name),
          el('p',{},`${line.qty} × ${catalog.find(item => item.variantId === line.variantId)?.physicalSize ?? '—'} g`),
          el('output',{ 'aria-label': text(context,'quantity') },line.qty),
          control(text(context,'decrease',{ name }),() => change(changeClassicQuantity(draft,line.variantId,-1,values.minimumBaseUnits,values.maximumQuantity)),
            previewing || line.qty <= 1 || units(draft.base) <= values.minimumBaseUnits),
          control(text(context,'increase',{ name }),() => change(changeClassicQuantity(draft,line.variantId,1,values.minimumBaseUnits,values.maximumQuantity)),previewing || line.qty >= values.maximumQuantity),remove);
        if (refusal) row.append(el('p',{ id: hint,class: 'small' },refusal));
        if (lineError?.id === line.variantId) row.append(el('p',{ role: 'alert' },lineError.message));
        lines.append(row);
      }
      lines.append(control(text(context,'distribute'),() => change(distributeClassic(draft)),previewing));
      const candidates = el('fieldset',{},el('legend',{},text(context,'candidates')));
      for (const item of catalog.filter(product => product.selectable && product.sellable && !product.isAddon && !draft.base.some(line => line.variantId === product.variantId))) {
        const add = control(text(context,'add',{ name: item.name[context.locale] }),() => change(addClassicLine(draft,item.variantId,values.maximumBaseLines)),previewing || draft.base.length >= values.maximumBaseLines);
        add.setAttribute('data-variant',item.variantId);
        candidates.append(el('div',{},add,el('span',{ class: 'small' },text(context,'sizeValue',{ size: item.physicalSize }))));
      }
      const plans = el('fieldset',{},el('legend',{},text(context,'plan')));
      for (const days of values.planDays) {
        const choice = control(text(context,'everyDays',{ days }),() => change({ ...draft,planDays: days }));
        choice.setAttribute('aria-pressed',String(days === draft.planDays)); plans.append(choice);
      }
      page.append(lines,candidates,plans);
      if (baseline.addons.length) page.append(el('fieldset',{},el('legend',{},text(context,'addons')),
        ...baseline.addons.map(line => control(text(context,draft.addons.some(item => item.variantId === line.variantId) ? 'removeAddon' : 'restoreAddon',
          { name: label(line.variantId),quantity: line.qty }),() => change(toggleClassicAddon(draft,baseline,line.variantId))))));
      if (catalogLoading) page.append(el('p',{ role: 'status' },text(context,'catalogLoading')));
      if (catalogFailed) page.append(el('p',{ role: 'alert' },text(context,'catalogUnavailable')));
      page.append(control(text(context,'review'),review,catalogLoading || catalogFailed || previewing || !changed() || units(draft.base) < values.minimumBaseUnits),
        el('p',{},text(context,'units',{ count: units(draft.base) })),
        el('div',{ 'data-testid': 'sized-invitation' },el('p',{},text(context,'invitationBody')),
          link(text(context,'invitation'),`${routes.sizedEdit[context.locale]}?subscription=${encodeURIComponent(id)}&optIn=1`)));
    }
    if (error) page.append(el('p',{ role: 'alert','data-testid': 'editor-error' },error));
    const close = control(text(context,'close'),() => context.navigate(routes.account[context.locale]),applying);
    page.append(close); replaceEditor(root,page);
  }
  async function review() {
    if (previewing || !changed() || catalogLoading || catalogFailed || units(draft.base) < values.minimumBaseUnits) return;
    previewing = true; error = ''; render();
    try {
      const result = await editorAction('subscription.preview',{ request: classicRequest(subscription,draft) },key('classic-preview')) as PackageEditPreview;
      if (!result.preview.canApply) { error = notice(context,result.preview.blockedReason ?? 'unavailable'); return; }
      if (!result.packageEdit) throw new Error('preview_unavailable');
      preview = result.packageEdit;
    } catch (caught) { error = caught instanceof Error && caught.message === 'subscription_reprice_below_minimum_order_units'
      ? text(context,'belowMinimum') : text(context,'pricingFailed'); }
    finally { previewing = false; render(); }
  }
  async function confirm() {
    if (applying || !preview || !changed()) return;
    applying = true; error = ''; render();
    try {
      await editorAction('subscription.command',{ request: classicRequest(subscription,draft,preview.quoteHash) },key('classic-confirm'));
      const refreshed = (await editorAccount()).find(item => item.subscriptionId === id);
      if (!refreshed) throw new Error('account_readback_failed');
      context.navigate(`${routes.account[context.locale]}?packageSaved=1`);
    } catch (caught) {
      preview = null;
      const code = caught instanceof Error ? caught.message : '';
      error = /window_closed|payment_blocked|cycle_locked/u.test(code) ? notice(context,code) : text(context,'saveFailed');
      if (/stale_template/u.test(code)) {
        try { const refreshed = (await editorAccount()).find(item => item.subscriptionId === id); if (refreshed) { subscription = refreshed; baseline = classicDraft(subscription); } } catch { /* Keep the failed draft visible. */ }
      }
    } finally { applying = false; render(); }
  }
  void (async () => {
    try {
      const found = (await editorAccount()).find(item => item.subscriptionId === id && item.offerVersion === 'classic');
      if (!found) throw new Error('subscription_unavailable');
      subscription = found; baseline = classicDraft(found); draft = structuredClone(baseline); render();
      try {
        const result = await editorAction('subscription.catalog',{ subscriptionRef: id,mode: 'classic' });
        if (!isRecord(result) || !Array.isArray(result.candidates)) throw new Error('catalog_unavailable');
        catalog = result.candidates as EditorCandidate[];
      } catch { catalogFailed = true; }
      catalogLoading = false; render();
    } catch (caught) { root.replaceChildren(el('h1',{},text(context,'classic')),el('p',{ role: 'alert' },
      caught instanceof Error ? notice(context,caught.message) : text(context,'unavailable')),link(text(context,'close'),routes.account[context.locale])); }
  })();
  return root;
}
