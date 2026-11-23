import type { AttributeDefinition, CatalogAttributeScalarType, CatalogAxisDefinition } from "./contracts/attributes.js";
import type { CatalogProductTypeInput, CatalogQuantityDimension } from "./contracts/productTypes.js";

type OptionDisplay = Pick<AttributeDefinition, "key" | "labels">
  & Partial<Pick<AttributeDefinition, "filterable" | "facetable" | "public" | "displayOrder">>;
type ChoiceValueType = Extract<CatalogAttributeScalarType, { kind: "enum" }>;
type QuantityOptionInput = { kind: "quantity"; dimension: CatalogQuantityDimension; units: readonly string[]; role?: "net_content" };

/** One variant option in the catalogue definition.
 * @experimental
 */
export type CatalogVariantOptionInput = OptionDisplay & (
  | { kind: "choice"; values: ChoiceValueType["values"] }
  | { kind: "boolean" }
  | QuantityOptionInput
);

type OptionQuantity<O extends QuantityOptionInput> = {
  kind: "quantity"; dimension: O["dimension"]; units: readonly O["units"][number][];
};
type OptionValueType<O extends CatalogVariantOptionInput> = O extends { kind: "choice" } ? ChoiceValueType
  : O extends QuantityOptionInput ? OptionQuantity<O> : { kind: "boolean" };
type OptionDimension<O extends CatalogVariantOptionInput> = { key: O["key"] } & (
  O extends { kind: "choice" } ? { kind: "choice"; values: readonly string[] }
    : O extends QuantityOptionInput ? OptionQuantity<O> & { role?: "net_content" } : { kind: "boolean" }
);

type VariantOptions<O extends readonly CatalogVariantOptionInput[]> = {
  attributes: { [I in keyof O]: Omit<AttributeDefinition, "key" | "scope" | "valueType"> & {
    key: O[I]["key"]; scope: "variant"; valueType: OptionValueType<O[I]>;
  } };
  dimensions: { [I in keyof O]: OptionDimension<O[I]> };
  axes: { [I in keyof O]: CatalogAxisDefinition & { key: O[I]["key"]; attributeKey: O[I]["key"] } };
};

/** Build one attribute, dimension and axis per option, in input order.
 * @experimental
 */
export function catalogVariantOptions<const O extends readonly CatalogVariantOptionInput[]>(options: O): VariantOptions<O> {
  const attributes: (AttributeDefinition & { scope: "variant" })[] = [];
  const dimensions: CatalogProductTypeInput["dimensions"][number][] = [];
  const axes: CatalogAxisDefinition[] = [];
  options.forEach((option, index) => {
    const { key } = option;
    let valueType: CatalogAttributeScalarType;
    switch (option.kind) {
      case "choice":
        valueType = { kind: "enum", values: option.values.map(({ id, labels }) =>
          labels === undefined ? { id } : { id, labels: { ...labels } }) };
        dimensions.push({ key, kind: "choice", values: option.values.map(({ id }) => id) });
        break;
      case "boolean":
        valueType = { kind: "boolean" };
        dimensions.push({ key, kind: "boolean" });
        break;
      case "quantity":
        valueType = { kind: "quantity", dimension: option.dimension, units: [...option.units] };
        dimensions.push({ key, kind: "quantity", dimension: option.dimension, units: [...option.units],
          ...(option.role === undefined ? {} : { role: option.role }) });
        break;
    }
    attributes.push({ key, scope: "variant", valueType, required: true, cardinality: { min: 1, max: 1 },
      filterable: option.filterable ?? false, facetable: option.facetable ?? false, public: option.public ?? true,
      displayOrder: option.displayOrder ?? index, labels: { ...option.labels } });
    axes.push({ key, attributeKey: key });
  });
  // The same iteration constructs every entry at the same position as its input key.
  return { attributes, dimensions, axes } as VariantOptions<O>;
}
