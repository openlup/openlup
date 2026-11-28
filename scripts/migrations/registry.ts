import { parseStrictJson } from "../oss-strict-json.mts";
import { accountWithdrawalSignature, creations, identityPrivilegeKeys, managedInvoicing, paymentTerminalSignature, portableCreationPaths, portableReplacements, qualifiedInstallationPaths, qualifiedOwnerPathSignatures, replacements, runtimePrivilegeKeys, runtimeReplacements, runtimeRetiredPolicies, validateBatchedForwards, validateChannelIngestForwards, validateManagedCommerceForwards, validateSupportAuthorityForwards } from "./historical-classes.ts";
import { assertNativeStoreClassTransition, assertRevokePublicPlacement, validateNativeStoreClass } from "./native-store-admission.ts";
import { canonical, FORWARD_LISTS, hash, MANAGED_BASELINE, REVIEWED_FORWARD_PATH, sqlSha256, type ForwardBinding, type ReviewedForwardRegistry } from "./types.ts";

export function readReviewedForwardRegistry(bytes: Buffer): ReviewedForwardRegistry {
  return readForwardRegistry(bytes, false);
}

const forwardRegistryCache = new Map<string, ReviewedForwardRegistry>();
const MAX_FORWARD_REGISTRY_CACHE_ENTRIES = 64;

// Only approval-history comparison may read the exact prior inventories.
// Candidate admission always uses the strict public reader above.
export function readForwardRegistry(bytes: Buffer, historical: boolean): ReviewedForwardRegistry {
  const cacheKey = `${historical ? "h" : "c"}:${sqlSha256(bytes)}`;
  const cached = forwardRegistryCache.get(cacheKey);
  if (cached) return structuredClone(cached);
  const validated = parseAndValidateForwardRegistry(bytes, historical);
  if (forwardRegistryCache.size >= MAX_FORWARD_REGISTRY_CACHE_ENTRIES) forwardRegistryCache.clear();
  forwardRegistryCache.set(cacheKey, structuredClone(validated));
  return validated;
}

