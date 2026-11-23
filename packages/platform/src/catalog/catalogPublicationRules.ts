import type { CatalogQuantity } from "@openlup/core/catalog";
import type { CatalogPackInput } from "./contracts/catalogPack.js";
import type { CatalogProductTypeInput, CatalogProductTypeRef, CatalogDraftIssue } from "./contracts/productTypes.js";
import type { RulesProduct, RulesSku } from "./contracts/publicationRuleFacts.js";
import type { CatalogPublicationFacts } from "./contracts/draftV3.js";
import { bindCatalogPublicationRules, readPublicationRulesAsset } from "./publicationRules.js";

/** Explicit inputs shared by every hook in one evaluation.
 * @experimental
 */
export interface CatalogRulesContext {
  /** The fixed evaluation instant, or null for a local check without a timestamp. */
  readonly evaluatedAt: string | null;
  readonly locale?: string;
  readonly timeZone?: string;
}

/** Export this interface as module.exports in a self-contained publication rules bundle.
 * Hooks must be pure and use only their supplied arguments.
 * @experimental
 */
export interface CatalogPublicationRulesModule {
  /** Check the supplied draft content and return field paths and stable reason codes. */
  validateContent(content: unknown, evaluation?: CatalogRulesContext): readonly CatalogDraftIssue[];
  /** Check the effective product and SKU roster with their document text. Return stable reason codes. */
  validateProduct(product: RulesProduct, skus: readonly RulesSku[], documents: readonly string[], evaluation?: CatalogRulesContext): readonly string[];
  /** Return whether the selected membership change is allowed for this SKU. */
  validateMembershipChange?(sku: Readonly<RulesSku>, change: { offerVersion: string; admitted: boolean }, evaluation?: CatalogRulesContext): boolean;
  /** Check document text and report its identity and exact canonicality. Return null for an invalid document. */
  inspectDocument(canonicalText: string, evaluation?: CatalogRulesContext): { schemaId: string; documentRef: string; productSlug: string; revisionNo: number;
    name?: string; canonicallyEncoded: boolean } | null;
  /** Return whether the authored document and the selected document text describe the same canonical value. */
  matchesDocument(document: unknown, canonicalText: string, evaluation?: CatalogRulesContext): boolean;
  /** Return the authored document identity and optional display name, or null for invalid input. */
  identifyDocument(document: unknown, evaluation?: CatalogRulesContext): { schemaId: string; documentRef: string; productSlug: string; revisionNo: number; name?: string } | null;
  /** Apply the installed net-amount rule to the SKU and positive integer grams. */
  validateSkuAmounts?(sku: { code: string; netGrams: string }, evaluation?: CatalogRulesContext): boolean;
  /** Apply the installed rule to an authored count or volume term on the typed publication path. */
  validateTypedSkuAmounts?(sku: { code: string; netContent: CatalogQuantity }, evaluation?: CatalogRulesContext): boolean;
  /** Return scalar published SKU facts derived from the selected document and SKU. */
  deriveSkuFacts(canonicalText: string, sku: RulesSku, evaluation?: CatalogRulesContext): CatalogPublicationFacts;
  /** Classify a change to an existing SKU using the before and after product and document. */
  classifySkuChange(before: RulesSku, after: RulesSku, context: {
    beforeProduct: RulesProduct; afterProduct: RulesProduct;
    beforeDocument: string | null; afterDocument: string;
  }, evaluation?: CatalogRulesContext): "compatible" | "material" | "inconclusive";
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
export function loadCatalogRules(artifact: Uint8Array, evaluation?: CatalogRulesContext): Readonly<CatalogPublicationRulesModule> {
  return readPublicationRulesAsset(artifact, evaluation);
}
