import { CATALOG_CANONICAL_UNITS, type CatalogCanonicalUnit, type CatalogQuantity } from "./quantities.js";
import { z } from "zod";

/** Outermost package-supported bound for explicitly profiled subscriptions.
 * @experimental
 */
export const CATALOG_SUBSCRIPTION_PROFILE_MAX_CADENCE_DAYS = 120;

/** @experimental */
export interface CatalogSubscriptionProfileRef {
  readonly key: string;
  readonly version: number;
}

/** @experimental */
export interface CatalogSubscriptionPolicyRef extends CatalogSubscriptionProfileRef {
  readonly digest: string;
}

/** @experimental */
export type CatalogSubscriptionDemandScope = { readonly kind: "per_line" }
  | { readonly kind: "pooled"; readonly poolKey: string };

/** @experimental */
export interface CatalogSubscriptionProfileV1 extends CatalogSubscriptionProfileRef {
  readonly allowedCadenceDays: readonly number[];
  readonly quantities: {
    readonly minBaseUnits: number; readonly maxBaseUnits: number;
    readonly maxUnitsPerLine: number; readonly maxBaseLines: number;
  };
  readonly swapGroupKeys: readonly string[];
  readonly addons: {
    readonly allowedTypeRefs: readonly CatalogSubscriptionProfileRef[];
    readonly maxLines: number; readonly maxUnits: number;
  };
  readonly consumption: { readonly kind: "fixed_units" }
    | { readonly kind: "units_per_day"; readonly demandUnit: CatalogCanonicalUnit | "per_line";
        readonly policyRef: CatalogSubscriptionPolicyRef; readonly demandScope: CatalogSubscriptionDemandScope;
        readonly rounding?: "floor" | "ceil" }
    | { readonly kind: "host_policy"; readonly policyRef: CatalogSubscriptionPolicyRef;
        readonly demandScope: CatalogSubscriptionDemandScope };
  readonly prepaid: "unsupported";
}

/** @experimental */
export type CatalogSubscriptionProfileIssue = {
  readonly code: "profile_invalid" | "profile_cadence_exceeds_platform_bound" | "profile_missing"
    | "policy_binding_missing" | "cadence_not_allowed" | "prepaid_unsupported"
    | "profile_line_not_sellable" | "profile_line_quantity_invalid"
    | "profile_base_units_out_of_range" | "profile_base_line_limit_exceeded"
    | "profile_addon_type_not_allowed" | "profile_addon_line_limit_exceeded" | "profile_addon_unit_limit_exceeded"
    | "profile_swap_group_mismatch" | "profile_swap_capacity_mismatch"
    | "demand_unit_mismatch" | "demand_arithmetic_unsafe" | "line_coverage_mismatch"
    | "profile_attachment_invalid" | "profile_cadence_bound_unavailable";
  readonly path: string;
};

const key = z.string().max(120).regex(/^[a-z][a-z0-9.-]*:[a-z][a-z0-9._-]*$/u);
const positive = z.number().int().min(1).max(2147483647);
const nonnegative = z.number().int().min(0).max(2147483647);
const ref = z.strictObject({ key, version: positive });
const policyRef = ref.extend({ digest: z.string().regex(/^[0-9a-f]{64}$/u) });
const demandScope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("per_line") }), z.strictObject({ kind: z.literal("pooled"), poolKey: key }),
]);
const schema = ref.extend({
  allowedCadenceDays: z.array(positive).min(1).max(CATALOG_SUBSCRIPTION_PROFILE_MAX_CADENCE_DAYS),
  quantities: z.strictObject({ minBaseUnits: positive, maxBaseUnits: positive, maxUnitsPerLine: positive, maxBaseLines: positive }),
  swapGroupKeys: z.array(key).max(100),
  addons: z.strictObject({ allowedTypeRefs: z.array(ref).max(100), maxLines: nonnegative, maxUnits: nonnegative }),
  consumption: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("fixed_units") }),
    z.strictObject({ kind: z.literal("units_per_day"), demandUnit: z.enum([...Object.values(CATALOG_CANONICAL_UNITS), "per_line"]),
      policyRef, demandScope, rounding: z.enum(["floor", "ceil"]).optional() }),
    z.strictObject({ kind: z.literal("host_policy"), policyRef, demandScope }),
  ]),
  prepaid: z.literal("unsupported"),
});

function freeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
  return Object.freeze(value);
}

function pointer(path: readonly PropertyKey[]): string {
  return path.map(value => `/${String(value).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

/** Validate the declaration used by both runtime profile binding and offline conformance.
 * @experimental
 */
export function validateCatalogSubscriptionProfile(value: unknown):
  { profile: CatalogSubscriptionProfileV1 } | { issue: CatalogSubscriptionProfileIssue } {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { issue: { code: "profile_invalid", path: pointer(parsed.error.issues[0].path) } };
  const profile = parsed.data;
  if (profile.consumption.kind === "units_per_day" && profile.consumption.rounding === undefined) {
    delete profile.consumption.rounding;
  }
  const { allowedCadenceDays, quantities, swapGroupKeys, addons, consumption } = profile;
  const outside = allowedCadenceDays.findIndex(day => day > CATALOG_SUBSCRIPTION_PROFILE_MAX_CADENCE_DAYS);
  if (outside !== -1) return { issue: { code: "profile_cadence_exceeds_platform_bound", path: `/allowedCadenceDays/${outside}` } };
  const shapeChecks = [
    [new Set(allowedCadenceDays).size === allowedCadenceDays.length, "/allowedCadenceDays"],
    [quantities.minBaseUnits <= quantities.maxBaseUnits, "/quantities/maxBaseUnits"],
    [new Set(swapGroupKeys).size === swapGroupKeys.length, "/swapGroupKeys"],
    [new Set(addons.allowedTypeRefs.map(({ key, version }) => `${key}@${version}`)).size === addons.allowedTypeRefs.length, "/addons/allowedTypeRefs"],
    [consumption.kind !== "units_per_day" || consumption.demandUnit !== "per_line" || consumption.demandScope.kind === "per_line", "/consumption/demandUnit"],
  ] as const;
  const invalid = shapeChecks.find(([valid]) => !valid);
  return invalid ? { issue: { code: "profile_invalid", path: invalid[1] } } : { profile: freeze(profile) };
}

/** Exact, canonical quantities supplied by the composition owner.
 * @experimental
 */
export interface CatalogSubscriptionLineDemand {
  readonly contentPerUnit: CatalogQuantity;
  readonly perDay: CatalogQuantity;
}

/** @experimental */
export interface CatalogSubscriptionCoverage {
  readonly lineIds: readonly string[];
  readonly wholeDays: number;
  readonly exact: boolean;
}


/** Reuse the installed definition and pinned policy resolution for publication and readiness.
 * @experimental
 */
export interface CatalogSubscriptionProfileResolver {
  resolve(ref: CatalogSubscriptionProfileRef): { profile: CatalogSubscriptionProfileV1; digest: string; bound: boolean } | undefined;
}
