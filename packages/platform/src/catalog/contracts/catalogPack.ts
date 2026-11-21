import type { CatalogSubscriptionProfileV1 } from "@openlup/core/catalog";
import type { CatalogDraftPayload } from "./draft.js";
import type { CatalogDraftPayloadV2 } from "./draftV2.js";
import type { CatalogAttributeValueType, CatalogAttributeScalarType } from "./attributes.js";
import type { CatalogProductTypeInput, CatalogOptionValue, CatalogQuantity } from "./productTypes.js";
/** @experimental */
export interface CatalogPackInput {
  id: string; namespace: string; version: number; openlupRange: string;
  capabilities: Readonly<Record<string, boolean>>;
  types: readonly CatalogProductTypeInput[];
  taxClasses: readonly { key: string; labels?: Readonly<Record<string, string>> }[];
  subscriptionProfiles?: readonly { key: string; version: number }[];
  /** Full definitions for profile versions listed in subscriptionProfiles. @experimental */
  subscriptionProfileDefinitions?: readonly CatalogSubscriptionProfileV1[];
}
/** @experimental */
type Profile<P extends CatalogPackInput> = P extends { subscriptionProfiles: readonly (infer R)[] } ? R : never;
/** @experimental */
type ProfileKeys<P extends CatalogPackInput> = Profile<P> extends infer R ? R extends { key: infer K extends string } ? K : never : never;
/** @experimental */
type ProfileVersions<P extends CatalogPackInput> = Profile<P> extends infer R ? R extends { version: infer V extends number } ? V : never : never;
/** Keep authoring inputs closed, including referenced objects and nested union members. */
/** @experimental */
type Exact<Input, Shape> = unknown extends Shape ? Input
  : Input extends (...args: never[]) => unknown ? Input extends Shape ? Input : never
  : Input extends readonly unknown[] ? Shape extends readonly (infer Item)[]
    ? { [I in keyof Input]: Exact<Input[I], Item> } : never
  : Input extends object ? Shape extends unknown ? Input extends Shape
    ? { [K in keyof Input]: K extends keyof Shape ? Exact<Input[K], Shape[K]> : never } : never : never
  : Input extends Shape ? Input : never;
/** @experimental */
type Units<T extends CatalogProductTypeInput> = T["units"][number]["code"];
/** @experimental */
type QuantityIn<T extends CatalogProductTypeInput, Codes extends string> = T["units"][number] extends infer U
  ? U extends { code: Codes; dimension: CatalogQuantity["dimension"] }
    ? CatalogQuantity & { unit: U["code"]; dimension: U["dimension"] } : never : never;
/** @experimental */
type UnitCodesFor<T extends CatalogProductTypeInput, D extends CatalogQuantity["dimension"]> = T["units"][number] extends infer U
  ? U extends { code: string; dimension: D } ? U["code"] : never : never;
/** @experimental */
type AttributeKeys<T extends CatalogProductTypeInput> = T extends { attributes: readonly (infer A)[] }
  ? A extends { key: infer K extends string; scope: "variant" } ? K : never : never;
/** @experimental */
type Dimension<T extends CatalogProductTypeInput> = T["dimensions"][number];
/** @experimental */
type TypedOption<D, T extends CatalogProductTypeInput> = D extends { kind: "choice"; values: readonly string[] }
  ? { kind: "choice"; value: D["values"][number] }
  : D extends { kind: "quantity"; dimension: CatalogQuantity["dimension"]; units: readonly string[] }
    ? { kind: "quantity"; value: CatalogQuantity & { dimension: D["dimension"]; unit: D["units"][number] & Units<T> } }
    : D extends { kind: "boolean" } ? { kind: "boolean"; value: boolean } : CatalogOptionValue;
/** Recursive view of values frozen by defineCatalogPack; callbacks keep their signatures. */
/** @experimental */
type CatalogReadonly<T> = T extends (...args: never[]) => unknown ? T
  : T extends object ? { readonly [K in keyof T]: CatalogReadonly<T[K]> } : T;
/** @experimental */
type SelectedOptions<T extends CatalogProductTypeInput, Selected extends string> = [Extract<Dimension<T>, { key: Selected }>] extends [never]
  ? Readonly<Record<string, never>>
  : { readonly [D in Extract<Dimension<T>, { key: Selected }> as D["key"]]: TypedOption<D, T> };
/** @experimental */
type DraftForType<T extends CatalogProductTypeInput, Selected extends string = Dimension<T>["key"]> = Omit<CatalogReadonly<CatalogDraftPayload>, "product" | "skus"> & {
  product: Omit<CatalogReadonly<CatalogDraftPayload["product"]>, "type" | "dimensions"> & { type: Pick<T, "key" | "version">; dimensions: readonly (Selected & Dimension<T>["key"])[] };
  skus: readonly (Omit<CatalogReadonly<CatalogDraftPayload["skus"][number]>, "options" | "netContent" | "grossMass"> & {
    options: SelectedOptions<T, Selected>;
    netContent?: QuantityIn<T, T["netContentUnits"][number]>;
    grossMass?: QuantityIn<T, UnitCodesFor<T, "mass">>;
  })[];
};
/** Explicit annotations supply the product's selected dimension keys as Selected.
 * Omitted Selected covers all installed dimensions; draftsFor infers the selection.
 * @experimental
 */
export type CatalogPackDraft<P extends CatalogPackInput, Selected extends string = P["types"][number]["dimensions"][number]["key"]> = P["types"][number] extends infer T
  ? T extends CatalogProductTypeInput ? DraftForType<T, Selected> : never : never;
/** @experimental */
type DraftInput = CatalogReadonly<CatalogDraftPayload>;
/** @experimental */
type Attribute<T extends CatalogProductTypeInput, Scope extends "product" | "variant"> = T extends { attributes: readonly (infer A)[] }
  ? Extract<A, { scope: Scope }> : never;
