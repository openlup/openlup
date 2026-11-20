import type { CatalogPublicationJson } from "../contracts/index.js";
import type { CatalogPublishedSku } from "../publicationContracts.js";

function nested(levels: number, terminal: CatalogPublicationJson): CatalogPublicationJson {
  return Array.from({ length: levels }).reduce<CatalogPublicationJson>(child => [child], terminal);
}

type Vector = {
  name: string;
  apply(sku: CatalogPublishedSku): Record<string, unknown>;
  valid: boolean;
  // JSONB accepts negative zero but normalizes it, so the stored bytes cannot be '-0'.
  sqlNormalizesZero?: boolean;
};
const facts = (value: CatalogPublishedSku["facts"]) => (sku: CatalogPublishedSku) => ({ ...sku, facts: value });

export const publicationWireVectors: readonly Vector[] = [
  { name: "empty array at page depth 48", apply: facts({ limits: nested(43, []) }), valid: true },
  { name: "empty object at page depth 48", apply: facts({ limits: nested(43, {}) }), valid: true },
  { name: "container at page depth 49", apply: facts({ limits: nested(44, []) }), valid: false },
  { name: "UTF-16 key order and ECMAScript number thresholds", apply: facts({
    "\uE000": 1e21, "\u{10000}": 1e20, "10": 1e-7, "2": 1e-6,
  }), valid: true },
  { name: "negative zero", apply: facts({ zero: -0 }), valid: false, sqlNormalizesZero: true },
  { name: "NUL", apply: facts({ value: "\u0000" }), valid: false },
  { name: "unpaired surrogate", apply: facts({ value: "\uD800" }), valid: false },
  { name: "absent field", apply: ({ grossMass: _grossMass, ...sku }) => sku, valid: false },
  { name: "extra field", apply: sku => ({ ...sku, extra: true }), valid: false },
  { name: "nested neutral facts", apply: facts({ values: [{ scalar: "exact" }, [true, null]] }), valid: true },
  { name: "reserved scalar in nested facts", apply: facts({ values: [{ cANonical_TeXt: false }] }), valid: false },
  { name: "reserved attribute", apply: sku => ({ ...sku, attributes: { document_payload: "opaque" } }), valid: false },
  { name: "reserved option", apply: sku => ({ ...sku, options: { document: { kind: "choice", value: "opaque" } } }), valid: false },
];
