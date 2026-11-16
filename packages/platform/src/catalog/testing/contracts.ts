import type { CatalogAttributeInput } from "../attributeValidation.js";
import type { CatalogAttributeReferenceResolution } from "../attributeReferencePort.js";
import type { CatalogPackInput, CatalogProductTypeRef, CatalogQuantity, CatalogCombinationChangeV2 } from "../contracts/index.js";

/** Recorded observations, checked for consistency; no refusal code is executed. */
export interface CatalogRefusalFixture {
  name: string;
  capability: string;
  expectedCode: string;
  observedCode: string;
  zeroEffects: boolean;
}
/** JSON fixture data only. Application content validators are unavailable offline. */
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
  }[];
  /** Requests whose owner has not landed refuse with required evidence unavailable. */
  requiredChecks?: readonly string[];
  recheck?: string;
}
export interface CatalogConformanceFinding {
  /** Exact shared owner code; application content validation stays unavailable. */
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
export interface CatalogConformanceReport {
  state: "satisfied" | "violated" | "unavailable";
  exitCode: 0 | 1 | 2;
  boundary: string;
  findings: CatalogConformanceFinding[];
}
