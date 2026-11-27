import { z } from "./validation.js";
import { isValidGtin } from "./foundationSchemas.js";
import { CATALOG_QUANTITY_UNITS, canonicalizeCatalogQuantity, parseCatalogQuantity } from "@openlup/core/catalog";
import type { CatalogDraftIssue, CatalogProductTypeDefinition, CatalogQuantity } from "./contracts/productTypes.js";
import type { CatalogDraftPayloadV3 } from "./contracts/draftV3.js";
import type { CatalogPublishedSku } from "./publicationContracts.js";
import { CatalogPublicationError, publicationDiagnostic, publicationRefuse, type Issue, type PlatformCode } from "./publicationError.js";
import { comparePublicationText } from "./publicationCodec.js";
import type { CatalogPublicationRulesModule } from "./catalogPublicationRules.js";
import type { CatalogPublicationEvidence } from "./publicationEvidence.js";
import type { PublicationIntent } from "./publicationIntent.js";
import { enablesSku } from "./publicationDraft.js";
import { equal, need } from "./publicationOperationHelpers.js";

const authoredSlug = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/u);

function resolveMassUnits(definition: CatalogProductTypeDefinition) {
  return definition.units.flatMap(unit => {
    const known = CATALOG_QUANTITY_UNITS.find(value => value.code === unit.code);
    return known ? [known] : unit.factor ? [{ ...unit, factor: unit.factor }] : [];
  });
}

/** Temporary native publication boundary, until versioned quantity readers land. */
export function catalogPublicationIntegralGrams(quantity: CatalogQuantity, definition: CatalogProductTypeDefinition): string {
  const reason = "catalog_publication_integral_grams_required";
  try {
    const units = resolveMassUnits(definition);
    const value = canonicalizeCatalogQuantity(parseCatalogQuantity(quantity, units), units);
    const divisor = 10n ** BigInt(value.scale), unscaled = BigInt(value.unscaled);
    need(value.dimension === "mass" && value.unit === "openlup:g" && unscaled > 0n && unscaled % divisor === 0n, reason);
    const grams = unscaled / divisor, maximum = 2_147_483_647n;
    need(grams <= maximum, reason);
    return grams.toString();
  } catch { return publicationRefuse(reason); }
}

export function assertCatalogPublicationMassInputs(payload: unknown, definition: CatalogProductTypeDefinition): void {
  const header = z.object({ skus: z.array(z.object({ code: z.string().optional(), netContent: z.unknown().optional() })) }).safeParse(payload);
  if (!header.success) return;
  for (const [index, sku] of header.data.skus.entries()) {
    const value = sku.netContent;
    if (value && typeof value === "object" && "dimension" in value && value.dimension === "mass") {
      try { catalogPublicationIntegralGrams(value as CatalogQuantity, definition); }
      catch (error) {
        if (!(error instanceof CatalogPublicationError)) throw error;
        throw new CatalogPublicationError(publicationDiagnostic(error, "structural", `skus.${index}.netContent`, sku.code ?? definition.key), error.outcome);
      }
    }
  }
}

type AmountBinding = { definition: CatalogProductTypeDefinition; rules: Pick<CatalogPublicationRulesModule, "validateSkuAmounts"> };

/** @experimental */
export function catalogPublicationPreparationIssues(payload: PublicationIntent, binding?: AmountBinding): CatalogDraftIssue[] {
  return preparationIssues(payload, binding);
}

export function preparationIssues(payload: PublicationIntent, binding?: AmountBinding) {
  const issues: { path: string; code: PlatformCode }[] = [];
  const add = (path: string, code: PlatformCode) => issues.push({ path, code });
  if (!authoredSlug.safeParse(payload.product.slug).success) add("product.slug", "commerce_product_slug_unsupported");
  const codes = new Set(payload.skus.map(sku => sku.code));
  const content = payload.product.sharedContent;
  for (const key of ["publicationSkus", "requestedModes", "offerMemberships"] as const)
    if (content[key].some(intent => !codes.has(intent.skuCode))) add(`product.sharedContent.${key}`, "intent_sku_absent");
  payload.skus.forEach((sku, index) => {
    const path = `skus.${index}`;
    if (!sku.code) { add(`${path}.code`, "sku_code_missing"); return; }
    if (!sku.identifiers?.some(identifier => identifier.scheme === "gs1:gtin"
      && identifier.packagingLevel === "unit" && isValidGtin(identifier.value))) add(`${path}.identifiers`, "unit_trade_identifier_missing");
    if (!binding || sku.netContent?.dimension !== "mass") return;
    try {
      if (sku.grossMass) assertCatalogPublicationGrossMass(sku.netContent, sku.grossMass, binding.definition);
      const netGrams = catalogPublicationIntegralGrams(sku.netContent, binding.definition);
      if (binding.rules.validateSkuAmounts && binding.rules.validateSkuAmounts({ code: sku.code, netGrams }) !== true)
        add(`${path}.netContent`, "catalog_publication_authored_amounts_invalid");
    } catch (error) {
      if (!(error instanceof CatalogPublicationError) || error.diagnostic.kind !== "platform") throw error;
      if (error.diagnostic.code === "catalog_publication_rule_failed") {
        throw new CatalogPublicationError(publicationDiagnostic(error, "structural", `${path}.netContent`, sku.code), error.outcome);
      }
      add(`${path}.${error.code.startsWith("catalog_publication_gross") ? "grossMass" : "netContent"}`, error.diagnostic.code);
    }
  });
  return issues;
}

