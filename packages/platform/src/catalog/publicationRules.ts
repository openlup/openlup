import { createHash } from "node:crypto";
import { Script } from "node:vm";
import type { CatalogPublishedProduct, CatalogPublishedSku } from "./contracts/publication.js";
import type { CatalogProductTypeRef } from "./contracts/productTypes.js";
import type { CatalogPackInput } from "./contracts/catalogPack.js";
import type { CatalogPublicationRulesModule } from "./catalogPublicationRules.js";
import type { RulesProduct, RulesSku } from "./contracts/publicationRuleFacts.js";
import { publicationRefuse } from "./publicationError.js";

declare const handleBrand: unique symbol;

/** @internal */
export interface CatalogPublicationRulesHandle { readonly [handleBrand]: true }

const requiredHooks = ["validateContent", "validateProduct", "inspectDocument", "matchesDocument", "identifyDocument",
  "deriveSkuFacts", "classifySkuChange"] as const satisfies readonly (keyof CatalogPublicationRulesModule)[];
const optionalHooks = ["validateMembershipChange", "validateSkuAmounts"] as const satisfies readonly (keyof CatalogPublicationRulesModule)[];
const handles = new WeakMap<CatalogPublicationRulesHandle, {
  validatorRef: `sha256:${string}`; bytes: Buffer; rules: CatalogPublicationRulesModule;
}>();
const rulePacks = new WeakMap<CatalogPackInput, ReadonlyMap<string, CatalogPublicationRulesHandle>>();
const referenceFor = (bytes: Uint8Array): `sha256:${string}` => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const typeKey = ({ key, version }: CatalogProductTypeRef): string => `${key}@${version}`;

export function ruleProduct({ source: _source, document: _document, content: _content, ...product }: CatalogPublishedProduct): RulesProduct {
  return product;
}
export function ruleSku({ source: _source, ...sku }: CatalogPublishedSku): RulesSku {
  return sku;
}

export function bindCatalogPublicationRules<P extends CatalogPackInput>(pack: P,
  rulesFor: (type: CatalogProductTypeRef) => Uint8Array | undefined): P {
  const bindings = new Map<string, CatalogPublicationRulesHandle>();
  const types = pack.types.map(type => {
    const artifact = rulesFor({ key: type.key, version: type.version });
    if (artifact === undefined) return type;
    const handle = loadCatalogPublicationRules(type.validatorRef, artifact);
    bindings.set(typeKey(type), handle);
    return Object.freeze({ ...type, validatorRef: handles.get(handle)!.validatorRef });
  });
  const bound: P = Object.freeze({ ...pack, types: Object.freeze(types) });
  rulePacks.set(bound, bindings);
  return bound;
}

/** @internal */
export function publicationRulesFor(pack: CatalogPackInput, type: CatalogProductTypeRef): CatalogPublicationRulesHandle | undefined {
  return rulePacks.get(pack)?.get(typeKey(type));
}

/** @internal */
export function verifyCatalogRulesAtInstall(pack: CatalogPackInput): void {
  const bindings = rulePacks.get(pack);
  if (bindings) for (const type of pack.types) {
    const handle = bindings.get(typeKey(type));
    if (handle) resolvePublicationRules(handle, type.validatorRef, true);
  }
}

/** @internal Load trusted JavaScript rules from the verified byte snapshot. */
export function loadCatalogPublicationRules(expectedRef: string | undefined, artifact: Uint8Array): CatalogPublicationRulesHandle {
  const bytes = Buffer.from(artifact);
  const validatorRef = referenceFor(bytes);
  if (expectedRef !== undefined && validatorRef !== expectedRef)
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
    handles.set(handle, { validatorRef, bytes, rules: Object.freeze(rules) as unknown as CatalogPublicationRulesModule });
    return handle;
  } catch {
    return publicationRefuse("catalog_publication_rules_module_invalid");
  }
}

export function resolvePublicationRules(handle: CatalogPublicationRulesHandle, validatorRef: string | undefined, recheck = false): CatalogPublicationRulesModule {
  const binding = handles.get(handle);
  if (!binding || binding.validatorRef !== validatorRef || recheck && referenceFor(binding.bytes) !== validatorRef) return publicationRefuse("catalog_publication_rules_binding_mismatch");
  return binding.rules;
}
