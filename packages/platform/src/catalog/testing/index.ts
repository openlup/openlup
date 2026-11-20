/** @experimental Opt-in offline checks; JSON text only; no caller callbacks. */
export { runCatalogExtensionConformance } from "./catalogExtensionConformance.js";
export type { CatalogConformanceSubject, CatalogRefusalFixture, CatalogConformanceFinding, CatalogConformanceReport } from "./contracts.js";

export { publicationWireVectors } from "./publicationWireVectors.js";

// Retained-source compatibility witnesses use the testing subpath.
export { createRetainedCatalogPublicationReads } from "../catalogPublicationReads.js";
export type { RetainedCatalogPublicationReadDependencies, VerifiedCatalogReadScope } from "../catalogPublicationReads.js";
