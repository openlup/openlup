import { createHash } from "node:crypto";
import { evaluateProfileDemand } from "./profileDemand.js";
import { canonicalizeCatalogQuantity, CATALOG_SUBSCRIPTION_PROFILE_MAX_CADENCE_DAYS, validateCatalogSubscriptionProfile,
  type CatalogAcceptanceV2, type CatalogAcceptedReferenceV2, type CatalogQuantity,
  type CatalogSubscriptionCoverage, type CatalogSubscriptionLineDemand, type CatalogSubscriptionPolicyRef,
  type CatalogSubscriptionProfileIssue, type CatalogSubscriptionProfileRef, type CatalogSubscriptionProfileV1 } from "@openlup/core/catalog";

/** Server selection. The installed profile digest and exact publication reference bind the policy input.
 * @experimental
 */
export interface CatalogProfileLine {
  readonly id: string;
  readonly typeRef: CatalogSubscriptionProfileRef;
  readonly quantity: number;
  readonly addon: boolean;
  readonly sellable: boolean;
  readonly allowedCadenceDays?: readonly number[];
  readonly profileRef?: CatalogSubscriptionProfileRef;
  readonly profileDigest?: string;
  readonly swapGroupKey?: string;
  readonly capacity?: CatalogQuantity;
  readonly demand?: CatalogSubscriptionLineDemand;
  readonly publication?: {
    readonly reference: CatalogAcceptedReferenceV2;
    readonly productId: string;
    readonly documentRevisionId: string;
  };
}

/** @experimental */
export interface CatalogSubscriptionProfileSelection {
  readonly cadenceDays: number;
  readonly lineItems: readonly CatalogProfileLine[];
  readonly storeCadenceDays?: readonly number[];
  readonly commandCadenceDays?: readonly number[];
  readonly installedCadenceBound?: number;
  readonly prepaid?: boolean;
  readonly swap?: { readonly from: CatalogProfileLine; readonly to: string };
}

/** A pinned callback is consulted only for the selected policy version.
 * @experimental
 */
export type CatalogSubscriptionPolicyBinding =
  | { readonly ref: CatalogSubscriptionPolicyRef; readonly kind: "units_per_day";
      readonly coverage: "exact" | "allow_shortfall" | "allow_surplus" }
  | { readonly ref: CatalogSubscriptionPolicyRef; readonly kind: "host_policy";
      readonly validate: (input: CatalogSubscriptionProfileSelection) => CatalogSubscriptionProfileIssue | undefined };

/** Attachment for the exact accepted line roster, beside the strict renewal terms.
 * @experimental
 */
export interface CatalogAttachmentEvidenceV1 {
  readonly schemaVersion: 1;
  readonly productId: string;
  readonly variantId: string;
  readonly publicationHead: CatalogAcceptedReferenceV2["publicationHead"];
  readonly documentRevisionId: string;
  readonly documentDigest: string;
  readonly profileRef: CatalogSubscriptionProfileRef;
  readonly profileDigest: string;
  readonly policyRef?: CatalogSubscriptionPolicyRef;
  readonly swapGroupKey?: string;
  readonly demandUnit?: string;
  readonly demandPerSellableUnit?: CatalogQuantity;
  readonly demandPerDay?: CatalogQuantity;
  readonly demandScope?: "per_line" | "pooled";
  readonly poolKey?: string;
}

/** @experimental */
export type CatalogSubscriptionProfileDecision =
  | { readonly kind: "legacy" }
  | { readonly kind: "refused"; readonly issue: CatalogSubscriptionProfileIssue }
  | { readonly kind: "profiled"; readonly allowedDays: readonly number[];
      readonly coverage: readonly CatalogSubscriptionCoverage[]; readonly proposalDays?: number;
      readonly attachments: readonly CatalogAttachmentEvidenceV1[] };

