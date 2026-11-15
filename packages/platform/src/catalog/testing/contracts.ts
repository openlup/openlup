import type { CatalogPackInput, CatalogProductTypeRef, CatalogQuantity } from "../contracts/index.js";

/** Explicit trusted, synchronous fixtures. Callbacks are not sandboxed. */
export interface CatalogRefusalFixture {
  name: string;
  capability: string;
  expectedCode: string;
  run: () => { code: string };
  assertZeroEffects: () => boolean;
}
export interface CatalogConformanceSubject {
  packs: readonly {
    pack: CatalogPackInput;
    drafts?: readonly unknown[];
    quantities?: readonly { type: CatalogProductTypeRef; value: CatalogQuantity; targetUnit?: string }[];
    refusals?: readonly CatalogRefusalFixture[];
  }[];
  /** Requests whose owner has not landed refuse with required evidence unavailable. */
  requiredChecks?: readonly string[];
  recheck?: string;
}
export interface CatalogConformanceFinding {
  /** Shared owner code, including application-owned validateContent codes. */
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
