import {
  CATALOG_FACTS_POLICY_PROVENANCE_VERSION,
  CATALOG_FACTS_PROVENANCE_VERSION,
  catalogFactsProvenanceSchema,
  type CatalogFactsProvenance,
} from "../../../src/domains/commerce/catalogFactsProvenance.js";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import { CommerceQuoteError } from "../../../src/domains/commerce/ports.js";
import type { CommerceQuoteCatalogItem } from "./commerceQuoteCatalogReadPort.js";

type ResolvedPriceObservation = {
  priceEntryId: string;
  unitPriceMinor: number;
};

type StrictCatalogFactsItem = CommerceQuoteCatalogItem & {
  documentRevision: { id: string; digest: string };
};

type PolicyDerivedSubscriptionFacts = {
  policyRevisionId: string;
  policyDigest: string;
};

export function createCatalogFactsProvenance(input: {
  item: StrictCatalogFactsItem;
  resolved: ResolvedPriceObservation;
  base: ResolvedPriceObservation;
  mode: "one_time" | "subscription";
  atTime: string;
  currency: string;
  resolvedUnitAmountMinor: number;
  resolvedLineAmountMinor: number;
  baseUnitAmountMinor: number;
  policy?: PolicyDerivedSubscriptionFacts;
}): CatalogFactsProvenance {
  if (input.policy) {
    if (input.mode !== "subscription") {
      throw new CommerceQuoteError("PRICING_INVARIANT_VIOLATION", "One-time quote facts cannot carry a subscription policy");
    }
    return catalogFactsProvenanceSchema.parse({
      version: CATALOG_FACTS_POLICY_PROVENANCE_VERSION,
      skuId: input.item.skuId,
      documentRevisionId: input.item.documentRevision.id,
      documentDigest: input.item.documentRevision.digest,
      basePriceEntryId: input.base.priceEntryId,
      policyRevisionId: input.policy.policyRevisionId,
      policyDigest: input.policy.policyDigest,
      mode: input.mode,
      atTime: input.atTime,
      currency: input.currency,
      resolvedUnitAmountMinor: input.resolvedUnitAmountMinor,
      resolvedLineAmountMinor: input.resolvedLineAmountMinor,
      baseUnitAmountMinor: input.baseUnitAmountMinor,
    });
  }
  return catalogFactsProvenanceSchema.parse({
    version: CATALOG_FACTS_PROVENANCE_VERSION,
    skuId: input.item.skuId,
    documentRevisionId: input.item.documentRevision.id,
    documentDigest: input.item.documentRevision.digest,
    resolvedPriceEntryId: input.resolved.priceEntryId,
    basePriceEntryId: input.base.priceEntryId,
    mode: input.mode,
    atTime: input.atTime,
    currency: input.currency,
    resolvedUnitAmountMinor: input.resolvedUnitAmountMinor,
    resolvedLineAmountMinor: input.resolvedLineAmountMinor,
    baseUnitAmountMinor: input.baseUnitAmountMinor,
  });
}

export function catalogFactsForQuoteLine(
  enabled: boolean, item: CommerceQuoteCatalogItem, resolved: ResolvedPriceObservation,
  base: ResolvedPriceObservation, mode: "one_time" | "subscription",
  atTime: string, currency: string, resolvedUnitAmountMinor: number,
  resolvedLineAmountMinor: number, baseUnitAmountMinor: number,
  policy?: PolicyDerivedSubscriptionFacts,
): CatalogFactsProvenance | undefined {
  if (!enabled) return undefined;
  const { id, digest } = item.documentRevision;
  if (id === null || digest === null) {
    throw new CommerceQuoteError("PRICE_NOT_CONFIGURED", "Strict catalog facts are unavailable", {
      sku: item.skuCode,
      variantId: item.variantId,
    });
  }
  return createCatalogFactsProvenance({
    item: { ...item, documentRevision: { id, digest } },
    resolved, base, mode, atTime, currency, resolvedUnitAmountMinor, resolvedLineAmountMinor, baseUnitAmountMinor, policy,
  });
}

/** Public responses retain every money field but never server-only catalog identifiers. */
export function projectPublicQuoteSnapshot(snapshot: CreateQuoteResponse): CreateQuoteResponse {
  return {
    ...snapshot,
    quote: {
      ...snapshot.quote,
      lines: snapshot.quote.lines.map(({ catalogFacts: _catalogFacts, ...line }) => line),
    },
  };
}
