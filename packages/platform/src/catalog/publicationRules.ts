import { createHash } from "node:crypto";
import { Script } from "node:vm";
import type { CatalogPublishedProduct, CatalogPublishedSku } from "./contracts/publication.js";
import type { CatalogPublicationFacts } from "./contracts/draftV3.js";
import type { CatalogDraftIssue } from "./contracts/productTypes.js";
import type { CatalogPublicationDocument } from "./publicationEvidence.js";
import { publicationRefuse } from "./publicationError.js";

declare const handleBrand: unique symbol;

/** An in-process capability for the executable pinned by an installed definition.
 * @experimental
 */
export interface CatalogPublicationRulesHandle { readonly [handleBrand]: true }

/** Export this interface as module.exports in a self-contained publication rules bundle.
 * @experimental
 */
export interface CatalogPublicationRulesModule {
  validateContent(content: unknown): readonly CatalogDraftIssue[];
  validateProduct(product: CatalogPublishedProduct, skus: readonly CatalogPublishedSku[], documents: readonly CatalogPublicationDocument[]): readonly string[];
  validateMembershipChange?(sku: Readonly<CatalogPublishedSku>, change: { offerVersion: string; admitted: boolean }): boolean;
  inspectDocument(canonicalText: string): { schemaId: string; documentRef: string; productSlug: string; revisionNo: number;
    name?: string; canonicallyEncoded: boolean };
  matchesDocument(document: unknown, canonicalText: string): boolean;
  identifyDocument(document: unknown): { schemaId: string; documentRef: string; productSlug: string; revisionNo: number; name?: string };
  validateSkuAmounts?(sku: { code: string; netGrams: string }): boolean;
  deriveSkuFacts(canonicalText: string, sku: CatalogPublishedSku): CatalogPublicationFacts;
  classifySkuChange(before: CatalogPublishedSku, after: CatalogPublishedSku, context: {
    beforeProduct: CatalogPublishedProduct; afterProduct: CatalogPublishedProduct;
    beforeDocument: CatalogPublicationDocument | null; afterDocument: CatalogPublicationDocument;
  }): "compatible" | "material" | "inconclusive";
}
const requiredHooks = ["validateContent", "validateProduct", "inspectDocument", "matchesDocument", "identifyDocument",
  "deriveSkuFacts", "classifySkuChange"] as const satisfies readonly (keyof CatalogPublicationRulesModule)[];
const optionalHooks = ["validateMembershipChange", "validateSkuAmounts"] as const satisfies readonly (keyof CatalogPublicationRulesModule)[];
const handles = new WeakMap<CatalogPublicationRulesHandle, { validatorRef: string; rules: CatalogPublicationRulesModule }>();

/** Load trusted, deterministic JavaScript rules from the verified byte snapshot.
 * @experimental
 */
export function loadCatalogPublicationRules(validatorRef: string, artifact: Uint8Array): CatalogPublicationRulesHandle {
  const bytes = Buffer.from(artifact);
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== validatorRef)
    return publicationRefuse("catalog_publication_rules_digest_mismatch");
  try {
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    // The isolated realm supplies language intrinsics, without Node imports,
    // file resolution, request state, clocks or an ambient configuration.
    // This is an installation boundary for trusted bundles.
    const dispatch = new Script(`(() => {
      "use strict";
      const parse = JSON.parse, stringify = JSON.stringify;
      Object.defineProperty(globalThis, "Date", { value: undefined, configurable: false, writable: false });
      Object.defineProperty(Math, "random", { value: undefined, configurable: false, writable: false });
      const module = { exports: {} };
      ((module, exports) => {
${source}
      })(module, module.exports);
      const exported = Object.freeze(module.exports);
      const hooks = Object.freeze(Object.fromEntries(${JSON.stringify([...requiredHooks, ...optionalHooks])}.map(key =>
        [key, Object.getOwnPropertyDescriptor(exported, key)?.value])));
      const available = key => typeof hooks[key] === "function";
      if (!${JSON.stringify(requiredHooks)}.every(available)) throw new Error("rules");
      return Object.freeze({
        available,
        invoke: (key, args) => stringify(Reflect.apply(hooks[key], exported, parse(args))),
      });
    })()`).runInNewContext(Object.create(null), { contextCodeGeneration: { strings: false, wasm: false } }) as {
      available(key: string): boolean;
      invoke(key: string, args: string): string;
    };
    const rules = Object.fromEntries([...requiredHooks, ...optionalHooks].filter(key => dispatch.available(key))
      .map(key => [key, (...args: unknown[]) => JSON.parse(dispatch.invoke(key, JSON.stringify(args))) as unknown]));
    const handle = Object.freeze({}) as CatalogPublicationRulesHandle;
    handles.set(handle, { validatorRef, rules: Object.freeze(rules) as unknown as CatalogPublicationRulesModule });
    return handle;
  } catch {
    return publicationRefuse("catalog_publication_rules_module_invalid");
  }
}

export function resolvePublicationRules(handle: CatalogPublicationRulesHandle, validatorRef: string | undefined): CatalogPublicationRulesModule {
  const binding = handles.get(handle);
  if (!binding || binding.validatorRef !== validatorRef) return publicationRefuse("catalog_publication_rules_binding_mismatch");
  return binding.rules;
}