/** Hard preparation guard, independent of dark/activation readiness.
 * @experimental
 */
export function assertCatalogPublicationPreparation(payload: CatalogDraftPayloadV3, binding?: AmountBinding): void {
  const [first] = preparationIssues(payload, binding);
  if (first) publicationRefuse(first.code);
}

/** Exact scaled comparison after owner-defined conversion, with no rounding or Number arithmetic.
 * @experimental
 */
export function assertCatalogPublicationGrossMass(net: CatalogQuantity, gross: CatalogQuantity | null, definition: CatalogProductTypeDefinition): void {
  need(net.dimension === "mass", "catalog_publication_mass_required_until_mc5");
  need(gross?.dimension === "mass", "catalog_publication_gross_mass_required");
  const units = resolveMassUnits(definition);
  try {
    const n = canonicalizeCatalogQuantity(parseCatalogQuantity(net, units), units);
    const g = canonicalizeCatalogQuantity(parseCatalogQuantity(gross!, units), units);
    need(g.dimension === "mass" && n.unit === g.unit && BigInt(g.unscaled) > 0n, "catalog_publication_gross_mass_invalid");
    need(BigInt(g.unscaled) * 10n ** BigInt(n.scale) >= BigInt(n.unscaled) * 10n ** BigInt(g.scale), "catalog_publication_gross_below_net");
  } catch (error) { if (error instanceof CatalogPublicationError) throw error; publicationRefuse("catalog_publication_gross_mass_invalid"); }
}

export function unresolvedPublicationDraftIssues<T extends Issue>(
  issues: readonly T[],
  retained: Pick<CatalogPublicationEvidence, "product" | "skus">,
): T[] {
  return issues.filter(issue => !(issue.kind === "platform" && (issue.code === "primary_sku_missing" && retained.product?.primarySkuId
    || issue.code === "sku_missing" && retained.skus.length > 0)));
}

/** @experimental */
export function catalogPublicationAffected(payload: PublicationIntent) {
  let wholeProduct = false;
  const created = new Set<string>(), admitted = new Set<string>(), enabling = new Set<string>();
  for (const op of payload.publication.operations) {
    if (op.op === "create_sku") created.add(op.skuCode);
    if (op.op === "set_offer_membership" && op.admitted) admitted.add(op.skuCode);
    if (op.op === "set_eligibility" && enablesSku(op)) enabling.add(op.skuCode);
    if ((op.op === "move_document_pointer" || op.op === "set_product_status" && op.status === "active"
      || op.op === "set_product_lifecycle" && op.state === "active" || op.op === "restore_product")
      && op.productSlug === payload.product.slug) wholeProduct = true;
  }
  const structural = (code: string) => wholeProduct || created.has(code) || admitted.has(code);
  return { structural, enabling,
    source: (code: string) => wholeProduct || admitted.has(code),
    priced: (sku: CatalogPublishedSku) => enabling.has(sku.code) || structural(sku.code) && sku.status === "active"
      && (sku.sellableStandalone || sku.sellableInSubscription) && sku.memberships.some(row => row.admitted),
  };
}

/** Checks a sealed media claim against the presentation and SKU before consulting installed evidence.
 * @experimental
 */
export function catalogPublicationMediaIssue(
  mediaRef: unknown,
  assets: readonly string[],
  claim?: NonNullable<CatalogDraftPayloadV3["publication"]["evidence"]["media"]>[number],
) {
  if (!mediaRef && !assets.length && !claim) return null;
  if (typeof mediaRef !== "string" || !mediaRef) return "media_reference_missing";
  if (!claim) return "media_readiness_unknown";
  // The draft seal retains its established order. Compare both sets using the
  // database order without changing signed or persisted bytes.
  return claim.mediaRef === mediaRef && equal([...assets].sort(comparePublicationText), [...claim.assetRefs].sort(comparePublicationText))
    ? null : "media_readiness_mismatch";
}
