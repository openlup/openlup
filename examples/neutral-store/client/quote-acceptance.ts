import { isOfferQuoteView } from './live-quote.ts';
import { ACQUISITION_TERMS_CAPABILITY } from '@openlup/platform/pricing';
import type { ActionInput } from '../shared/api.ts';
import type { OfferQuote } from '../shared/offer.ts';
import { quoteCopy } from '../owned/quote-copy.ts';
import type { PageContext } from './context.ts';
import { act } from './api.ts';
import { el } from './dom.ts';

/** Latest response wins; stale money is withheld, and a changed promise clears consent. */
export function createQuoteAcceptance(context: PageContext, summary: HTMLElement) {
  let form: HTMLFormElement;
  let generation = 0;
  let current: { binding: string; terms: string; acceptance: unknown; total: unknown } | undefined;
  const copy = quoteCopy[context.locale];
  const base = () => ({ cart: context.getCart(), configuration: context.config.id, country: context.config.market.country,
    termsRevision: context.config.legal.revision, acquisitionCapability: ACQUISITION_TERMS_CAPABILITY });
  const binding = (input: ActionInput) => JSON.stringify(Object.fromEntries(Object.entries(input)
    .filter(([key]) => !['termsAccepted','quoteAcceptance','expectedTotal','locale'].includes(key)).sort(([a],[b]) => a.localeCompare(b))));
  const values = () => ({ ...Object.fromEntries(new FormData(form).entries()), ...base() });
  const consent = () => form.querySelector<HTMLInputElement>('input[name="termsAccepted"]')!;
  async function refresh(input: ActionInput) {
    const ownGeneration = ++generation;
    const previous = current; current = undefined;
    summary.replaceChildren(el('p', {}, copy.loading));
    const result = await act('offer.validate',input,crypto.randomUUID());
    if (ownGeneration !== generation || !form.isConnected) return;
    if (!result.ok || !isOfferQuoteView(result.value) || result.value.currency !== context.config.market.currency) {
      consent().checked = false;
      summary.replaceChildren(el('p', {},copy.unavailable),el('code', {},result.ok ? 'starter_quote_unavailable' : result.code));
      return;
    }
    const value = result.value;
    const terms = JSON.stringify([value.quote,value.expectedTotal]);
    if (!previous || previous.binding !== binding(input) || previous.terms !== terms) consent().checked = false;
    current = { binding: binding(input),terms,acceptance: value.quoteAcceptance,total: value.expectedTotal };
    const validUntil = typeof value.validUntil === 'string' ? Date.parse(value.validUntil) : null;
    if (value.acquisitionTerms !== undefined && (!validUntil || validUntil <= Date.now())) {
      current = undefined; consent().checked = false; summary.replaceChildren(el('p', {},copy.unavailable)); return;
    }
    if (validUntil) setTimeout(() => {
      if (ownGeneration !== generation || !form.isConnected) return;
      current = undefined; consent().checked = false; summary.replaceChildren(el('p', {},copy.refresh));
    }, Math.max(0,validUntil - Date.now()));
    const display = context.fragments.checkoutSummary(context,value as unknown as OfferQuote);
    summary.replaceChildren(display);
    if (Number.isSafeInteger(value.secondTotalMinor) && typeof value.secondTotalMinor === 'number') {
      summary.append(el('p', {},`${copy.second}: ${context.money(value.secondTotalMinor)}`));
    }
  }
  return { input: base,
    attach(element: HTMLElement) {
      form = element as HTMLFormElement;
      form.addEventListener('change',event => {
        if ((event.target as HTMLInputElement).name !== 'termsAccepted') void refresh(values());
      });
      queueMicrotask(() => { if (form.isConnected) void refresh(values()); });
    },
    refused(code: string) {
      if (code === 'starter_quote_refresh_required' || code.startsWith('acquisition_terms_')) {
        current = undefined; ++generation; consent().checked = false; summary.replaceChildren(el('p', {},copy.refresh));
      }
    },
    async prepare(input: ActionInput): Promise<ActionInput | null> {
      if (context.getCart().mode === 'one_time') return input;
      if (!current || current.binding !== binding(input)) { await refresh(input); consent().checked = false; return null; }
      const accepted = current;
      await refresh(input);
      if (!current || accepted.terms !== current.terms || !consent().checked) {
        summary.append(el('p', {},copy.refresh)); return null;
      }
      return { ...input,quoteAcceptance: current.acceptance,expectedTotal: current.total };
    },
  };
}