function parseAndValidateForwardRegistry(bytes: Buffer, historical: boolean): ReviewedForwardRegistry {
  const raw = parseStrictJson(bytes.toString("utf8"), REVIEWED_FORWARD_PATH) as ReviewedForwardRegistry;
  assertRevokePublicPlacement(raw);
  if (raw.schemaVersion !== 1 || !hash(raw.baselineSha256) || !Array.isArray(raw.replacementForwards) || raw.replacementForwards.length !== 2 || !Array.isArray(raw.creationForwards) || raw.creationForwards.length !== 1) throw new Error("reviewed replacement registry requires one baseline, two replacement forwards and one creation forward");
  const paths = new Set<string>(), signatures = new Set<string>(), replaced = new Set<string>();
  if (raw.qualifiedInstallations !== undefined) {
    if (!Array.isArray(raw.qualifiedInstallations) || ![4, 5, 6, 7, 12, 16, 17, 18].includes(raw.qualifiedInstallations.length)) throw new Error("qualified installation approval requires an exact supported prefix");
    for (const [index, entry] of raw.qualifiedInstallations.entries()) {
      if (!entry || entry.path !== qualifiedInstallationPaths[index] || !hash(entry.sha256)) throw new Error("qualified installation approval has an invalid fixed identity or hash");
      if (index !== 6) {
        if (Object.keys(entry).sort().join(",") !== "path,sha256") throw new Error("qualified installation approval has an invalid fixed identity or hash");
      } else {
        const forward = entry as ForwardBinding;
        if (Object.keys(forward).sort().join(",") !== "functions,path,sha256"
          || !Array.isArray(forward.functions)
          || JSON.stringify(forward.functions.map(fn => fn?.signature)) !== JSON.stringify(qualifiedOwnerPathSignatures)
          || forward.functions.some(fn => !fn || Object.keys(fn).sort().join(",") !== "afterSha256,beforeSha256,signature" || !hash(fn.beforeSha256) || !hash(fn.afterSha256))) throw new Error("qualified installation approval has an invalid owner path function binding");
      }
      paths.add(entry.path);
    }
  }
  for (const forward of [...raw.replacementForwards, ...raw.creationForwards]) {
    if (!/^supabase\/migrations\/\d{14}_[A-Za-z0-9_-]+\.sql$/u.test(forward.path) || paths.has(forward.path) || !hash(forward.sha256) || !Array.isArray(forward.functions) || forward.functions.length === 0) throw new Error("reviewed replacement registry has an invalid or duplicate forward");
    paths.add(forward.path);
    for (const binding of forward.functions) {
      if (!/^public\.[a-z_][a-z0-9_]*\((?:(?:uuid|text|jsonb|integer)(?:,(?:uuid|text|jsonb|integer))*)?\)$/u.test(binding.signature) || signatures.has(binding.signature) || !hash(binding.afterSha256) || (binding.beforeSha256 !== null && !hash(binding.beforeSha256))) throw new Error("reviewed replacement registry has an invalid or duplicate signature");
      if ((binding.beforeSha256 === null) !== raw.creationForwards.includes(forward)) throw new Error("reviewed replacement and creation approvals must remain separate");
      signatures.add(binding.signature);
      if (binding.beforeSha256 !== null) replaced.add(binding.signature);
    }
  }
  if (replaced.size !== replacements.size || [...replacements].some((signature) => !replaced.has(signature))) throw new Error("reviewed replacement registry must bind exactly the three approved existing signatures");
  if (signatures.size !== replacements.size + creations.size || [...creations].some((signature) => !signatures.has(signature) || replaced.has(signature))) throw new Error("reviewed replacement registry must also bind exactly the two companion creations");
  if (raw.runtimeForwards !== undefined) {
    if (!Array.isArray(raw.runtimeForwards) || raw.runtimeForwards.length < 1 || raw.runtimeForwards.length > 2) throw new Error("reviewed replacement runtime registry requires one or two forwards");
    for (const [index, forward] of raw.runtimeForwards.entries()) {
      if (!/^supabase\/migrations\/\d{14}_[A-Za-z0-9_-]+\.sql$/u.test(forward.path) || paths.has(forward.path) || !hash(forward.sha256) || !Array.isArray(forward.functions) || forward.functions.length !== (index === 0 ? runtimeReplacements.size : 0) || (index === 1 && "retiredPolicies" in forward) || !Array.isArray(forward.privileges) || forward.privileges.length === 0) throw new Error("reviewed replacement runtime registry has an invalid forward");
      paths.add(forward.path);
      const runtimeSignatures = new Set<string>();
      for (const binding of forward.functions) {
        if (!runtimeReplacements.has(binding.signature) || runtimeSignatures.has(binding.signature) || !hash(binding.beforeSha256) || !hash(binding.afterSha256)) throw new Error("reviewed replacement runtime registry has an invalid or duplicate existing signature");
        runtimeSignatures.add(binding.signature);
      }
      if (new Set(forward.privileges).size !== forward.privileges.length) throw new Error("reviewed replacement runtime registry has duplicate privileges");
      if (forward.retiredPolicies !== undefined) {
        if (!Array.isArray(forward.retiredPolicies) || forward.retiredPolicies.length !== runtimeRetiredPolicies.size) throw new Error("reviewed replacement runtime requires exactly eight retired browser policies");
        const retired = new Set<string>();
        for (const binding of forward.retiredPolicies) {
          if (Object.keys(binding).sort().join(",") !== "beforeSha256,name,table" || runtimeRetiredPolicies.get(binding.table) !== binding.name || retired.has(binding.table) || !hash(binding.beforeSha256)) throw new Error("reviewed replacement runtime has invalid or duplicate retired policy");
          retired.add(binding.table);
        }
      }
      const privilegeKeys = forward.privileges.flatMap(index === 0 ? runtimePrivilegeKeys : identityPrivilegeKeys);
      if (new Set(privilegeKeys).size !== privilegeKeys.length) throw new Error("reviewed replacement runtime registry has duplicate privilege capabilities");
    }
  }
  if (raw.portableReplacementForwards !== undefined) {
    if (!Array.isArray(raw.portableReplacementForwards) || ![1,2,3,4].includes(raw.portableReplacementForwards.length)) throw new Error("reviewed portable replacement registry requires one, two, three or four fixed forwards");
    for (const [index, forward] of raw.portableReplacementForwards.entries()) {
      if (!forward || Object.keys(forward).sort().join(",") !== "functions,path,sha256" || !/^db\/platform\/migrations\/\d{14}_[A-Za-z0-9_-]+\.sql$/u.test(forward.path) || paths.has(forward.path) || raw.portableReplacementForwards.findIndex(entry => entry.path === forward.path) !== index || !hash(forward.sha256) || !Array.isArray(forward.functions) || forward.functions.length !== 1) throw new Error("reviewed portable replacement registry has an invalid forward");
      paths.add(forward.path);
      const binding = forward.functions[0]!;
      if (Object.keys(binding).sort().join(",") !== "afterSha256,beforeSha256,signature" || !(index === 0 ? portableReplacements.has(binding.signature) : index === 1 ? forward.path === "db/platform/migrations/20261022192000_invoicing_payment_decoupling.sql" && binding.signature === paymentTerminalSignature : index === 2 ? forward.path === "db/platform/migrations/20261022165000_fulfillment_stock_evidence_replay_reopen.sql" && binding.signature === "public.fulfillment_record_stock_evidence(text,text,text,text,text,text,integer,integer)" : forward.path === "db/platform/migrations/20261030110000_customer_newsletter_withdrawal.sql" && binding.signature === accountWithdrawalSignature) || !hash(binding.beforeSha256) || !hash(binding.afterSha256)) throw new Error("reviewed portable replacement registry must bind exactly the approved existing signature");
    }
  }
  if (raw.managedInvoicingForwards !== undefined) {
    if (!Array.isArray(raw.managedInvoicingForwards) || raw.managedInvoicingForwards.length !== managedInvoicing.length) throw new Error("reviewed managed invoicing requires exactly three fixed forwards");
    for (const [index, forward] of raw.managedInvoicingForwards.entries()) {
      const allowed = managedInvoicing[index]!;
      if (!forward || Object.keys(forward).sort().join(",") !== "functions,path,sha256" || forward.path !== allowed.path || paths.has(forward.path) || !hash(forward.sha256) || !Array.isArray(forward.functions) || forward.functions.length !== allowed.signatures.length) throw new Error("reviewed managed invoicing has an invalid forward");
      paths.add(forward.path);
      for (const [position, binding] of forward.functions.entries()) {
        if (Object.keys(binding).sort().join(",") !== "afterSha256,beforeSha256,signature" || binding.signature !== allowed.signatures[position] || !hash(binding.afterSha256) || (allowed.creation ? binding.beforeSha256 !== null : !hash(binding.beforeSha256))) throw new Error("reviewed managed invoicing signature or creation/replacement class drifted");
      }
    }
  }
  if (raw.portableCreationForwards !== undefined) {
    if (!Array.isArray(raw.portableCreationForwards) || ![2,portableCreationPaths.length].includes(raw.portableCreationForwards.length)) throw new Error("reviewed portable creation registry requires exactly the approved forwards");
    for (const [index, forward] of raw.portableCreationForwards.entries()) {
      if (!forward || Object.keys(forward).sort().join(",") !== "path,sha256" || forward.path !== portableCreationPaths[index] || paths.has(forward.path) || raw.portableReplacementForwards?.some((entry) => entry.path === forward.path) || !hash(forward.sha256)) throw new Error("reviewed portable creation registry has an invalid or duplicate forward");
      paths.add(forward.path);
    }
  }
  if (raw.batchedForwards !== undefined) validateBatchedForwards(raw.batchedForwards, paths, historical);
  if (raw.managedCommerceForwards !== undefined) {
    if (!raw.batchedForwards) throw new Error("reviewed M11 commerce requires the complete M10 controls");
    validateManagedCommerceForwards(raw.managedCommerceForwards, paths, historical);
  }
  if (raw.supportAuthorityForwards !== undefined) validateSupportAuthorityForwards(raw.supportAuthorityForwards, paths);
  if (raw.channelIngestForwards !== undefined) validateChannelIngestForwards(raw.channelIngestForwards, paths);
  validateNativeStoreClass(raw, paths);
  if (raw.managedExactForwards !== undefined) {
    if (!Array.isArray(raw.managedExactForwards)) throw new Error("exact managed forwards require an ordered list");
    let previous = MANAGED_BASELINE;
    for (const forward of raw.managedExactForwards) {
      if (!forward || Object.keys(forward).sort().join(",") !== "path,prefixSha256,sha256"
        || !/^supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/u.test(forward.path)
        || forward.path <= previous || paths.has(forward.path) || !hash(forward.sha256) || !hash(forward.prefixSha256)) {
        throw new Error("invalid, duplicate or unordered exact managed forward");
      }
      previous = forward.path;
      paths.add(forward.path);
    }
  }
  return raw;
}