const identity = ({ key, version }: CatalogSubscriptionProfileRef) => `${key}@${version}`;
const refuse = (code: CatalogSubscriptionProfileIssue["code"], path: string): CatalogSubscriptionProfileDecision =>
  ({ kind: "refused", issue: { code, path } });

function attachment(line: CatalogProfileLine, profile: CatalogSubscriptionProfileV1, digest: string): CatalogAttachmentEvidenceV1 | undefined {
  if (!line.publication) return;
  const { reference, productId, documentRevisionId } = line.publication;
  const consumption = profile.consumption;
  return {
    schemaVersion: 1, productId, variantId: reference.skuId,
    publicationHead: reference.publicationHead, documentRevisionId,
    documentDigest: reference.publicationHead.documentDigest, profileRef: { key: profile.key, version: profile.version }, profileDigest: digest,
    ...(line.swapGroupKey ? { swapGroupKey: line.swapGroupKey } : {}),
    ...(consumption.kind === "fixed_units" ? {} : {
      policyRef: consumption.policyRef, demandScope: consumption.demandScope.kind,
      ...(consumption.demandScope.kind === "pooled" ? { poolKey: consumption.demandScope.poolKey } : {}),
    }),
    ...(line.demand ? { demandUnit: line.demand.perDay.unit, demandPerSellableUnit: line.demand.contentPerUnit, demandPerDay: line.demand.perDay } : {}),
  };
}

function sameCapacity(a: CatalogQuantity | undefined, b: CatalogQuantity | undefined): boolean {
  if (!a || !b) return false;
  try {
    return JSON.stringify(canonicalizeCatalogQuantity(a)) === JSON.stringify(canonicalizeCatalogQuantity(b));
  } catch {
    return false;
  }
}

type InstalledProfile = { profile: CatalogSubscriptionProfileV1; digest: string; policy?: CatalogSubscriptionPolicyBinding };

/** The same owner resolves definitions, prepares accepted evidence and narrows existing lane eligibility.
 * @experimental
 */
