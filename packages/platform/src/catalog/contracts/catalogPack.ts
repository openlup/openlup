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
type DraftForType<T extends CatalogProductTypeInput> = Omit<CatalogDraftPayload, "product" | "skus"> & {
  product: Omit<CatalogDraftPayload["product"], "type" | "dimensions"> & { type: Pick<T, "key" | "version">; dimensions: readonly Dimension<T>["key"][] };
  skus: readonly (Omit<CatalogDraftPayload["skus"][number], "options" | "netContent" | "grossMass"> & {
    options: { readonly [D in Dimension<T> as D["key"]]: TypedOption<D, T> };
    netContent?: CatalogQuantity & { unit: T["netContentUnits"][number] & Units<T> };
    grossMass?: CatalogQuantity & { dimension: "mass"; unit: Extract<T["units"][number], { dimension: "mass" }>["code"] };
  })[];
};
export type CatalogPackDraft<P extends CatalogPackInput> = P["types"][number] extends infer T
  ? T extends CatalogProductTypeInput ? DraftForType<T> : never : never;
type TypeReferences<P extends CatalogPackInput, T extends CatalogProductTypeInput> = T & {
  key: `${P["namespace"]}:${string}`;
  netContentUnits: readonly Units<T>[];
  dimensions: readonly (Dimension<T> & { units?: readonly Units<T>[] })[];
  taxClass?: P["taxClasses"][number]["key"];
  subscriptionProfileRef?: Member<P["subscriptionProfiles"]>;
  attributes?: readonly (NonNullable<T["attributes"]>[number] & {
    valueType: NonNullable<T["attributes"]>[number]["valueType"] & { units?: readonly Units<T>[] };
  })[];
  axes?: readonly { key: Dimension<T>["key"]; attributeKey: NonNullable<T["attributes"]>[number]["key"] }[];
};
type PackReferences<P extends CatalogPackInput> = {
  types: { readonly [I in keyof P["types"]]: P["types"][I] extends CatalogProductTypeInput ? TypeReferences<P, P["types"][I]> : P["types"][I] };
};
/** Authoring preserves literals; it does not validate or execute pack callbacks. */
export function defineCatalogPack<const P extends CatalogPackInput>(pack: P & PackReferences<P>): P {
  const seen = new WeakSet<object>();
  function freeze(value: object): void {
    if (seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
    Object.freeze(value);
  }
  freeze(pack);
  return pack;
}
/** v1 authoring only; attributes and prices join the versioned draft payload separately. */
export function draftsFor<const P extends CatalogPackInput>(pack: P & (string extends P["types"][number]["key"] ? never : unknown)):
  (drafts: readonly CatalogPackDraft<P>[]) => readonly CatalogPackDraft<P>[] {
  return (drafts) => drafts;
}
