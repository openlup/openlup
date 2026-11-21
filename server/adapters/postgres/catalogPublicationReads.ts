// Repository witnesses also exercise the retained-source and legacy read ports.
export { createRetainedCatalogPublicationReads as createPostgresCatalogPublicationReads } from "../../../packages/platform/src/catalog/catalogPublicationReads.js";
export type { RetainedCatalogPublicationReadDependencies as CatalogPublicationReadDependencies,
  VerifiedCatalogReadScope } from "../../../packages/platform/src/catalog/catalogPublicationReads.js";
