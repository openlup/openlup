import type { CatalogAttributeInput } from "../attributeValidation.js";
import type { CatalogAttributeReferenceResolution } from "../attributeReferencePort.js";
import type { CatalogPackInput, CatalogProductTypeRef, CatalogQuantity, CatalogCombinationChangeV2 } from "../contracts/index.js";
import type { CatalogSubscriptionPolicyBinding } from "../../subscriptions/index.js";

/** Recorded observations; require owner-refusals to compare with an independent owner result.
 * @experimental
 */
export interface CatalogRefusalFixture {
  name: string;
  capability: string;
  expectedCode: string;
  observedCode: string;
  zeroEffects: boolean;
}
/** Inert JSON fixture data. Trusted projection binds executable evidence separately.
 * @experimental
 */
export interface CatalogConformanceSubject {
  packs: readonly {
    pack: Omit<CatalogPackInput, "types"> & { types: readonly Omit<CatalogPackInput["types"][number], "validateContent">[] };
    drafts?: readonly unknown[];
    quantities?: readonly { type: CatalogProductTypeRef; value: CatalogQuantity; targetUnit?: string }[];
    attributes?: readonly { type: CatalogProductTypeRef; input: CatalogAttributeInput;
      publicationRevision: string; references?: readonly CatalogAttributeReferenceResolution[] }[];
    /** Retained identities are derived from fixture options, never persisted identity bytes. */
    combinations?: readonly { type: CatalogProductTypeRef; input: {
      axes: readonly string[]; typed: boolean; capacity?: number;
      retained: readonly (Omit<CatalogCombinationChangeV2, "optionValues"> & { optionValues: NonNullable<CatalogCombinationChangeV2["optionValues"]> | null })[];
      incoming: readonly CatalogCombinationChangeV2[];
    } }[];
    refusals?: readonly CatalogRefusalFixture[];
    /** Offline selections; profile identities and digests are resolved from the pack. */
    profileChecks?: readonly {
      cadenceDays: number;
      lines: readonly { id: string; type: CatalogProductTypeRef; quantity: number; addon?: boolean;
        demand?: { contentPerUnit: CatalogQuantity; perDay: CatalogQuantity } }[];
    }[];
    /** Declarative policy bindings that the offline owner can execute from JSON. */
    profilePolicies?: readonly (Extract<CatalogSubscriptionPolicyBinding, { kind: "units_per_day" }>
      | Omit<Extract<CatalogSubscriptionPolicyBinding, { kind: "host_policy" }>, "validate">)[];
  }[];
  /** Requests whose owner has not landed refuse with required evidence unavailable. */
  requiredChecks?: readonly string[];
  recheck?: string;
}
/** The trusted registry uses the runtime pack, including its actual content validator.
 * @experimental
 */
export interface CatalogConformanceSource extends Omit<CatalogConformanceSubject, "packs"> {
  packs: readonly (Omit<CatalogConformanceSubject["packs"][number], "pack" | "profilePolicies"> & {
    pack: CatalogPackInput;
    profilePolicies?: readonly CatalogSubscriptionPolicyBinding[];
  })[];
}
/** @experimental */
export interface CatalogConformanceFinding {
  /** Exact shared owner code. */
  code: string;
  severity: "error" | "warning";
  path: string;
  fixture: string;
  observed: string;
  cause: string;
  fix: string;
  recipe: string;
  recheck: string;
  evidence: { declared: string; bound: string; checked: string; unknown: string[] };
}
/** @experimental */
export interface CatalogConformanceReport {
  state: "satisfied" | "violated" | "unavailable";
  exitCode: 0 | 1 | 2;
  boundary: string;
  findings: CatalogConformanceFinding[];
}
