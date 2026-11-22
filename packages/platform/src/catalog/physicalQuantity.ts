import {
  CATALOG_CANONICAL_UNITS, CATALOG_QUANTITY_UNITS, CatalogQuantityError, canonicalizeCatalogQuantity, validateCatalogUnitFactor,
  type CatalogQuantity, type CatalogQuantityCode, type CatalogQuantityUnit,
} from "@openlup/core/catalog";
import type { CatalogProductTypeInput } from "./contracts/productTypes.js";
import { CatalogPublicationError, publicationIssue } from "./publicationError.js";

type Definition = Pick<CatalogProductTypeInput, "units" | "netContentUnits">;
type QuantitySelection = { path: string; subject: string };

function decimal(value: unknown): { unscaled: string; scale: number } {
  if (!value || typeof value !== "object" || !("unscaled" in value) || typeof value.unscaled !== "string"
    || !/^[1-9][0-9]*$/u.test(value.unscaled) || !("scale" in value) || typeof value.scale !== "number"
    || !Object.hasOwn(value, "unscaled") || !Object.hasOwn(value, "scale")
    || !Number.isInteger(value.scale) || value.scale < 0) throw new CatalogQuantityError("quantity_invalid");
  if (value.unscaled.length > 40) throw new CatalogQuantityError("quantity_overflow");
  if (value.scale > 12) throw new CatalogQuantityError("quantity_not_exactly_representable");
  return { unscaled: value.unscaled, scale: value.scale };
}

class UnqualifiedQuantityUnit extends CatalogQuantityError {}

export function qualifyTypedCatalogUnit(declared: Omit<Definition["units"][number], "factor"> & { factor?: unknown }): CatalogQuantityUnit {
  const { code, dimension, integral } = declared;
  const builtIn = CATALOG_QUANTITY_UNITS.find(unit => unit.code === code);
  if (builtIn && builtIn.dimension !== dimension) throw new CatalogQuantityError("quantity_cross_dimension");
  let factor = builtIn?.factor;
  if (declared.factor !== undefined) {
    const authored = declared.factor;
    if (!authored || typeof authored !== "object" || Array.isArray(authored) || Object.keys(authored).length !== 3
      || !("canonicalUnit" in authored) || !Object.hasOwn(authored, "canonicalUnit"))
      throw new CatalogQuantityError("quantity_invalid");
    const canonicalUnit = Object.values(CATALOG_CANONICAL_UNITS).find(unit => unit === authored.canonicalUnit);
    if (!canonicalUnit) throw new CatalogQuantityError("quantity_invalid");
    factor = { canonicalUnit, ...decimal(authored) };
  }
  if (!factor) throw new CatalogQuantityError("quantity_unknown_unit");
  const unit = { code, dimension, factor, integral: builtIn?.integral ?? integral };
  validateCatalogUnitFactor(unit);
  return unit;
}

/** Resolve a selected term against one immutable declaration before multiplying. */
export function resolveTypedCatalogQuantity(input: unknown, definition: Definition,
  kind: "netContent" | "grossMass" = "netContent"): CatalogQuantity {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 4
    || !("unit" in input) || typeof input.unit !== "string" || input.unit.length > 120
    || !/^[a-z][a-z0-9.-]*:[a-z][a-z0-9._-]*$/u.test(input.unit) || !("dimension" in input)
    || !Object.hasOwn(input, "unit") || !Object.hasOwn(input, "dimension")
    || (input.dimension !== "mass" && input.dimension !== "volume" && input.dimension !== "count"))
    throw new CatalogQuantityError("quantity_invalid");
  const authored: CatalogQuantity = { ...decimal(input), dimension: input.dimension, unit: input.unit };
  if (kind === "grossMass" && authored.dimension !== "mass") throw new CatalogQuantityError("quantity_cross_dimension");
  const declared = definition.units.filter(unit => unit.code === authored.unit);
  if (declared.length > 1 || kind === "netContent" && definition.netContentUnits.filter(code => code === authored.unit).length > 1)
    throw new UnqualifiedQuantityUnit("quantity_unknown_unit");
  if (declared.length === 0 || kind === "netContent" && !definition.netContentUnits.includes(authored.unit))
    throw new CatalogQuantityError("quantity_unknown_unit");
  const selected = declared[0]!;
  if (selected.dimension !== authored.dimension)
    throw new CatalogQuantityError("quantity_cross_dimension");
  let unit: CatalogQuantityUnit;
  try { unit = qualifyTypedCatalogUnit(selected); }
  catch (error) {
    if (error instanceof CatalogQuantityError) throw new UnqualifiedQuantityUnit(error.code);
    throw error;
  }
  if (selected.integral && BigInt(authored.unscaled) % (10n ** BigInt(authored.scale)) !== 0n)
    throw new CatalogQuantityError("quantity_fractional_count");
  const canonical = canonicalizeCatalogQuantity(authored, [unit]);
  if (canonical.unscaled.length > 40) throw new CatalogQuantityError("quantity_overflow");
  return canonical;
}

/** The later publication caller supplies the actual current or retained source path. */
export function validateTypedCatalogAmounts(input: { netContent: unknown; grossMass?: unknown }, definition: Definition,
  { path, subject }: QuantitySelection, requireGross: boolean): { netContent: CatalogQuantity; grossMass: CatalogQuantity | null } {
  const issue = (code: "catalog_publication_net_content_invalid" | "catalog_publication_quantity_definition_unqualified"
    | "catalog_publication_gross_mass_required" | "catalog_publication_gross_mass_invalid",
    field: string, quantityCause?: CatalogQuantityCode): never => {
    throw new CatalogPublicationError({ ...publicationIssue(code, code === "catalog_publication_gross_mass_required" ? "activation" : "structural", field, subject),
      ...(quantityCause === undefined ? {} : { quantityCause }) });
  };
  let netContent: CatalogQuantity;
  try {
    netContent = resolveTypedCatalogQuantity(input.netContent, definition);
    if (netContent.dimension === "mass") throw new CatalogQuantityError("quantity_cross_dimension");
  }
  catch (error) {
    if (!(error instanceof CatalogQuantityError)) throw error;
    if (error instanceof UnqualifiedQuantityUnit)
      return issue("catalog_publication_quantity_definition_unqualified", "definition.units", error.code);
    return issue("catalog_publication_net_content_invalid", `${path}/netContent`, error.code);
  }
  const grossPath = `${path}/grossMass`;
  if (input.grossMass == null) {
    if (requireGross) return issue("catalog_publication_gross_mass_required", grossPath);
    return { netContent, grossMass: null };
  }
  try { return { netContent, grossMass: resolveTypedCatalogQuantity(input.grossMass, definition, "grossMass") }; }
  catch (error) {
    if (!(error instanceof CatalogQuantityError)) throw error;
    return issue("catalog_publication_gross_mass_invalid", grossPath, error.code);
  }
}
