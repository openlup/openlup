import type { CatalogDraftPayload } from "./draft.js";
import type { CatalogProductTypeInput, CatalogOptionValue, CatalogQuantity } from "./productTypes.js";
export interface CatalogPackInput {
  id: string; namespace: string; version: number; openlupRange: string;
  capabilities: Readonly<Record<string, boolean>>;
  types: readonly CatalogProductTypeInput[];
  taxClasses: readonly { key: string; labels?: Readonly<Record<string, string>> }[];
  subscriptionProfiles?: readonly { key: string; version: number }[];
}
type Profile<P extends CatalogPackInput> = P extends { subscriptionProfiles: readonly (infer R)[] } ? R : never;
type ProfileKeys<P extends CatalogPackInput> = Profile<P> extends infer R ? R extends { key: infer K extends string } ? K : never : never;
type ProfileVersions<P extends CatalogPackInput> = Profile<P> extends infer R ? R extends { version: infer V extends number } ? V : never : never;
/** Keep authoring inputs closed, including referenced objects and nested union members. */
type Exact<Input, Shape> = unknown extends Shape ? Input
  : Input extends (...args: never[]) => unknown ? Input extends Shape ? Input : never
  : Input extends readonly unknown[] ? Shape extends readonly (infer Item)[]
    ? { [I in keyof Input]: Exact<Input[I], Item> } : never
  : Input extends object ? Shape extends unknown ? Input extends Shape
    ? { [K in keyof Input]: K extends keyof Shape ? Exact<Input[K], Shape[K]> : never } : never : never
  : Input extends Shape ? Input : never;
type Units<T extends CatalogProductTypeInput> = T["units"][number]["code"];
type QuantityIn<T extends CatalogProductTypeInput, Codes extends string> = T["units"][number] extends infer U
  ? U extends { code: Codes; dimension: CatalogQuantity["dimension"] }
    ? CatalogQuantity & { unit: U["code"]; dimension: U["dimension"] } : never : never;
type UnitCodesFor<T extends CatalogProductTypeInput, D extends CatalogQuantity["dimension"]> = T["units"][number] extends infer U
  ? U extends { code: string; dimension: D } ? U["code"] : never : never;
type AttributeKeys<T extends CatalogProductTypeInput> = T extends { attributes: readonly (infer A)[] }
  ? A extends { key: infer K extends string; scope: "variant" } ? K : never : never;
type Dimension<T extends CatalogProductTypeInput> = T["dimensions"][number];
type TypedOption<D, T extends CatalogProductTypeInput> = D extends { kind: "choice"; values: readonly string[] }
  ? { kind: "choice"; value: D["values"][number] }
  : D extends { kind: "quantity"; dimension: CatalogQuantity["dimension"]; units: readonly string[] }
    ? { kind: "quantity"; value: CatalogQuantity & { dimension: D["dimension"]; unit: D["units"][number] & Units<T> } }
    : D extends { kind: "boolean" } ? { kind: "boolean"; value: boolean } : CatalogOptionValue;
/** Recursive view of values frozen by defineCatalogPack; callbacks keep their signatures. */
type CatalogReadonly<T> = T extends (...args: never[]) => unknown ? T
  : T extends object ? { readonly [K in keyof T]: CatalogReadonly<T[K]> } : T;
type SelectedOptions<T extends CatalogProductTypeInput, Selected extends string> = [Extract<Dimension<T>, { key: Selected }>] extends [never]
  ? Readonly<Record<string, never>>
  : { readonly [D in Extract<Dimension<T>, { key: Selected }> as D["key"]]: TypedOption<D, T> };
type DraftForType<T extends CatalogProductTypeInput, Selected extends string = Dimension<T>["key"]> = Omit<CatalogReadonly<CatalogDraftPayload>, "product" | "skus"> & {
  product: Omit<CatalogReadonly<CatalogDraftPayload["product"]>, "type" | "dimensions"> & { type: Pick<T, "key" | "version">; dimensions: readonly (Selected & Dimension<T>["key"])[] };
  skus: readonly (Omit<CatalogReadonly<CatalogDraftPayload["skus"][number]>, "options" | "netContent" | "grossMass"> & {
    options: SelectedOptions<T, Selected>;
    netContent?: QuantityIn<T, T["netContentUnits"][number]>;
    grossMass?: QuantityIn<T, UnitCodesFor<T, "mass">>;
  })[];
};
/** Explicit annotations supply the product's selected dimension keys as Selected.
 * Omitted Selected covers all installed dimensions; draftsFor infers the selection. */
