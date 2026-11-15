import { expect, it } from "vitest";
import { defineCatalogPack, draftsFor, type CatalogPackInput, type CatalogTypeDefinitionV2, type CatalogQuantity as PlatformQuantity } from "../../src/catalog/contracts/index.js";
import type { CatalogQuantity } from "@openlup/core/catalog";
const pack = defineCatalogPack({
  id: "example:pack", namespace: "example", version: 1, openlupRange: "0.44.x", capabilities: { publish: false },
  taxClasses: [{ key: "example:standard" }], subscriptionProfiles: [{ key: "example:regular", version: 1 }],
  types: [{
    key: "example:item", version: 1, units: [{ code: "openlup:piece", dimension: "count", integral: true }],
    netContentUnits: ["openlup:piece"], dimensions: [{ key: "finish", kind: "choice", values: ["matte", "gloss"] }],
    validateContent: (_content: unknown) => [], taxClass: "example:standard", subscriptionProfileRef: { key: "example:regular", version: 1 },
  }, {
    key: "example:other", version: 1, units: [{ code: "openlup:g", dimension: "mass", integral: false }],
    netContentUnits: ["openlup:g"], dimensions: [{ key: "size", kind: "choice", values: ["small"] }], validateContent: (_content: unknown) => [],
  }],
});
const product = { id: "product", type: { key: "example:item", version: 1 }, dimensions: ["finish"] } as const;
const sku = { id: "sku", productId: "product", options: { finish: { kind: "choice", value: "matte" } } } as const;
it("define_catalog_pack_types_reject_undeclared_keys", () => {
  expect(draftsFor(pack)([{ schemaVersion: 1, product, skus: [sku] }])).toHaveLength(1);
  const compileOnly = (): void => {
    // @ts-expect-error Unknown type key.
    draftsFor(pack)([{ schemaVersion: 1, product: { ...product, type: { key: "example:missing", version: 1 } }, skus: [] }]);
    // @ts-expect-error The other type's axis is not an item axis.
    draftsFor(pack)([{ schemaVersion: 1, product, skus: [{ ...sku, options: { size: { kind: "choice", value: "small" } } }] }]);
    // @ts-expect-error Choice values are inferred literals.
    draftsFor(pack)([{ schemaVersion: 1, product, skus: [{ ...sku, options: { finish: { kind: "choice", value: "missing" } } }] }]);
    // @ts-expect-error Unit belongs to another type.
    draftsFor(pack)([{ schemaVersion: 1, product, skus: [{ ...sku, netContent: { dimension: "mass", unscaled: "1", scale: 0, unit: "openlup:g" } }] }]);
    // @ts-expect-error Unknown product dimension.
    draftsFor(pack)([{ schemaVersion: 1, product: { ...product, dimensions: ["missing"] }, skus: [] }]);
    const widened: CatalogPackInput = pack;
    // @ts-expect-error Literal inference cannot be recovered from widened descriptors.
    draftsFor(widened);
    // @ts-expect-error The definition's unit reference crosses type boundaries.
    defineCatalogPack({ ...pack, types: [{ ...pack.types[0], netContentUnits: ["openlup:g"] }] });
    // @ts-expect-error Undeclared tax class.
    defineCatalogPack({ ...pack, types: [{ ...pack.types[0], taxClass: "example:missing" }] });
    // @ts-expect-error Profile versions are inferred too.
    defineCatalogPack({ ...pack, types: [{ ...pack.types[0], subscriptionProfileRef: { key: "example:regular", version: 2 } }] });
    // @ts-expect-error Type keys use the declared namespace.
    defineCatalogPack({ ...pack, types: [{ ...pack.types[0], key: "other:item" }] });
  };
  expect(compileOnly).toBeTypeOf("function");
});
// Both public imports name the same Core shape, in both assignment directions.
const coreQuantity: CatalogQuantity = { dimension: "mass", unscaled: "1", scale: 0, unit: "openlup:g" };
const platformQuantity: PlatformQuantity = coreQuantity;
const back: CatalogQuantity = platformQuantity;
it("keeps quantity re-exports identical and metadata free of callbacks", () => {
  const callbackInMetadata: "validateContent" extends keyof CatalogTypeDefinitionV2 ? true : false = false;
  expect(callbackInMetadata).toBe(false);
  expect(back).toBe(coreQuantity);
});
