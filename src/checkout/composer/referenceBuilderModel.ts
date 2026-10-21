import { ACQUISITION_TERMS_CAPABILITY, type AcquisitionQuoteRequest } from "@openlup/platform/pricing/contracts";
import type { SellableCatalogItem } from "@/domains/catalog/contracts";
import { referenceQuoteConsentMatches, referenceQuoteExpectation, type ReferenceQuote, type ReferenceQuoteExpectation } from "./referenceQuoteConsent";

export interface ReferenceSelection {
  mode: "one_time" | "subscription";
  lines: { sku: string; quantity: number }[];
  cadenceDays?: number;
}
export interface ReferenceBuilderDraft {
  selection: ReferenceSelection;
  customer: { email: string };
  termsConsent: boolean;
  expectation: ReferenceQuoteExpectation | null;
}
export interface ReferenceSelectedQuote {
  requestKey: string;
  loading: boolean;
  error: string | null;
  quote: ReferenceQuote | null;
}
export interface ReferenceBuilderBindings {
  /** Separate opt-in transport, never the incumbent quote endpoint or cache. */
  quote(request: AcquisitionQuoteRequest): Promise<ReferenceQuote>;
  continue(draft: ReferenceBuilderDraft): void;
  /** A deployment-scoped storage identity; never an incumbent configurator key. */
  draftKey: string;
}

export function referenceQuoteRequest(selection: ReferenceSelection, items: readonly SellableCatalogItem[]): AcquisitionQuoteRequest | null {
  if (!selection.lines.length || new Set(selection.lines.map(line => line.sku)).size !== selection.lines.length) return null;
  if (selection.mode === "subscription" && (typeof selection.cadenceDays !== "number" || !Number.isInteger(selection.cadenceDays) || selection.cadenceDays <= 0)) return null;
  if (selection.lines.some(line => !Number.isInteger(line.quantity) || line.quantity <= 0 ||
    !items.find(item => item.sku === line.sku)?.permittedPurchaseModes.includes(selection.mode))) return null;
  return {
    mode: selection.mode,
    lines: selection.lines.map(line => ({ ...line })),
    promoCodes: [],
    ...(selection.mode === "subscription" ? { cadenceDays: selection.cadenceDays } : {}),
    acquisitionCapability: ACQUISITION_TERMS_CAPABILITY,
  };
}
export function referenceRequestKey(request: AcquisitionQuoteRequest): string { return JSON.stringify(request); }

export function canNavigateReferenceBuilder(draft: ReferenceBuilderDraft, selected: ReferenceSelectedQuote, request: AcquisitionQuoteRequest | null): boolean {
  return Boolean(request && draft.termsConsent && !selected.loading && !selected.error &&
    selected.requestKey === referenceRequestKey(request) && referenceQuoteConsentMatches(draft.expectation, selected.quote));
}
export function acceptReferenceQuote(draft: ReferenceBuilderDraft, selected: ReferenceSelectedQuote, request: AcquisitionQuoteRequest | null): ReferenceBuilderDraft {
  if (!request || selected.loading || selected.error || selected.requestKey !== referenceRequestKey(request) || !selected.quote) return { ...draft, termsConsent: false, expectation: null };
  const expectation = referenceQuoteExpectation(selected.quote);
  return { ...draft, termsConsent: expectation !== null, expectation };
}
/** An accepted basket edit invalidates promise and terms while retaining customer facts. */
export function changeReferenceSelection(draft: ReferenceBuilderDraft, selection: ReferenceSelection): ReferenceBuilderDraft {
  return { ...draft, selection, expectation: null, termsConsent: false };
}
