// Repository witnesses also exercise the retained-source and legacy read ports.
export { createRetainedCatalogPublicationReads as createPostgresCatalogPublicationReads } from "@openlup/platform/catalog/testing";
export type { RetainedCatalogPublicationReadDependencies as CatalogPublicationReadDependencies,
  VerifiedCatalogReadScope } from "@openlup/platform/catalog/testing";
