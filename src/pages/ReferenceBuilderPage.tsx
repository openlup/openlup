import { formatCurrencyMinor } from "@/lib/currency/formatMinor";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReferenceCatalogSnapshot } from "@/domains/catalog/referenceCatalogUi";
import { acceptReferenceQuote, canNavigateReferenceBuilder, changeReferenceSelection, referenceQuoteRequest, referenceRequestKey, type ReferenceBuilderBindings, type ReferenceBuilderDraft, type ReferenceSelectedQuote } from "@/checkout/composer/referenceBuilderModel";
import { createReferenceBuilderDraftStore } from "@/checkout/composer/referenceBuilderDraft";

export default function ReferenceBuilderPage({ snapshot, bindings }: { snapshot: ReferenceCatalogSnapshot; bindings?: ReferenceBuilderBindings }) {
  const empty = useMemo<ReferenceBuilderDraft>(() => ({ selection: { mode: "one_time", lines: snapshot.products.map(product => ({ sku: product.item.sku, quantity: 1 })) }, customer: { email: "" }, termsConsent: false, expectation: null }), [snapshot]);
  const [draft, setDraft] = useState(empty);
  const [selected, setSelected] = useState<ReferenceSelectedQuote>({ requestKey: "", loading: false, error: null, quote: null });
  const generation = useRef(0);
  const store = useMemo(() => bindings ? createReferenceBuilderDraftStore(bindings.draftKey) : null, [bindings]);
  // SSR and the first hydration render use identical supplied facts. Reload is an enhancement.
  useEffect(() => { setDraft(store?.load() ?? empty); return () => { generation.current++; }; }, [store, empty]);
  const request = referenceQuoteRequest(draft.selection, snapshot.products.map(product => product.item));
  function save(next: ReferenceBuilderDraft) { setDraft(next); store?.save(next); }
  function edit(selection: ReferenceBuilderDraft["selection"]) {
    generation.current++;
    setSelected({ requestKey: "", loading: false, error: null, quote: null });
    save(changeReferenceSelection(draft, selection));
  }
  async function quote() {
    if (!request || !bindings) return;
    const current = ++generation.current;
    const requestKey = referenceRequestKey(request);
    setSelected({ requestKey, loading: true, error: null, quote: null });
    try {
      const result = await bindings.quote(request);
      if (current === generation.current) setSelected({ requestKey, loading: false, error: null, quote: result });
    } catch {
      if (current === generation.current) setSelected({ requestKey, loading: false, error: "quote_unavailable", quote: null });
    }
  }
  return <main lang={snapshot.profile.locale}>
    <a href={snapshot.catalogPath}>{snapshot.copy.catalog}</a><h1>{snapshot.copy.builder}</h1>
    {snapshot.products.map(product => {
      const line = draft.selection.lines.find(value => value.sku === product.item.sku);
      return <div key={product.item.sku}>
        <label><input type="checkbox" checked={Boolean(line)} onChange={event => edit({ ...draft.selection, lines: event.target.checked ? [...draft.selection.lines, { sku: product.item.sku, quantity: 1 }] : draft.selection.lines.filter(value => value.sku !== product.item.sku) })} />{product.item.title}</label>
        <label>{snapshot.copy.quantity}<input type="number" min="1" disabled={!line} value={line?.quantity ?? 1} onChange={event => edit({ ...draft.selection, lines: draft.selection.lines.map(value => value.sku === product.item.sku ? { ...value, quantity: Number(event.target.value) } : value) })} /></label>
      </div>;
    })}
    <label>{snapshot.copy.mode}<select value={draft.selection.mode} onChange={event => edit({ ...draft.selection, mode: event.target.value as "one_time" | "subscription", cadenceDays: 30 })}>
      <option value="one_time">{snapshot.copy.oneTime}</option><option value="subscription">{snapshot.copy.subscription}</option>
    </select></label>
    <button disabled={!request || !bindings || selected.loading} onClick={quote}>{snapshot.copy.quote}</button>
    {selected.quote && <output>{formatCurrencyMinor(selected.quote.totalGross.amountMinor, { currency: selected.quote.totalGross.currency, locale: snapshot.profile.locale })}{selected.quote.acquisitionTerms && <> · {snapshot.copy.secondDelivery}: {new Intl.NumberFormat(snapshot.profile.locale, { style: "percent", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(selected.quote.acquisitionTerms.delivery2DiscountBps / 10000)}</>}</output>}
    <label><input type="checkbox" checked={draft.termsConsent} disabled={!selected.quote || selected.loading || Boolean(selected.error)} onChange={event => save(event.target.checked ? acceptReferenceQuote(draft, selected, request) : { ...draft, termsConsent: false, expectation: null })} />{snapshot.copy.consent}</label>
    {selected.error && <p role="status">{snapshot.copy.refused}</p>}
    <button disabled={!canNavigateReferenceBuilder(draft, selected, request) || !bindings} onClick={() => { if (canNavigateReferenceBuilder(draft, selected, request)) bindings?.continue(draft); }}>{snapshot.copy.continue}</button>
  </main>;
}
