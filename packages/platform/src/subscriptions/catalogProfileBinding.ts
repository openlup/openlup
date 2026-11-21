import { createHash } from "node:crypto";
import { canonicalCatalogSubscriptionProfileJson, validateCatalogSubscriptionProfile, type CatalogSubscriptionProfileRef,
  type CatalogSubscriptionProfileV1, type InstalledCatalogSubscriptionProfile } from "@openlup/core/catalog";
import { parseCadenceChoiceV1, type CadenceChoiceV1 } from "@openlup/core/subscription";

/** The caller supplies the offers admitted by each owning boundary.
 * @experimental
 */
export interface CatalogProfileCadenceInput {
  readonly choice: CadenceChoiceV1;
  readonly cadenceDays?: number;
  readonly mode: "recurring" | "prepaid";
  readonly storeChoices: readonly CadenceChoiceV1[];
  readonly skuChoices: readonly CadenceChoiceV1[];
  readonly offerChoices: readonly CadenceChoiceV1[];
  readonly commandChoices: readonly CadenceChoiceV1[];
  readonly nativeMaxFixedDays: number | null;
  readonly profileRef?: CatalogSubscriptionProfileRef;
  readonly profile?: { readonly declaration: CatalogSubscriptionProfileV1; readonly installed: InstalledCatalogSubscriptionProfile };
}

/** @experimental */
export type CatalogProfileCadenceResult =
  | { readonly cadenceDays: number }
  | { readonly code: "cadence_kind_unsupported" | "cadence_not_offered" | "cadence_day_projection_mismatch"
    | "profile_missing" | "policy_binding_missing" | "prepaid_unsupported" | "profile_cadence_bound_unavailable" };

/** Verify a day choice before passing its projection to the owning day-based operation.
 * @experimental
 */
export function selectCatalogProfileCadence(input: CatalogProfileCadenceInput): CatalogProfileCadenceResult {
  if (input.choice.kind !== "fixed_days") return { code: "cadence_kind_unsupported" };
  const choice = parseCadenceChoiceV1(input.choice);
  if (!choice || choice.kind !== "fixed_days") return { code: "cadence_not_offered" };
  const { days } = choice;
  if (input.cadenceDays !== undefined && input.cadenceDays !== days) return { code: "cadence_day_projection_mismatch" };
  const { nativeMaxFixedDays, profileRef, profile } = input;
  if (nativeMaxFixedDays === null || !Number.isSafeInteger(nativeMaxFixedDays) || nativeMaxFixedDays < 1) {
    return { code: "profile_cadence_bound_unavailable" };
  }
  const choices = [input.storeChoices, input.skuChoices, input.offerChoices, input.commandChoices];
  if (profileRef || profile) {
    if (!profile || !profileRef || profileRef.key !== profile.declaration.key || profileRef.version !== profile.declaration.version) {
      return { code: "profile_missing" };
    }
    if (input.mode === "prepaid") return { code: "prepaid_unsupported" };
    const declared = validateCatalogSubscriptionProfile(profile.declaration);
    const { installed } = profile;
    if ("issue" in declared || !installed || installed.profileKey !== profileRef.key || installed.profileVersion !== profileRef.version
      || installed.policyDigest !== declared.profile.policyDigest || installed.policyRef?.key !== declared.profile.policyRef.key
      || installed.policyRef.version !== declared.profile.policyRef.version
      || installed.profileDigest !== createHash("sha256").update(canonicalCatalogSubscriptionProfileJson(declared.profile)).digest("hex")) {
      return { code: "policy_binding_missing" };
    }
    if (declared.profile.maxFixedDays !== undefined && days > declared.profile.maxFixedDays) return { code: "cadence_not_offered" };
    choices.push(declared.profile.allowedCadences);
  }
  if (days > nativeMaxFixedDays || !choices.every(list => list.some(option =>
    option.schemaVersion === 1 && option.kind === "fixed_days" && option.days === days))) return { code: "cadence_not_offered" };
  return { cadenceDays: days };
}