export function createCatalogSubscriptionProfileBinding(input: {
  readonly profiles: readonly CatalogSubscriptionProfileV1[];
  readonly policies?: readonly CatalogSubscriptionPolicyBinding[];
}) {
  const policies = new Map<string, CatalogSubscriptionPolicyBinding>();
  for (const policy of input.policies ?? []) {
    const key = identity(policy.ref);
    if (policies.has(key)) throw new Error("policy_binding_missing");
    policies.set(key, { ...policy, ref: Object.freeze({ ...policy.ref }) });
  }
  const profiles = new Map<string, InstalledProfile>();
  for (const definition of input.profiles) {
    const validated = validateCatalogSubscriptionProfile(definition);
    if ("issue" in validated) throw Object.assign(new Error(validated.issue.code), validated);
    const { profile } = validated;
    const key = identity(profile);
    const digest = createHash("sha256").update(JSON.stringify(profile)).digest("hex");
    if (profiles.has(key)) throw new Error("profile_invalid");
    const consumption = profile.consumption;
    const policy = consumption.kind === "fixed_units" ? undefined : policies.get(identity(consumption.policyRef));
    profiles.set(key, { profile, digest,
      ...(policy && consumption.kind === policy.kind && consumption.policyRef.digest === policy.ref.digest ? { policy } : {}) });
  }

  function resolve(ref: CatalogSubscriptionProfileRef) {
    const record = profiles.get(identity(ref));
    if (!record) return undefined;
    return { profile: record.profile, digest: record.digest, bound: record.profile.consumption.kind === "fixed_units" || record.policy !== undefined };
  }

  function check(selection: CatalogSubscriptionProfileSelection): CatalogSubscriptionProfileDecision {
    const { lineItems: lines, cadenceDays, storeCadenceDays, commandCadenceDays, installedCadenceBound, swap } = selection;
    if (!lines.some(line => line.profileRef !== undefined) && swap?.from.profileRef === undefined) return { kind: "legacy" };
    if (selection.prepaid) return refuse("prepaid_unsupported", "/prepaid");
    const selected = new Map<string, InstalledProfile>();
    const attachments: CatalogAttachmentEvidenceV1[] = [];
    const seen = new Set<string>();
    for (const [index, line] of lines.entries()) {
      const path = `/lineItems/${index}`;
      if (seen.has(line.id) || (line.publication && line.publication.reference.skuId !== line.id)) return refuse("profile_attachment_invalid", path);
      seen.add(line.id);
      if (line.profileRef === undefined) continue;
      const record = profiles.get(identity(line.profileRef));
      if (!record) return refuse("profile_missing", `${path}/profileRef`);
      if (record.digest !== line.profileDigest || (record.profile.consumption.kind !== "fixed_units" && !record.policy)) {
        return refuse("policy_binding_missing", path);
      }
      selected.set(line.id, record);
      const value = attachment(line, record.profile, record.digest);
      if (value) attachments.push(value);
    }
    if (attachments.length > 0 && attachments.length !== selected.size) return refuse("profile_attachment_invalid", "/lineItems");
    if (cadenceDays > CATALOG_SUBSCRIPTION_PROFILE_MAX_CADENCE_DAYS) {
      return refuse("profile_cadence_exceeds_platform_bound", "/cadenceDays");
    }

    let allowedDays = Array.from({ length: CATALOG_SUBSCRIPTION_PROFILE_MAX_CADENCE_DAYS }, (_, index) => index + 1);
    for (const days of [storeCadenceDays, commandCadenceDays, ...lines.map(line => line.allowedCadenceDays),
      ...[...selected.values()].map(({ profile }) => profile.allowedCadenceDays)]) {
      if (days) allowedDays = allowedDays.filter(day => days.includes(day));
    }
    if (!allowedDays.includes(cadenceDays)) return refuse("cadence_not_allowed", "/cadenceDays");
    if (installedCadenceBound !== undefined && [...selected.values()].some(({ profile }) =>
      profile.allowedCadenceDays.some(day => day > installedCadenceBound))) {
      return refuse("profile_cadence_bound_unavailable", "/cadenceDays");
    }

    for (const [index, line] of lines.entries()) {
      if (!line.sellable) return refuse("profile_line_not_sellable", `/lineItems/${index}`);
      if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) return refuse("profile_line_quantity_invalid", `/lineItems/${index}/quantity`);
    }
    const base = lines.filter(line => !line.addon);
    const addons = lines.filter(line => line.addon);
    const baseUnits = base.reduce((sum, line) => sum + line.quantity, 0);
    const addonUnits = addons.reduce((sum, line) => sum + line.quantity, 0);
    for (const record of new Set(selected.values())) {
      const profile = record.profile;
      const limits = profile.quantities;
      if (lines.some(line => line.quantity > limits.maxUnitsPerLine)) return refuse("profile_line_quantity_invalid", "/lineItems");
      if (base.length > limits.maxBaseLines) return refuse("profile_base_line_limit_exceeded", "/lineItems");
      if (baseUnits < limits.minBaseUnits || baseUnits > limits.maxBaseUnits) return refuse("profile_base_units_out_of_range", "/lineItems");
      if (addons.length > profile.addons.maxLines) return refuse("profile_addon_line_limit_exceeded", "/lineItems");
      if (addonUnits > profile.addons.maxUnits) return refuse("profile_addon_unit_limit_exceeded", "/lineItems");
      const allowedTypes = new Set(profile.addons.allowedTypeRefs.map(identity));
      if (addons.some(line => !allowedTypes.has(identity(line.typeRef)))) return refuse("profile_addon_type_not_allowed", "/lineItems");
    }

    if (swap) {
      const target = lines.find(line => line.id === swap.to);
      const group = swap.from.swapGroupKey;
      const origin = swap.from.profileRef && resolve(swap.from.profileRef);
      if (!target || target.addon || swap.from.addon || !group || target.swapGroupKey !== group || !origin?.bound
        || origin.digest !== swap.from.profileDigest || !origin.profile.swapGroupKeys.includes(group)
        || !selected.get(target.id)?.profile.swapGroupKeys.includes(group)) return refuse("profile_swap_group_mismatch", "/swap");
      if (target.quantity !== swap.from.quantity || !sameCapacity(target.capacity, swap.from.capacity)) {
        return refuse("profile_swap_capacity_mismatch", "/swap");
      }
    }

    const coverage: CatalogSubscriptionCoverage[] = [];
    const demandLines: Parameters<typeof evaluateProfileDemand>[0][number][] = [];
    const hostPolicies = new Set<CatalogSubscriptionPolicyBinding>();
    for (const [index, line] of lines.entries()) {
      const record = selected.get(line.id);
      const policy = record?.policy;
      if (policy?.kind === "host_policy" && !hostPolicies.has(policy)) {
        const issue = policy.validate(selection);
        if (issue) return { kind: "refused", issue };
        hostPolicies.add(policy);
      }
      const consumption = record?.profile.consumption;
      if (consumption?.kind !== "units_per_day" || policy?.kind !== "units_per_day") continue;
      if (!line.demand || (consumption.demandUnit !== "per_line" && line.demand.perDay.unit !== consumption.demandUnit)) {
        return refuse("demand_unit_mismatch", `/lineItems/${index}/demand`);
      }
      demandLines.push({ id: line.id, quantity: line.quantity, demand: line.demand, scope: consumption.demandScope,
        policy: identity(policy.ref), rule: policy.coverage, rounding: consumption.rounding ?? "floor" });
    }
    if (!demandLines.length) return { kind: "profiled", allowedDays, coverage, attachments };
    const demand = evaluateProfileDemand(demandLines, cadenceDays, allowedDays);
    if ("issue" in demand) return { kind: "refused", issue: demand.issue };
    return { kind: "profiled", allowedDays, attachments, ...demand };
  }

  /** Attach accepted identities only after the shared guard admits the whole selection. */
  function bindAcceptance(selection: CatalogSubscriptionProfileSelection):
    | Exclude<CatalogSubscriptionProfileDecision, { kind: "profiled" }>
    | (Extract<CatalogSubscriptionProfileDecision, { kind: "profiled" }> & { acceptance: CatalogAcceptanceV2 }) {
    const decision = check(selection);
    if (decision.kind === "legacy" && selection.lineItems.some(line => line.publication?.reference.subscriptionProfile)) {
      return { kind: "refused", issue: { code: "profile_attachment_invalid", path: "/lineItems" } };
    }
    if (decision.kind !== "profiled") return decision;
    if (selection.installedCadenceBound === undefined) {
      return { kind: "refused", issue: { code: "profile_cadence_bound_unavailable", path: "/cadenceDays" } };
    }
    const byVariant = new Map(decision.attachments.map(item => [item.variantId, item]));
    const lines: CatalogAcceptedReferenceV2[] = [];
    for (const [index, line] of selection.lineItems.entries()) {
      const reference = line.publication?.reference;
      const accepted = byVariant.get(line.id);
      const profile = reference?.subscriptionProfile;
      if (!reference || identity(reference.typeRef) !== identity(line.typeRef) || (line.profileRef && !accepted) ||
        (profile && (!accepted || identity(profile) !== identity(accepted.profileRef) || profile.digest !== accepted.profileDigest))) {
        return { kind: "refused", issue: { code: "profile_attachment_invalid", path: `/lineItems/${index}` } };
      }
      lines.push(accepted ? { ...reference, subscriptionProfile: {
        ...accepted.profileRef, digest: accepted.profileDigest,
      } } : reference);
    }
    lines.sort((a, b) => a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0);
    return { ...decision, acceptance: { schemaVersion: 2, lines } };
  }

  return { resolve, check, bindAcceptance };
}
