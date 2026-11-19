import { createHash } from "node:crypto";
import { Script } from "node:vm";
import type { CatalogPublishedProduct, CatalogPublishedSku } from "./contracts/publication.js";
import type { CatalogProductTypeInput, CatalogProductTypeRef } from "./contracts/productTypes.js";
import type { CatalogPackInput } from "./contracts/catalogPack.js";
import type { CatalogCandidateIssue } from "./contracts/candidate.js";
import type { CatalogPublicationRulesModule, CatalogPublicationRulesPack } from "./catalogPublicationRules.js";
import type { RulesProduct, RulesSku } from "./contracts/publicationRuleFacts.js";
import { CatalogPublicationError, publicationRefuse } from "./publicationError.js";

declare const handleBrand: unique symbol;

/** @internal */
export interface CatalogPublicationRulesHandle { readonly [handleBrand]: true }

const requiredHooks = ["validateContent", "validateProduct", "inspectDocument", "matchesDocument", "identifyDocument",
  "deriveSkuFacts", "classifySkuChange"] as const satisfies readonly (keyof CatalogPublicationRulesModule)[];
const optionalHooks = ["validateMembershipChange", "validateSkuAmounts"] as const satisfies readonly (keyof CatalogPublicationRulesModule)[];
const handles = new WeakMap<CatalogPublicationRulesHandle, {
  validatorRef: `sha256:${string}`; bytes: Buffer; rules: CatalogPublicationRulesModule;
}>();
const boundValidators = new WeakMap<CatalogProductTypeInput["validateContent"], CatalogPublicationRulesHandle>();
const referenceFor = (bytes: Uint8Array): `sha256:${string}` => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const realmLimits = ["Date", "Math.random", "require", "process"] as const;

function runRule<T>(hook: string, invoke: () => T | undefined): T {
  let value: T | undefined;
  let cause: NonNullable<CatalogCandidateIssue["cause"]> = "undefined_result";
  let fix = "Return a JSON value from the hook.";
  try { value = invoke(); }
  catch (error) {
    const message = error && typeof error === "object" && "message" in error ? error.message : undefined;
    const limit = realmLimits.find(name => `catalog_rule_limit:${name}` === message);
    const dynamicCode = typeof message === "string" && /^(?:Code generation from strings disallowed|Wasm code generation disallowed)/u.test(message);
    cause = limit || dynamicCode ? "realm_limit" : "throw";
    fix = limit || dynamicCode
      ? `Remove ${limit ?? "dynamic code generation"} from the hook and use its supplied inputs.`
      : "Handle the input and return the result required by the hook.";
  }
  if (value !== undefined) return value;
  const code = "catalog_publication_rule_failed";
  throw new CatalogPublicationError(code, "validation_issue", { code, path: hook, hook, cause,
    message: `Product rule ${hook} failed. ${fix}` });
}

export function ruleProduct({ source: _source, document: _document, content: _content, ...product }: CatalogPublishedProduct): RulesProduct {
  return product;
}
export function ruleSku({ source: _source, ...sku }: CatalogPublishedSku): RulesSku {
  return sku;
}

export function bindCatalogPublicationRules(pack: CatalogPublicationRulesPack,
  rulesFor: (type: CatalogProductTypeRef) => Uint8Array | undefined): CatalogPackInput {
  const types = pack.types.map(type => {
    const artifact = rulesFor({ key: type.key, version: type.version });
    if (artifact === undefined) {
      if (!type.validateContent) return publicationRefuse("catalog_publication_rules_module_invalid");
      return { ...type, validateContent: type.validateContent };
    }
    const handle = loadCatalogPublicationRules(type.validatorRef, artifact);
    const { validatorRef, rules } = handles.get(handle)!;
    boundValidators.set(rules.validateContent, handle);
    return Object.freeze({ ...type, validatorRef, validateContent: rules.validateContent });
  });
  return Object.freeze({ ...pack, types: Object.freeze(types) });
}

export function readPublicationRulesAsset(artifact: Uint8Array): Readonly<CatalogPublicationRulesModule> {
  return handles.get(loadCatalogPublicationRules(undefined, artifact))!.rules;
}

/** @internal */
export function publicationRulesFor(definition: CatalogProductTypeInput): CatalogPublicationRulesHandle | undefined {
  return boundValidators.get(definition.validateContent);
}

/** @internal */
export function verifyCatalogRulesAtInstall(pack: CatalogPackInput): void {
  for (const type of pack.types) {
    const handle = publicationRulesFor(type);
    if (!handle) return publicationRefuse("catalog_publication_rules_binding_mismatch");
    resolvePublicationRules(handle, type.validatorRef, true);
  }
}

/** @internal Load trusted JavaScript rules from the verified byte snapshot. */
export function loadCatalogPublicationRules(expectedRef: string | undefined, artifact: Uint8Array): CatalogPublicationRulesHandle {
  const bytes = Buffer.from(artifact);
  const validatorRef = referenceFor(bytes);
  if (expectedRef !== undefined && validatorRef !== expectedRef)
    return publicationRefuse("catalog_publication_rules_digest_mismatch");
  return runRule("module", () => {
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    // The isolated realm supplies language intrinsics, without Node imports,
    // file resolution, request state, clocks or an ambient configuration.
    // This is an installation boundary for trusted bundles.
    const script = new Script(`(() => {
      "use strict";
      const parse = JSON.parse, stringify = JSON.stringify;
      const refuseLimit = name => ({ get: () => { throw new Error("catalog_rule_limit:" + name); } });
      for (const name of ["Date", "require", "process"]) Object.defineProperty(globalThis, name, refuseLimit(name));
      Object.defineProperty(Math, "random", refuseLimit("Math.random"));
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
    })()`);
    type Dispatch = {
      available(key: string): boolean;
      invoke(key: string, args: string): string | undefined;
    };
    const instantiate = (): Dispatch => script.runInNewContext(Object.create(null), { contextCodeGeneration: { strings: false, wasm: false } });
    const probe = instantiate();
    const rules = Object.fromEntries([...requiredHooks, ...optionalHooks].filter(key => probe.available(key))
      .map(key => [key, (...args: unknown[]) => runRule(key, () => {
        const text = instantiate().invoke(key, JSON.stringify(args));
        return text === undefined ? undefined : JSON.parse(text) as unknown;
      })]));
    const handle = Object.freeze({}) as CatalogPublicationRulesHandle;
    handles.set(handle, { validatorRef, bytes, rules: Object.freeze(rules) as unknown as CatalogPublicationRulesModule });
    return handle;
  });
}

export function resolvePublicationRules(handle: CatalogPublicationRulesHandle, validatorRef: string | undefined, recheck = false): CatalogPublicationRulesModule {
  const binding = handles.get(handle);
  if (!binding || binding.validatorRef !== validatorRef || recheck && referenceFor(binding.bytes) !== validatorRef) return publicationRefuse("catalog_publication_rules_binding_mismatch");
  return binding.rules;
}