export type CatalogPackDraft<P extends CatalogPackInput, Selected extends string = P["types"][number]["dimensions"][number]["key"]> = P["types"][number] extends infer T
  ? T extends CatalogProductTypeInput ? DraftForType<T, Selected> : never : never;
type DraftInput = CatalogReadonly<CatalogDraftPayload>;
type SelectedDraft<P extends CatalogPackInput, D extends DraftInput> = P["types"][number] extends infer T
  ? T extends CatalogProductTypeInput
    ? D["product"]["type"] extends Pick<T, "key" | "version">
      ? DraftForType<T, D["product"]["dimensions"][number]> & {
        skus: { readonly [I in keyof D["skus"]]: D["skus"][I] extends { options: infer O }
          ? Omit<D["skus"][I], "options"> & { options: { readonly [K in Exclude<keyof O, D["product"]["dimensions"][number]>]: never } } : D["skus"][I] };
      } : never
    : never : never;
type AttributeReferences<V, T extends CatalogProductTypeInput> = V extends { kind: "quantity" }
  ? V & { units: readonly UnitCodesFor<T, V extends { dimension: infer D extends CatalogQuantity["dimension"] } ? D : never>[] }
  : V extends { kind: "list"; item: infer Item } ? V & { item: AttributeReferences<Item, T> } : V;
type AttributeInput<A, T extends CatalogProductTypeInput> = A extends { key: string; valueType: unknown }
  ? string extends A["key"] ? never : A & { valueType: AttributeReferences<A["valueType"], T> } : never;
type DimensionInput<D, T extends CatalogProductTypeInput> = D extends { kind: "quantity"; dimension: infer K extends CatalogQuantity["dimension"] }
  ? D & { units: readonly UnitCodesFor<T, K>[] } : D;
type TypeReferences<P extends CatalogPackInput, T extends CatalogProductTypeInput> = T extends unknown ? string extends T["key"] | Units<T> ? never : number extends T["version"] ? never : T & {
  key: `${P["namespace"]}:${string}`;
  netContentUnits: readonly Units<T>[];
  dimensions: readonly DimensionInput<Dimension<T>, T>[];
  taxClass?: P["taxClasses"][number]["key"];
  validatorRef?: `sha256:${string}`;
  subscriptionProfileRef?: Profile<P>;
  attributes?: readonly AttributeInput<NonNullable<T["attributes"]>[number], T>[];
  axes?: readonly { key: Dimension<T>["key"]; attributeKey: AttributeKeys<T> }[];
} : never;
type PackReferences<P extends CatalogPackInput> = string extends P["namespace"] | P["taxClasses"][number]["key"] | ProfileKeys<P> ? never
  : number extends ProfileVersions<P> ? never : {
  types: { readonly [I in keyof P["types"]]: P["types"][I] extends CatalogProductTypeInput ? TypeReferences<P, P["types"][I]> : P["types"][I] };
};
/** Authoring preserves literals; it does not validate or execute pack callbacks. */
export function defineCatalogPack<const P extends CatalogPackInput>(pack: P & Exact<P, CatalogPackInput> & PackReferences<P>): CatalogReadonly<P> {
  const seen = new WeakSet<object>();
  function freeze(value: object): void {
    if (seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
    Object.freeze(value);
  }
  freeze(pack);
  return pack as CatalogReadonly<P>;
}
/** v1 authoring only; attributes and prices join the versioned draft payload separately. */
export function draftsFor<const P extends CatalogPackInput>(pack: P & (string extends P["types"][number]["key"] ? never : unknown)):
  <const D extends readonly DraftInput[]>(drafts: D & Exact<D, DraftInput[]> & { readonly [I in keyof D]: SelectedDraft<P, D[I]> }) => D {
  return (drafts) => drafts;
}