/** @experimental */
type AttributeValue<V, T extends CatalogProductTypeInput> = V extends { kind: "list"; item: infer I }
  ? readonly AttributeValue<I, T>[]
  : V extends { kind: "boolean" } ? boolean
  : V extends { kind: "quantity"; units: readonly string[] } ? QuantityIn<T, V["units"][number]>
  : V extends { kind: "enum"; values: readonly { id: string }[] } ? V["values"][number]["id"]
  : V extends { kind: "reference"; allowlist: readonly string[] } ? { readonly namespace: V["allowlist"][number]; readonly id: string }
  : V extends { kind: "localized_text"; locales: readonly string[] }
    ? { readonly [K in V["locales"][number]]?: string } & (V extends { requiredLocales: readonly string[] } ? { readonly [K in V["requiredLocales"][number]]: string } : unknown)
  : V extends CatalogAttributeValueType | CatalogAttributeScalarType ? string : never;
/** @experimental */
type RequiredAttribute<A> = A extends { required: true } ? A : A extends { cardinality: { min: infer N extends number } }
  ? number extends N ? never : N extends 0 ? never : A : never;
/** @experimental */
type TypedAttributes<T extends CatalogProductTypeInput, Scope extends "product" | "variant"> = {
  readonly [A in Attribute<T, Scope> as A extends { key: infer K extends string } ? K : never]?: A extends { valueType: infer V } ? AttributeValue<V, T> : never;
} & {
  readonly [A in RequiredAttribute<Attribute<T, Scope>> as A extends { key: infer K extends string } ? K : never]: A extends { valueType: infer V } ? AttributeValue<V, T> : never;
};
/** @experimental */
type AttributeField<T extends CatalogProductTypeInput, Scope extends "product" | "variant"> = [RequiredAttribute<Attribute<T, Scope>>] extends [never]
  ? { attributes?: TypedAttributes<T, Scope> } : { attributes: TypedAttributes<T, Scope> };
/** @experimental */
type DraftV2ForType<T extends CatalogProductTypeInput, Selected extends string> = {
  schemaVersion: 2;
  product: Omit<DraftForType<T, Selected>["product"], "attributes"> & AttributeField<T, "product">;
  skus: readonly (Omit<DraftForType<T, Selected>["skus"][number], "priceRef" | "attributes">
    & AttributeField<T, "variant"> & Pick<CatalogReadonly<CatalogDraftPayloadV2["skus"][number]>, "priceOperations">)[];
};
/** @experimental */
type AnyDraftInput = DraftInput | CatalogReadonly<CatalogDraftPayloadV2>;
/** @experimental */
type SelectedDraft<P extends CatalogPackInput, D extends AnyDraftInput> = P["types"][number] extends infer T
  ? T extends CatalogProductTypeInput
    ? D["product"]["type"] extends Pick<T, "key" | "version">
      ? (D extends { schemaVersion: 2 } ? DraftV2ForType<T, D["product"]["dimensions"][number]> : DraftForType<T, D["product"]["dimensions"][number]>) & {
        product: D["product"] & (D extends { schemaVersion: 2 } ? D["product"] extends { attributes: infer A } ? { attributes: Exact<A, TypedAttributes<T, "product">> } : unknown : unknown);
        skus: { readonly [I in keyof D["skus"]]: (D["skus"][I] extends { options: infer O }
          ? Omit<D["skus"][I], "options"> & { options: { readonly [K in Exclude<keyof O, D["product"]["dimensions"][number]>]: never } } : D["skus"][I])
          & (D extends { schemaVersion: 2 } ? D["skus"][I] extends { attributes: infer A } ? { attributes: Exact<A, TypedAttributes<T, "variant">> } : unknown : unknown) };
      } : never
    : never : never;
/** @experimental */
type AttributeReferences<V, T extends CatalogProductTypeInput> = V extends { kind: "quantity" }
  ? V & { units: readonly UnitCodesFor<T, V extends { dimension: infer D extends CatalogQuantity["dimension"] } ? D : never>[] }
  : V extends { kind: "list"; item: infer Item } ? V & { item: AttributeReferences<Item, T> } : V;
/** @experimental */
type AttributeInput<A, T extends CatalogProductTypeInput> = A extends { key: string; valueType: unknown }
  ? string extends A["key"] ? never : A & { valueType: AttributeReferences<A["valueType"], T> } : never;
/** @experimental */
type DimensionInput<D, T extends CatalogProductTypeInput> = D extends { kind: "quantity"; dimension: infer K extends CatalogQuantity["dimension"] }
  ? D & { units: readonly UnitCodesFor<T, K>[] } : D;
/** @experimental */
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
/** @experimental */
type PackReferences<P extends CatalogPackInput> = string extends P["namespace"] | P["taxClasses"][number]["key"] | ProfileKeys<P> ? never
  : number extends ProfileVersions<P> ? never : {
  types: { readonly [I in keyof P["types"]]: P["types"][I] extends CatalogProductTypeInput ? TypeReferences<P, P["types"][I]> : P["types"][I] };
};
/** Authoring preserves literals; it does not validate or execute pack callbacks.
 * @experimental
 */
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
/** v1 stays unchanged; v2 authoring adds definition-typed attributes and complete price commands.
 * @experimental
 */
export function draftsFor<const P extends CatalogPackInput>(pack: P & (string extends P["types"][number]["key"] ? never : unknown)):
  <const D extends readonly AnyDraftInput[]>(drafts: D & Exact<D, AnyDraftInput[]> & { readonly [I in keyof D]: SelectedDraft<P, D[I]> }) => D {
  return (drafts) => drafts;
}
