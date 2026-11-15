import type { CatalogDraftPayload } from "./draft.js";
import type { CatalogProductTypeInput, CatalogOptionValue, CatalogQuantity } from "./productTypes.js";
export interface CatalogPackInput {
  id: string; namespace: string; version: number; openlupRange: string;
  capabilities: Readonly<Record<string, boolean>>;
  types: readonly CatalogProductTypeInput[];
  taxClasses: readonly { key: string; labels?: Readonly<Record<string, string>> }[];
  subscriptionProfiles?: readonly { key: string; version: number }[];
}
type Member<T> = T extends readonly (infer E)[] ? E : never;
type Units<T extends CatalogProductTypeInput> = T["units"][number]["code"];
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
type DraftForType<T extends CatalogProductTypeInput, Selected extends string = Dimension<T>["key"]> = Omit<CatalogDraftPayload, "product" | "skus"> & {
  product: Omit<CatalogDraftPayload["product"], "type" | "dimensions"> & { type: Pick<T, "key" | "version">; dimensions: readonly (Selected & Dimension<T>["key"])[] };
  skus: readonly (Omit<CatalogDraftPayload["skus"][number], "options" | "netContent" | "grossMass"> & {
    options: SelectedOptions<T, Selected>;
    netContent?: CatalogQuantity & { unit: T["netContentUnits"][number] & Units<T> };
    grossMass?: CatalogQuantity & { dimension: "mass"; unit: Extract<T["units"][number], { dimension: "mass" }>["code"] };
  })[];
};
export type CatalogPackDraft<P extends CatalogPackInput, Selected extends string = P["types"][number]["dimensions"][number]["key"]> = P["types"][number] extends infer T
  ? T extends CatalogProductTypeInput ? DraftForType<T, Selected> : never : never;
type DraftInput = CatalogReadonly<CatalogDraftPayload>;
type SelectedDraft<P extends CatalogPackInput, D extends DraftInput> = P["types"][number] extends infer T
  ? T extends CatalogProductTypeInput
    ? D["product"]["type"] extends Pick<T, "key" | "version">
      ? DraftForType<T, D["product"]["dimensions"][number]> & {
        skus: { readonly [I in keyof D["skus"]]: D["skus"][I] extends { options: infer O }
          ? { options: { readonly [K in Exclude<keyof O, D["product"]["dimensions"][number]>]: never } } : D["skus"][I] };
      } : never
    : never : never;
type AttributeReferences<V, T extends CatalogProductTypeInput> = V extends { kind: "quantity" }
  ? V & { units: readonly Units<T>[] }
  : V extends { kind: "list"; item: infer Item } ? V & { item: AttributeReferences<Item, T> } : V;
type TypeReferences<P extends CatalogPackInput, T extends CatalogProductTypeInput> = T & {
  key: `${P["namespace"]}:${string}`;
  netContentUnits: readonly Units<T>[];
  dimensions: readonly (Dimension<T> & { units?: readonly Units<T>[] })[];
  taxClass?: P["taxClasses"][number]["key"];
  subscriptionProfileRef?: Member<P["subscriptionProfiles"]>;
  attributes?: readonly (NonNullable<T["attributes"]>[number] & {
    valueType: AttributeReferences<NonNullable<T["attributes"]>[number]["valueType"], T>;
  })[];
  axes?: readonly { key: Dimension<T>["key"]; attributeKey: NonNullable<T["attributes"]>[number]["key"] }[];
};
type PackReferences<P extends CatalogPackInput> = {
  types: { readonly [I in keyof P["types"]]: P["types"][I] extends CatalogProductTypeInput ? TypeReferences<P, P["types"][I]> : P["types"][I] };
};
/** Authoring preserves literals; it does not validate or execute pack callbacks. */
export function defineCatalogPack<const P extends CatalogPackInput>(pack: P & PackReferences<P>): CatalogReadonly<P> {
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
  <const D extends readonly DraftInput[]>(drafts: D & { readonly [I in keyof D]: SelectedDraft<P, D[I]> }) => D {
  return (drafts) => drafts;
}