export const sharedApproval = (registry: ReviewedForwardRegistry) => Object.fromEntries(Object.entries(registry).filter(([key]) => key !== "nativeStoreForwardClass" && !FORWARD_LISTS.includes(key as typeof FORWARD_LISTS[number])));
export const approvalBinding = (registry: ReviewedForwardRegistry, path: string) => {
  for (const list of FORWARD_LISTS) {
    const index = registry[list]?.findIndex((entry) => entry.path === path) ?? -1;
    if (index >= 0) return { list, index, entry: registry[list]![index] };
  }
  return null;
};

/** Preserve shared fields and issued positions while allowing new class data and pins. */
export function changedForwardApprovals(before: Buffer, after: Buffer): string[] {
  const prior = readReviewedForwardRegistry(before), current = readReviewedForwardRegistry(after);
  assertNativeStoreClassTransition(prior, current);
  if (canonical(sharedApproval(prior)) !== canonical(sharedApproval(current))) throw new Error("reviewed replacement shared approval fields must be approved separately");
  if (prior.channelIngestForwards !== undefined && current.channelIngestForwards === undefined) throw new Error("issued M17 channel class approval cannot be removed");
  const changed: string[] = [];
  for (const list of FORWARD_LISTS) {
    const previous = prior[list] ?? [], next = current[list] ?? [];
    if (next.length < previous.length) throw new Error("reviewed replacement approval removal must be approved separately");
    for (const [index, entry] of next.entries()) {
      if (previous[index] && previous[index]!.path !== entry.path) throw new Error("reviewed replacement approval positions must be approved separately");
      if (canonical(previous[index]) !== canonical(entry)) changed.push(entry.path);
    }
  }
  return changed;
}

/** `path`'s entry keeps its content. Entries before it keep their order; issued ones also keep content and index. */
export function keepsApprovalOrder(before: readonly { path: string }[], after: readonly { path: string }[], issued: ReadonlySet<string>, path: string): boolean {
  const end = before.findIndex(entry => entry.path === path), last = after.findIndex(entry => entry.path === path);
  const known = new Set(before.map(entry => entry.path)), earlier = before.slice(0, end);
  return end >= 0 && last >= 0 && canonical(after[last]) === canonical(before[end])
    && canonical(after.slice(0, last).flatMap(entry => known.has(entry.path) ? [entry.path] : [])) === canonical(earlier.map(entry => entry.path))
    && earlier.every((entry, index) => !issued.has(entry.path) || canonical(after[index]) === canonical(entry));
}
