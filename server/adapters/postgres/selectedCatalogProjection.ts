// Repository compatibility facade; implementation is packaged with the migration runner.
export { readSelectedCatalogProjection, selectedCatalogProjectionPayload, readSelectedCatalogRowsForQualifiedInstall, selectedCatalogRowsPayloadForQualifiedInstall } from "@openlup/platform/migrations";
export type { CatalogKind, ObjectIdentity, AclTargetClass, AclGrant, DefaultPrivilege, RoleMembership, RoleRecord, ObjectOwnership, ProjectedObject, ValidatedProjection } from "@openlup/platform/migrations";
