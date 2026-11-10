import type { SizedEditContext, SizedEditPreview, SizedEditRequest } from '@openlup/platform/subscriptions/contracts';
import type { EditorCandidate, EditorSubscription } from '../../shared/subscription-edit.ts';
import type { PageContext } from '../context.ts';
import { el, link } from '../dom.ts';
import { routes } from '../../shared/routes.ts';
import { isRecord } from '../../shared/offer.ts';
import { units } from '../editors/classic-model.ts';
import { sizedBaseline, sizedChanged, sizedFacts, sizedRequest, validSized, changeSizedQuantity, chooseSizedSize,
  toggleSizedGroup, recoverSizedCatalog, sizedSizeAllowed, type SizedDraft } from '../editors/sized-model.ts';
import { editorAction, editorAccount, text, notice, control, date, quoteRows, key, replaceEditor } from '../editors/view.ts';

type Preview = { response: SizedEditPreview; request: SizedEditRequest; identity: string; commandKey: string };
/** A page instance owns its draft and ignores asynchronous replies from an older generation. */
export function sizedEditorPage(context: PageContext): HTMLElement {
  const root = el('div',{},el('h1',{},text(context,'sized')),el('p',{ role: 'status' },text(context,'loading')));
  const id = context.query.get('subscription') ?? '',optIn = context.query.get('optIn') === '1',policy = context.config.subscriptionEditing.sized;
  let subscription: EditorSubscription, saved: SizedEditContext | null = null;
  let catalog: EditorCandidate[] = [],baseline: SizedDraft | null = null,draft: SizedDraft | null = null;
  let identity = '',preview: Preview | null = null,busy = false,loading = false,catalogFailed = false,needsReadback = false;
  let error = '',generation = 0,operation = 0;
  const fixed = () => saved?.marker !== null && saved !== null && (saved.paidCycleCount+1 <= policy.fixedThroughCycle
    || optIn && saved.paidCycleCount+1 === policy.graduationCycle && saved.templateVersion === saved.marker?.basisTemplateVersion);
  function change(next: SizedDraft | null) {
    if (!next) return;
    generation++; operation++; draft = next; preview = null; error = ''; busy = false; render();
  }
  async function loadCatalog(retain: boolean) {
    generation++; const currentOperation = ++operation;
    preview = null; loading = true; catalogFailed = false; render();
    try {
      const result = await editorAction('subscription.catalog',{ subscriptionRef: id,mode: 'sized',...(optIn ? { optIn: true } : {}) });
      if (operation !== currentOperation) return;
      if (!isRecord(result) || !isRecord(result.context) || !Array.isArray(result.candidates)) throw new Error('catalog_unavailable');
      const priorVersion = saved?.templateVersion;
      saved = result.context as unknown as SizedEditContext; catalog = result.candidates as EditorCandidate[];
      identity = JSON.stringify([saved.templateVersion,catalog]);
      baseline = sizedBaseline(saved,catalog,policy) ?? (retain && priorVersion === saved.templateVersion ? baseline : null);
      draft = retain && draft ? recoverSizedCatalog(draft,catalog,policy) : baseline ? structuredClone(baseline) : null;
    } catch (caught) {
      if (operation !== currentOperation) return;
      catalogFailed = true; error = caught instanceof Error ? notice(context,caught.message) : text(context,'catalogUnavailable');
    } finally { if (operation === currentOperation) { loading = false; render(); } }
  }
  function canReview(): boolean {
    if (!draft || !baseline || !saved || loading || busy || needsReadback || catalogFailed || !identity || fixed()
      || !validSized(draft,policy) || !optIn && !sizedChanged(baseline,draft)) return false;
    return draft.lines.every(line => {
      const agreed = baseline!.lines.find(item => item.variantId === line.variantId);
      return catalog.find(item => item.variantId === line.variantId)?.selectable !== false
        && (!line.withdrawn || agreed?.qty === line.qty)
        && (line.sellable && line.sellableNow !== null && line.qty <= line.sellableNow || agreed !== undefined && line.qty <= agreed.qty);
    });
  }
  function render() {
    if (!subscription) return;
    const page = el('section',{ class: 'panel','data-testid': 'sized-editor' },el('h1',{},text(context,'sized')));
    if (!subscription.canEditUpcomingPackage) {
      page.append(el('p',{ role: 'alert' },notice(context,subscription.editBlockedReason ?? 'unavailable')),
        link(text(context,'close'),routes.account[context.locale])); replaceEditor(root,page); return;
    }
    if (optIn) page.append(el('p',{},text(context,'invitationBody')));
    if (fixed()) {
      page.append(el('p',{ role: 'alert' },text(context,'fixed')));
      if (saved?.marker) page.append(el('p',{},text(context,'graduation',{ days: saved.marker.graduation.cadenceDays,
        count: units(saved.graduationLines.filter(line => !line.isAddon)) })));
    } else if (loading) page.append(el('p',{ role: 'status' },text(context,'catalogLoading')));
    else if (catalogFailed) page.append(el('p',{ role: 'alert' },text(context,'catalogUnavailable')));
    else if (!draft || !baseline || !saved) page.append(el('p',{ role: 'alert' },text(context,'needUnavailable')));
    else if (preview) {
      const response = preview.response;
      page.append(quoteRows(context,response.currentTotal!,response.newTotal!,response.delta!),
        el('ul',{},...draft.lines.map(line => el('li',{},`${line.qty} × ${line.name[context.locale]} · ${line.physicalSize} g`))),
        el('p',{},text(context,'everyDays',{ days: draft.cadenceDays })),
        el('p',{},text(context,'renewalDate',{ date: date(context,response.packageEdit?.effectiveCycleAt ?? response.futureTemplate.effectiveCycleAt) })));
      if (optIn) page.append(el('p',{ 'data-testid': 'opt-in-consent' },text(context,'consent')));
      page.append(el('div',{ class: 'actions' },control(text(context,'back'),() => { preview = null; render(); },busy),
        control(text(context,optIn ? 'confirmOptIn' : 'confirm'),confirm,busy || preview.identity !== identity)));
    } else {
      const facts = sizedFacts(draft);
      page.append(el('div',{ 'aria-live': 'polite','data-testid': 'coverage-summary' },el('p',{},text(context,'units',{ count: facts.units })),
        el('p',{},text(context,'mass',{ mass: facts.mass })),el('p',{},text(context,'coverage',{ days: facts.coverageDays }))));
      if (draft.constraint.mode !== policy.portionModes.reduced.mode && facts.shortfall) page.append(el('p',{},text(context,'shortfall')));
      const cadence = el('fieldset',{},el('legend',{},text(context,'plan')));
      for (const days of policy.allowedCadences) {
        const choice = control(text(context,'everyDays',{ days }),() => change({ ...draft!,cadenceDays: days }),busy);
        choice.setAttribute('aria-pressed',String(days === draft.cadenceDays)); cadence.append(choice);
      }
      page.append(cadence,el('p',{},text(context,'minimum',{ count: policy.minimumCoreUnits })));
      for (const line of draft.lines) {
        const name = line.name[context.locale], currentDraft = draft;
        const select = el('select',{ 'aria-label': text(context,'size',{ name }),'data-focus': `size-${line.groupId}` });
        for (const product of catalog.filter(item => item.groupId === line.groupId).sort((a,b) => a.physicalSize-b.physicalSize)) {
          const option = el('option',{ value: product.variantId },text(context,'sizeValue',{ size: product.physicalSize }));
          option.selected = product.variantId === line.variantId; option.disabled = !sizedSizeAllowed(line,product); select.append(option);
        }
        if (![...select.options].some(option => option.value === line.variantId)) select.append(el('option',{ value: line.variantId,selected: true },text(context,'sizeValue',{ size: line.physicalSize })));
        select.disabled = busy;
        select.addEventListener('change',() => change(chooseSizedSize(currentDraft,line.groupId,select.value,catalog,policy)));
        const remove = control(text(context,'remove',{ name }),() => {
          const next = toggleSizedGroup(draft!,line.groupId,catalog,policy);
          if (next) change(next);
          else { error = draft!.lines.length === 1 ? text(context,'lastLine') : text(context,'removeMinimum',{ remaining: units(draft!.lines)-line.qty,minimum: policy.minimumCoreUnits }); render(); }
        },busy);
        if (!toggleSizedGroup(draft,line.groupId,catalog,policy)) remove.setAttribute('aria-disabled','true');
        const row = el('div',{ class: 'panel','data-testid': `editor-group-${line.groupId}` },el('h3',{},name),select,
          el('p',{},`${line.qty} × ${line.physicalSize} g`),el('output',{ 'aria-label': text(context,'quantity') },line.qty),
          control(text(context,'decrease',{ name }),() => change(changeSizedQuantity(draft!,line.variantId,-1,policy)),busy || !changeSizedQuantity(draft,line.variantId,-1,policy)),
          control(text(context,'increase',{ name }),() => change(changeSizedQuantity(draft!,line.variantId,1,policy)),busy || !changeSizedQuantity(draft,line.variantId,1,policy)),remove);
        if (!line.selectable) row.append(el('p',{ role: 'alert' },text(context,'exclusion')));
        if (line.withdrawn) row.append(el('p',{},text(context,'withdrawn')));
        if (line.sellableNow === null || line.sellableNow < line.qty) row.append(el('p',{},text(context,'stock')));
        page.append(row);
      }
      const candidates = el('fieldset',{},el('legend',{},text(context,'candidates')));
      for (const group of [...new Set(catalog.filter(item => !item.isAddon).map(item => item.groupId))].filter(group => !draft!.lines.some(line => line.groupId === group))) {
        const name = catalog.find(item => item.groupId === group)!.name[context.locale];
        candidates.append(control(text(context,'add',{ name }),() => change(toggleSizedGroup(draft!,group,catalog,policy)),busy || !toggleSizedGroup(draft,group,catalog,policy)));
      }
      page.append(candidates,control(text(context,'review'),review,!canReview()));
    }
    if (error) page.append(el('p',{ role: 'alert','data-testid': 'editor-error' },error));
    if (needsReadback) page.append(control(text(context,'readback'),readback,busy));
    page.append(control(text(context,'refreshCatalog'),() => loadCatalog(true),busy || loading || needsReadback));
    if (optIn) page.append(control(text(context,'backClassic'),() => context.navigate(`${routes.classicEdit[context.locale]}?subscription=${encodeURIComponent(id)}`),busy));
    page.append(control(text(context,'close'),() => context.navigate(routes.account[context.locale]),busy));
    replaceEditor(root,page);
  }
  async function review() {
    if (!canReview()) return;
    const request = sizedRequest(saved!,draft!,optIn),commandKey = key('sized-parcel'),currentGeneration = generation,currentOperation = ++operation;
    busy = true; error = ''; render();
    try {
      const response = await editorAction('subscription.preview',{ request },commandKey) as SizedEditPreview;
      if (generation !== currentGeneration || operation !== currentOperation) return;
      if (response.preview.templateVersion !== saved!.templateVersion) { error = text(context,'saveFailed'); await readback(); return; }
      const effective = response.packageEdit?.effectiveCycleAt ?? response.futureTemplate?.effectiveCycleAt;
      if (!response.preview.canApply || !response.quoteHash || !response.currentTotal || !response.newTotal || !response.delta
        || !effective || !Number.isFinite(Date.parse(effective))) { error = notice(context,response.preview.blockedReason ?? 'unavailable'); return; }
      preview = { response,request,identity,commandKey };
    } catch (caught) {
      if (generation === currentGeneration && operation === currentOperation) {
        error = caught instanceof Error ? notice(context,caught.message) : text(context,'pricingFailed');
        if (caught instanceof Error && /catalog_(?:head|anchor)|stale_edit_catalog/u.test(caught.message)) await loadCatalog(true);
      }
    } finally { if (operation === currentOperation) { busy = false; render(); } }
  }
  async function readback() {
    try {
      const found = (await editorAccount()).find(item => item.subscriptionId === id);
      if (!found) throw new Error('account_unavailable');
      subscription = found;
      await loadCatalog(false);
      if (catalogFailed) throw new Error('catalog_unavailable');
      needsReadback = false; busy = false; render();
    } catch { needsReadback = true; busy = false; error = text(context,'saveUnconfirmed'); render(); }
  }
  async function confirm() {
    if (!preview || busy || loading || catalogFailed || preview.identity !== identity || preview.request.expectedTemplateVersion !== saved?.templateVersion) return;
    const accepted = preview,currentOperation = ++operation;
    busy = true; error = ''; render();
    try {
      await editorAction('subscription.command',{ request: { ...accepted.request,acceptedQuoteHash: accepted.response.quoteHash } },accepted.commandKey);
      if (operation !== currentOperation) return;
      const found = (await editorAccount()).find(item => item.subscriptionId === id);
      if (!found) throw new Error('account_readback_failed');
      context.navigate(`${routes.account[context.locale]}?packageSaved=1`);
    } catch (caught) {
      if (operation !== currentOperation) return;
      preview = null;
      if (caught instanceof Error && /catalog_(?:head|anchor)|stale_edit_catalog/u.test(caught.message)) { await loadCatalog(true); return; }
      needsReadback = true; error = text(context,'saveUnconfirmed'); render();
      await readback();
    } finally { if (operation === currentOperation) { busy = false; render(); } }
  }
  void (async () => {
    try {
      const found = (await editorAccount()).find(item => item.subscriptionId === id && item.offerVersion === (optIn ? 'classic' : 'sized.v1'));
      if (!found) throw new Error('subscription_unavailable');
      subscription = found; render();
      if (found.canEditUpcomingPackage) await loadCatalog(false);
    } catch (caught) { root.replaceChildren(el('h1',{},text(context,'sized')),el('p',{ role: 'alert' },caught instanceof Error ? notice(context,caught.message) : text(context,'unavailable')),
      link(text(context,'close'),routes.account[context.locale])); }
  })();
  return root;
}
