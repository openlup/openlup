import { readFileSync } from "node:fs";
import { CATALOG_QUANTITY_UNITS } from "@openlup/core/catalog";
import { z } from "zod";
import { CATALOG_CONFORMANCE_RULES, readCatalogCheckerPackageVersion } from "./catalogConformance.js";
import { CATALOG_DRAFT_MAX_BYTES, CATALOG_DRAFT_MAX_PAGE } from "./contracts/draft.js";
import { catalogDraftPayloadV3Schema } from "./draftV3Schemas.js";
import { CATALOG_MAX_AXES, catalogDefinitionMetadataSchema } from "./productTypeIssues.js";
import { publicationPriceRefusalReason, publicationRefusals, publicationRemedy, type PlatformCode } from "./publicationError.js";
import { catalogProductInputSchema, describeReleaseDraftRefusal } from "./releaseDraftBuilder.js";

type Family = "definition" | "draft" | "publication" | "price" | "advisory";
const priceCodes = new Set<string>(publicationPriceRefusalReason.options);
const draftCodes = new Set<PlatformCode>([
  "content_missing", "dimension_not_declared", "dimension_not_installed", "duplicate_dimension",
  "duplicate_option_combination", "duplicate_sku_code", "duplicate_sku_id", "duplicate_trade_identifier",
  "foreign_product_reference", "gross_mass_invalid", "gross_mass_missing", "logistics_reference_missing",
  "net_content_invalid", "net_content_missing", "net_content_option_mismatch", "option_quantity_invalid",
  "option_type_invalid", "option_value_invalid", "primary_sku_missing", "primary_sku_not_in_product",
  "sku_code_missing", "sku_missing", "slug_missing", "trade_identifier_invalid", "trade_identifier_quantity_invalid",
  "trade_identifier_scheme_unsupported", "type_not_installed", "unit_trade_identifier_missing",
]);

function publicationFamily(code: PlatformCode): Family {
  if (priceCodes.has(code) || /^(?:catalog_publication_(?:sku_)?)?price_/u.test(code)) return "price";
  return draftCodes.has(code) ? "draft" : "publication";
}

function describeCodes() {
  const conformance = Object.entries(CATALOG_CONFORMANCE_RULES).map(([code, { severity, rule, fix }]) => {
    const family: Family = severity === "warning" ? "advisory" : code.startsWith("draft_") ? "draft" : "definition";
    return { code, family, severity, cause: rule, fix };
  });
  const publication = (Object.keys(publicationRefusals) as PlatformCode[]).flatMap(code => {
    const remedy = publicationRefusals[code];
    if ("rule" in remedy) return []; // Spread from the conformance record above.
    const cause = "fix" in remedy ? ("cause" in remedy ? remedy.cause : undefined) : remedy.at(2);
    return [{ code, family: publicationFamily(code), severity: "error" as const,
      ...(cause === undefined ? {} : { cause }), fix: publicationRemedy(code) }];
  });
  const { code, cause, fix, fixVariants } = describeReleaseDraftRefusal();
  const builder = { code, family: "draft" as const, severity: "error" as const, cause, fix, fixVariants };
  return [...conformance, ...publication, builder].sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
}

type Setting = { key: string; domain: string; kind: string; goal: string; runtime: { reason: string } };

export function describeCatalogueSchema() {
  const { entries } = JSON.parse(readFileSync(new URL("../../settings-catalog.json", import.meta.url), "utf8")) as { entries: Setting[] };
  const schema = (owner: z.ZodType) => z.toJSONSchema(owner, { target: "draft-07", io: "input", reused: "inline" });
  return {
    command: "catalogue schema",
    state: "satisfied",
    exitCode: 0,
    platformVersion: readCatalogCheckerPackageVersion(),
    jsonSchemas: {
      productType: schema(catalogDefinitionMetadataSchema),
      productInput: schema(catalogProductInputSchema),
      draftV3: schema(catalogDraftPayloadV3Schema),
    },
    builtInUnits: CATALOG_QUANTITY_UNITS,
    limits: [
      { name: "CATALOG_DRAFT_MAX_BYTES", value: CATALOG_DRAFT_MAX_BYTES, appliesTo: "Canonical draft JSON in UTF-8 bytes" },
      { name: "CATALOG_DRAFT_MAX_PAGE", value: CATALOG_DRAFT_MAX_PAGE, appliesTo: "Drafts per list page" },
      { name: "CATALOG_MAX_AXES", value: CATALOG_MAX_AXES, appliesTo: "Axes per product type" },
    ],
    draft: { storedSchemaVersions: [1, 2, 3], publishableSchemaVersion: 3 },
    caps: entries.filter(({ domain, kind }) => domain === "catalog" && /^cap$/u.test(kind))
      .map(({ key, goal, runtime }) => ({ key, goal, reason: runtime.reason })),
    codes: describeCodes(),
  };
}
