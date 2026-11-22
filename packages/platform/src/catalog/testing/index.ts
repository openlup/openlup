/** @experimental Opt-in offline checks; JSON text only; no caller callbacks. */
export { runCatalogExtensionConformance } from "./catalogExtensionConformance.js";
export type { CatalogConformanceSubject, CatalogRefusalFixture, CatalogConformanceFinding, CatalogConformanceReport } from "./contracts.js";

export { publicationWireVectors } from "./publicationWireVectors.js";

/** @experimental Component-only owner evidence and fence witnesses. */
export { buildCatalogOwnerQuote } from "../catalogOwnerQuote.js";
export { withCatalogAdmissionFence } from "../catalogAdmissionFence.js";
