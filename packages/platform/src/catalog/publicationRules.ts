import { createHash } from "node:crypto";
import { Script } from "node:vm";
import type { CatalogQuantity } from "@openlup/core/catalog";
import type { CatalogPublishedProduct, CatalogPublishedSku } from "./publicationContracts.js";
import type { CatalogProductTypeInput, CatalogProductTypeRef } from "./contracts/productTypes.js";
import type { CatalogPackInput } from "./contracts/catalogPack.js";
import type { CatalogCandidateIssue } from "./contracts/candidate.js";
import type { CatalogPublicationRulesModule, CatalogPublicationRulesPack, CatalogRulesContext } from "./catalogPublicationRules.js";
import type { RulesProduct, RulesSku } from "./contracts/publicationRuleFacts.js";
import { publicationIssue, CatalogPublicationError, publicationRefuse } from "./publicationError.js";

import { z } from "./validation.js";
import { publishedFactsSchema, publicationReadinessReasons } from "./publicationCodec.js";

type Hook = keyof CatalogPublicationRulesModule;
const issueCode = z.string().regex(/^[a-z][a-z0-9_]{0,159}$/u);
const relativePath = z.string().max(240).regex(/^(?:[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*)?$/u);
const documentField = z.string().min(1).max(240).refine(value => value.trim() === value && !/[\p{Cc}\p{Cs}]/u.test(value));
const documentIdentity = z.object({ schemaId: documentField, documentRef: documentField, productSlug: documentField,
  revisionNo: z.number().int().min(1).max(2_147_483_647), name: z.string().min(1).max(500).refine(value => !/[\p{Cc}\p{Cs}]/u.test(value)).optional() }).strict();
const results = {
  validateContent: [z.array(z.object({ path: relativePath, code: issueCode }).strict()).max(100),
    "Return an array of field issues with relative paths and reason codes, or [] when the content is valid."],
  validateProduct: [publicationReadinessReasons, "Return an array of reason codes, or [] when the product is valid."],
  inspectDocument: [documentIdentity.extend({ canonicallyEncoded: z.boolean() }).nullable(),
    "Return the document identity and its canonicality flag, or null for an invalid document."],
  identifyDocument: [documentIdentity.nullable(), "Return the document identity, or null for an invalid document."],
  matchesDocument: [z.boolean(), "Return true or false to report whether the documents match."],
  deriveSkuFacts: [publishedFactsSchema, "Return a JSON object of SKU facts within the publication size and depth limits. Values can include nested objects and arrays."],
  classifySkuChange: [z.enum(["compatible", "material", "inconclusive"]), "Return compatible, material or inconclusive."],
  validateMembershipChange: [z.boolean(), "Return true or false to accept or refuse the membership change."],
  validateSkuAmounts: [z.boolean(), "Return true or false to accept or refuse the SKU quantity."],
  validateTypedSkuAmounts: [z.boolean(), "Return true or false to accept or refuse the authored SKU quantity."],
} satisfies Record<Hook, readonly [z.ZodType, string]>;
const localContext: CatalogRulesContext = Object.freeze({ evaluatedAt: null });

const requiredHooks = ["validateContent", "validateProduct", "inspectDocument", "matchesDocument", "identifyDocument",
  "deriveSkuFacts", "classifySkuChange"] as const satisfies readonly (keyof CatalogPublicationRulesModule)[];
const optionalHooks = ["validateMembershipChange", "validateSkuAmounts"] as const satisfies readonly (keyof CatalogPublicationRulesModule)[];
const typedAmountHook = "validateTypedSkuAmounts";
const legacyHooks = [...requiredHooks, ...optionalHooks];
type Binding = {
  validatorRef: `sha256:${string}`; bytes: Buffer;
  rules(evaluation: CatalogRulesContext, mode?: "typed"): CatalogPublicationRulesModule;
};
const boundValidators = new WeakMap<CatalogProductTypeInput["validateContent"], Binding & CatalogProductTypeRef>();
const referenceFor = (bytes: Uint8Array): `sha256:${string}` => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const realmLimits = ["Date", "Math.random", "require", "process"] as const;

function runRule<T>(hook: Hook | "module", invoke: () => T): T {
  const [schema, shape] = hook === "module" ? [undefined, "Export the required hooks from the self-contained rules build."]
    : results[hook];
  let value: T | undefined;
  let cause: NonNullable<CatalogCandidateIssue["cause"]> = "undefined_result";
  let fix = shape;
  try { value = invoke(); }
  catch (error) {
    let message: unknown, refusal: CatalogPublicationError | undefined;
    try {
      if (error instanceof CatalogPublicationError) refusal = error;
      message = error && typeof error === "object" ? Reflect.get(error, "message") : undefined;
    } catch { /* A thrown value cannot interrupt the refusal. */ }
    if (refusal) throw refusal;
    const limit = realmLimits.find(name => `catalog_rule_limit:${name}` === message);
    const dynamicCode = typeof message === "string" && /^(?:Code generation from strings disallowed|Wasm code generation disallowed)/u.test(message);
    cause = limit || dynamicCode ? "realm_limit" : "throw";
    if (limit || dynamicCode) fix = `Remove ${limit ?? "dynamic code generation"} from the hook and use its supplied inputs.`;
  }
  if (value !== undefined) {
    if (!schema) return value;
    // Decode the realm's result before any JSON conversion can change its type.
    try {
      if (value !== null && (typeof value === "object" || typeof value === "function") && typeof Reflect.get(value, "then") === "function") {
        void Promise.resolve(value).catch(() => undefined);
        fix = `rules must be synchronous and pure: ${hook} returned a Promise`;
      } else {
        const decoded = schema.safeParse(value);
        if (decoded.success) return decoded.data as T;
      }
    } catch { /* A value that could not be decoded is an invalid hook result. */ }
    cause = "invalid_result";
  }
  const code = "catalog_publication_rule_failed";
  throw new CatalogPublicationError({ ...publicationIssue(code, undefined, hook), hook, cause,
    detail: `Product rule ${hook} failed. ${fix}` });
}

export function ruleProduct({ source: _source, document: _document, content: _content, ...product }: CatalogPublishedProduct): RulesProduct {
  return product;
}
export function ruleSku({ source: _source, ...sku }: CatalogPublishedSku): RulesSku {
  return sku;
}

/** Check the selected authored term after physical validation on the typed path. */
export function assertTypedSkuAmounts(rules: Pick<CatalogPublicationRulesModule, "validateTypedSkuAmounts" | "validateSkuAmounts"> | undefined,
  { code, netContent }: { code: string; netContent: CatalogQuantity }, path: string): void {
  const hook = rules?.validateTypedSkuAmounts;
  if (!hook) {
    if (rules?.validateSkuAmounts) throw new CatalogPublicationError({
      ...publicationIssue("catalog_publication_integral_grams_required", "structural", path, code),
      detail: "Install a product rule that exports validateTypedSkuAmounts to govern count or volume amounts.",
    });
    return;
  }
  const { dimension, unit, unscaled, scale } = netContent;
  let accepted: boolean;
  try { accepted = hook({ code, netContent: { dimension, unit, unscaled, scale } }); }
  catch (error) {
    if (!(error instanceof CatalogPublicationError)) throw error;
    throw new CatalogPublicationError({ ...error.diagnostic, phase: "structural", path, subject: code }, error.outcome);
  }
  if (!accepted) throw new CatalogPublicationError(
    publicationIssue("catalog_publication_authored_amounts_invalid", "structural", path, code));
}

export function bindCatalogPublicationRules(pack: CatalogPublicationRulesPack,
  rulesFor: (type: CatalogProductTypeRef) => Uint8Array | undefined): CatalogPackInput {
  const types = pack.types.map(type => {
    const artifact = rulesFor({ key: type.key, version: type.version });
    if (artifact === undefined) {
      if (!type.validateContent) return publicationRefuse("catalog_publication_rules_module_invalid");
      return { ...type, validateContent: type.validateContent };
    }
    const binding = loadCatalogPublicationRules(type.validatorRef, artifact);
    const validateContent = binding.rules(localContext).validateContent;
    boundValidators.set(validateContent, { ...binding, key: type.key, version: type.version });
    return Object.freeze({ ...type, validatorRef: binding.validatorRef, publicationRules: true as const, validateContent });
  });
  return Object.freeze({ ...pack, types: Object.freeze(types) });
}

export function readPublicationRulesAsset(artifact: Uint8Array, evaluation = localContext): Readonly<CatalogPublicationRulesModule> {
  return loadCatalogPublicationRules(undefined, artifact).rules(evaluation);
}

/** @internal Only the selected definition can resolve its installed executable. */
export function resolvePublicationRules(definition: CatalogProductTypeInput, evaluation: CatalogRulesContext, recheck = false,
  mode?: "typed") {
  const binding = boundValidators.get(definition.validateContent);
  if (!binding && !definition.publicationRules) return undefined;
  if (!binding || binding.key !== definition.key || binding.version !== definition.version
    || binding.validatorRef !== definition.validatorRef || recheck && referenceFor(binding.bytes) !== definition.validatorRef)
    return publicationRefuse("catalog_publication_rules_binding_mismatch");
  return binding.rules(evaluation, mode);
}

export function verifyCatalogRulesAtInstall(pack: CatalogPackInput): void {
  for (const type of pack.types) resolvePublicationRules(type, localContext, true);
}

/** @internal Load trusted JavaScript rules from the verified byte snapshot. */
export function loadCatalogPublicationRules(expectedRef: string | undefined, artifact: Uint8Array): Binding {
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
      const parse = JSON.parse;
      const refuseLimit = name => ({ get: () => { throw new Error("catalog_rule_limit:" + name); } });
      for (const name of ["Date", "require", "process"]) Object.defineProperty(globalThis, name, refuseLimit(name));
      Object.defineProperty(Math, "random", refuseLimit("Math.random"));
      const module = { exports: {} };
      ((module, exports) => {
${source}
      })(module, module.exports);
      const exported = Object.freeze(module.exports);
      const hooks = Object.freeze(Object.fromEntries(${JSON.stringify(legacyHooks)}.map(key =>
        [key, Object.getOwnPropertyDescriptor(exported, key)])));
      const typedKey = ${JSON.stringify(typedAmountHook)};
      const typedDescriptor = () => Object.getOwnPropertyDescriptor(exported, typedKey);
      const hookValue = descriptor => descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
      return Object.freeze({
        status: key => {
          if (key !== typedKey) return typeof hooks[key]?.value === "function" ? "callable" : hooks[key] ? "invalid" : "absent";
          const descriptor = typedDescriptor();
          return typeof hookValue(descriptor) === "function" ? "callable" : descriptor ? "invalid" : "absent";
        },
        invoke: (key, args) => Reflect.apply(key === typedKey ? hookValue(typedDescriptor()) : hooks[key]?.value, exported, parse(args)),
      });
    })()`);
    type Dispatch = {
      status(key: Hook): "callable" | "invalid" | "absent";
      invoke(key: Hook, args: string): unknown;
    };
    const instantiate = (): Dispatch => script.runInNewContext(Object.create(null), { contextCodeGeneration: { strings: false, wasm: false } });
    const probe = instantiate();
    const invalidRequired = requiredHooks.find(key => probe.status(key) !== "callable");
    const invalidOptional = optionalHooks.find(key => probe.status(key) === "invalid");
    function refuseInvalidHook(hook: Hook, required = false): never {
      const code = "catalog_publication_rules_module_invalid";
      const remedy = required ? "Export it as a function." : "Export it as a function or omit it.";
      throw new CatalogPublicationError({ ...publicationIssue(code, undefined, hook), hook,
        detail: `Product rule ${hook} must be a function. ${remedy}` });
    }
    if (invalidRequired) refuseInvalidHook(invalidRequired, true);
    if (invalidOptional) refuseInvalidHook(invalidOptional);
    const available = legacyHooks.filter(key => probe.status(key) === "callable");
    return { validatorRef, bytes, rules: (evaluation, mode) => {
      const status = mode === "typed" ? runRule("module", () => probe.status(typedAmountHook)) : "absent";
      if (status === "invalid") refuseInvalidHook(typedAmountHook);
      const keys: readonly Hook[] = status === "callable" ? [...available, typedAmountHook] : available;
      const context = { ...evaluation };
      return Object.freeze(Object.fromEntries(keys.map(key => [key, (...args: unknown[]) =>
        runRule(key, () => {
          // Each method receives the same explicit final argument, including local use.
          const arity = { validateContent: 1, validateProduct: 3, validateMembershipChange: 2, inspectDocument: 1,
            matchesDocument: 2, identifyDocument: 1, validateSkuAmounts: 1, validateTypedSkuAmounts: 1,
            deriveSkuFacts: 2, classifySkuChange: 3 }[key];
          return instantiate().invoke(key, JSON.stringify([...args.slice(0, arity), args[arity] ?? context]));
        })]))) as unknown as CatalogPublicationRulesModule;
    } };
  });
}
