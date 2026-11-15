/** A physical quantity uses positive decimal strings; its dimension never changes. */
export type CatalogQuantityDimension = "mass" | "volume" | "count";
export interface CatalogQuantity { dimension: CatalogQuantityDimension; unscaled: string; scale: number; unit: string }
export type CatalogCanonicalUnit = "openlup:g" | "openlup:ml" | "openlup:piece";
/** Exact decimal multiplier to the dimension's canonical unit. */
export interface CatalogUnitFactor { canonicalUnit: CatalogCanonicalUnit; unscaled: string; scale: number }
export interface CatalogQuantityUnit {
  code: string; dimension: CatalogQuantityDimension; integral: boolean; factor: CatalogUnitFactor;
}
export type CatalogQuantityCode = "quantity_invalid" | "quantity_cross_dimension" | "quantity_fractional_count"
  | "quantity_unknown_unit" | "quantity_overflow" | "quantity_not_exactly_representable";
export class CatalogQuantityError extends Error {
  constructor(readonly code: CatalogQuantityCode) { super(code); this.name = "CatalogQuantityError"; }
}
function fail(code: CatalogQuantityCode): never { throw new CatalogQuantityError(code); }
export const CATALOG_CANONICAL_UNITS: Readonly<Record<CatalogQuantityDimension, CatalogCanonicalUnit>> = Object.freeze({
  mass: "openlup:g", volume: "openlup:ml", count: "openlup:piece",
});
export const CATALOG_QUANTITY_UNITS: readonly CatalogQuantityUnit[] = Object.freeze(([
  ["openlup:g", "mass", false, "1"], ["openlup:kg", "mass", false, "1000"],
  ["openlup:ml", "volume", false, "1"], ["openlup:l", "volume", false, "1000"],
  ["openlup:piece", "count", true, "1"],
] as const).map(([code, dimension, integral, unscaled]) => Object.freeze({
  code, dimension, integral,
  factor: Object.freeze({ canonicalUnit: CATALOG_CANONICAL_UNITS[dimension], unscaled, scale: 0 }),
} satisfies CatalogQuantityUnit)));
const power = (scale: number): bigint => 10n ** BigInt(scale);
function decimal(unscaled: unknown, scale: unknown): asserts unscaled is string {
  if (typeof unscaled !== "string" || !/^[1-9][0-9]*$/u.test(unscaled)
    || typeof scale !== "number" || !Number.isInteger(scale) || scale < 0 || scale > 12) fail("quantity_invalid");
  if (unscaled.length > 52) fail("quantity_overflow");
}
/** Validates a declared conversion, without inferring density or item mass. */
export function validateCatalogUnitFactor(unit: CatalogQuantityUnit): void {
  decimal(unit.factor.unscaled, unit.factor.scale);
  if (unit.factor.canonicalUnit !== CATALOG_CANONICAL_UNITS[unit.dimension]
    || typeof unit.integral !== "boolean") fail("quantity_cross_dimension");
  if (unit.dimension === "count" && BigInt(unit.factor.unscaled) % power(unit.factor.scale) !== 0n) fail("quantity_fractional_count");
  const builtIn = CATALOG_QUANTITY_UNITS.find(({ code }) => code === unit.code);
  if (builtIn && (unit.dimension !== builtIn.dimension || unit.integral !== builtIn.integral
    || BigInt(unit.factor.unscaled) !== BigInt(builtIn.factor.unscaled) * power(unit.factor.scale))) fail("quantity_invalid");
}
function resolve(code: string, units: readonly CatalogQuantityUnit[]): CatalogQuantityUnit {
  const found = units.filter((unit) => unit.code === code);
  if (found.length !== 1) return fail("quantity_unknown_unit");
  validateCatalogUnitFactor(found[0]);
  return found[0];
}
export function parseCatalogQuantity(input: unknown, units: readonly CatalogQuantityUnit[] = CATALOG_QUANTITY_UNITS): CatalogQuantity {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("quantity_invalid");
  const value = input as CatalogQuantity;
  if (!Object.hasOwn(CATALOG_CANONICAL_UNITS, value.dimension)) return fail("quantity_invalid");
  decimal(value.unscaled, value.scale);
  const unit = resolve(value.unit, units);
  if (unit.dimension !== value.dimension) return fail("quantity_cross_dimension");
  if ((value.dimension === "count" || unit.integral) && BigInt(value.unscaled) % power(value.scale) !== 0n) return fail("quantity_fractional_count");
  return { dimension: value.dimension, unscaled: value.unscaled, scale: value.scale, unit: value.unit };
}
function normalise(coefficient: bigint, scale: number): { unscaled: string; scale: number } {
  while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale -= 1; }
  if (scale > 12) return fail("quantity_not_exactly_representable");
  const unscaled = coefficient.toString();
  if (unscaled.length - scale > 40) return fail("quantity_overflow");
  return { unscaled, scale };
}
/** Canonical numeric(52,12) evidence, with minimal scale and no rounding. */
export function canonicalizeCatalogQuantity(input: CatalogQuantity, units: readonly CatalogQuantityUnit[] = CATALOG_QUANTITY_UNITS): CatalogQuantity {
  const value = parseCatalogQuantity(input, units);
  const unit = resolve(value.unit, units);
  return { dimension: value.dimension, ...normalise(BigInt(value.unscaled) * BigInt(unit.factor.unscaled), value.scale + unit.factor.scale),
    unit: CATALOG_CANONICAL_UNITS[value.dimension] };
}
export function compareCatalogQuantities(left: CatalogQuantity, right: CatalogQuantity, units: readonly CatalogQuantityUnit[] = CATALOG_QUANTITY_UNITS): -1 | 0 | 1 {
  if (left.dimension !== right.dimension) return fail("quantity_cross_dimension");
  const a = canonicalizeCatalogQuantity(left, units), b = canonicalizeCatalogQuantity(right, units);
  const difference = BigInt(a.unscaled) * power(b.scale) - BigInt(b.unscaled) * power(a.scale);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
export function convertCatalogQuantity(input: CatalogQuantity, target: string, units: readonly CatalogQuantityUnit[] = CATALOG_QUANTITY_UNITS): CatalogQuantity {
  const value = canonicalizeCatalogQuantity(input, units), unit = resolve(target, units);
  if (unit.dimension !== value.dimension) return fail("quantity_cross_dimension");
  let numerator = BigInt(value.unscaled) * power(unit.factor.scale);
  const denominator = BigInt(unit.factor.unscaled) * power(value.scale);
  let scale = 0;
  while (numerator % denominator !== 0n && scale < 12) { numerator *= 10n; scale += 1; }
  if (numerator % denominator !== 0n) return fail("quantity_not_exactly_representable");
  const result = { dimension: value.dimension, ...normalise(numerator / denominator, scale), unit: target };
  // Preserve exact canonical decimal strings at the Core boundary.
  return parseCatalogQuantity(result, units);
}
