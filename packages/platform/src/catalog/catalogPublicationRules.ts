import type { CatalogPackInput } from "./contracts/catalogPack.js";
import type { CatalogProductTypeInput, CatalogProductTypeRef, CatalogDraftIssue } from "./contracts/productTypes.js";
import type { RulesProduct, RulesSku } from "./contracts/publicationRuleFacts.js";
import type { CatalogPublicationFacts } from "./contracts/draftV3.js";
import { bindCatalogPublicationRules, readPublicationRulesAsset } from "./publicationRules.js";

/** Export this interface as module.exports in a self-contained publication rules bundle.
 * @experimental
 */
export interface CatalogPublicationRulesModule {
  /** Check the supplied draft content and return field paths and stable reason codes. */
  validateContent(content: unknown): readonly CatalogDraftIssue[];
  /** Check the effective product and SKU roster with their document text. Return stable reason codes. */
  validateProduct(product: RulesProduct, skus: readonly RulesSku[], documents: readonly string[]): readonly string[];
  /** Return whether the selected membership change is allowed for this SKU. */
  validateMembershipChange?(sku: Readonly<RulesSku>, change: { offerVersion: string; admitted: boolean }): boolean;
  /** Check document text and report its identity and exact canonicality. Return null for an invalid document. */
  inspectDocument(canonicalText: string): { schemaId: string; documentRef: string; productSlug: string; revisionNo: number;
    name?: string; canonicallyEncoded: boolean } | null;
  /** Return whether the authored document and the selected document text describe the same canonical value. */
  matchesDocument(document: unknown, canonicalText: string): boolean;
  /** Return the authored document identity and optional display name, or null for invalid input. */
  identifyDocument(document: unknown): { schemaId: string; documentRef: string; productSlug: string; revisionNo: number; name?: string } | null;
  /** Apply the installed net-amount rule to the SKU and positive integer grams. */
  validateSkuAmounts?(sku: { code: string; netGrams: string }): boolean;
  /** Return scalar published SKU facts derived from the selected document and SKU. */
  deriveSkuFacts(canonicalText: string, sku: RulesSku): CatalogPublicationFacts;
  /** Classify a change to an existing SKU using the before and after product and document. */
  classifySkuChange(before: RulesSku, after: RulesSku, context: {
    beforeProduct: RulesProduct; afterProduct: RulesProduct;
    beforeDocument: string | null; afterDocument: string;
  }): "compatible" | "material" | "inconclusive";
}
/** A pack can omit an inline validator when its type supplies a rules build.
 * @experimental
 */
export type CatalogPublicationRulesPack = Omit<CatalogPackInput, "types"> & { types: readonly (Omit<CatalogProductTypeInput, "validateContent">
  & Partial<Pick<CatalogProductTypeInput, "validateContent">>)[] };

/** Attach built rules to a pack during deployment. Installation derives and verifies their identity.
 * @experimental
 */
export function withCatalogPublicationRules<P extends CatalogPackInput>(pack: P,
  rulesFor: (type: CatalogProductTypeRef) => Uint8Array | undefined): P;
/** @experimental */
export function withCatalogPublicationRules(pack: CatalogPublicationRulesPack,
  rulesFor: (type: CatalogProductTypeRef) => Uint8Array | undefined): CatalogPackInput;
export function withCatalogPublicationRules(pack: CatalogPublicationRulesPack,
  rulesFor: (type: CatalogProductTypeRef) => Uint8Array | undefined): CatalogPackInput {
  return bindCatalogPublicationRules(pack, rulesFor);
}

/** Load a rules build for local tests under the same execution limits as installation.
 * @experimental
 */
export function loadCatalogRules(artifact: Uint8Array): Readonly<CatalogPublicationRulesModule> {
  return readPublicationRulesAsset(artifact);
}
