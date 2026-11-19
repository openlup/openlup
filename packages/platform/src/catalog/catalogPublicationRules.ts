import type { CatalogPackInput } from "./contracts/catalogPack.js";
import type { CatalogProductTypeRef, CatalogDraftIssue } from "./contracts/productTypes.js";
import type { RulesProduct, RulesSku } from "./contracts/publicationRuleFacts.js";
import type { CatalogPublicationFacts } from "./contracts/draftV3.js";
import { bindCatalogPublicationRules } from "./publicationRules.js";

/** Export this interface as module.exports in a self-contained publication rules bundle.
 * @experimental
 */
export interface CatalogPublicationRulesModule {
  validateContent(content: unknown): readonly CatalogDraftIssue[];
  validateProduct(product: RulesProduct, skus: readonly RulesSku[], documents: readonly string[]): readonly string[];
  validateMembershipChange?(sku: Readonly<RulesSku>, change: { offerVersion: string; admitted: boolean }): boolean;
  inspectDocument(canonicalText: string): { schemaId: string; documentRef: string; productSlug: string; revisionNo: number;
    name?: string; canonicallyEncoded: boolean };
  matchesDocument(document: unknown, canonicalText: string): boolean;
  identifyDocument(document: unknown): { schemaId: string; documentRef: string; productSlug: string; revisionNo: number; name?: string };
  validateSkuAmounts?(sku: { code: string; netGrams: string }): boolean;
  deriveSkuFacts(canonicalText: string, sku: RulesSku): CatalogPublicationFacts;
  classifySkuChange(before: RulesSku, after: RulesSku, context: {
    beforeProduct: RulesProduct; afterProduct: RulesProduct;
    beforeDocument: string | null; afterDocument: string;
  }): "compatible" | "material" | "inconclusive";
}
/** Attach built rules to a pack during deployment. Installation derives and verifies their identity.
 * @experimental
 */
export function withCatalogPublicationRules<P extends CatalogPackInput>(pack: P,
  rulesFor: (type: CatalogProductTypeRef) => Uint8Array | undefined): P {
  return bindCatalogPublicationRules(pack, rulesFor);
}
