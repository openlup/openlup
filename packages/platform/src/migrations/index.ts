export {
  createPostgresMigrationRunner,
  resolvePostgresMigrationRunnerEnv,
  type PlatformMigrationFile,
  type PlatformMigrationManifest,
  type PlatformMigrationManifestEntry,
  type PlatformMigrationSource,
  type PostgresMigrationRunnerEnv,
  type PostgresMigrationRunnerOptions,
} from "./postgresRunner.js";

export {
  createPlatformPostgresMigrationRunner,
  applyPlatformCheckoutOwnerGrant,
  type PlatformPostgresInstallation,
  type PlatformPostgresMigrationRunnerOptions,
} from "./platformRunner.js";
export {
  ADMIN_FILES, assertQualifiedPostgresSelection, qualifiedPostgresStartupOptions, assertQualifiedPostgresSession,
  qualifiedPostgresCatalogPayload, assertQualifiedAdminPostgresSelection, qualifiedAdminPostgresStartupOptions,
  qualifiedAdminPrefixPhase, expectedQualifiedAdminMemberships, assertQualifiedAdminPostgresSession, qualifiedAdminPostgresCatalogPayload,
  type QualifiedPostgresInstallation, type QualifiedAdminPostgresInstallation, type AdminPrefixPhase, type AdminObservedMembership,
} from "./qualifiedInstall.js";
export {
  readSelectedCatalogProjection, selectedCatalogProjectionPayload, readSelectedCatalogRowsForQualifiedInstall,
  selectedCatalogRowsPayloadForQualifiedInstall, type CatalogKind, type ObjectIdentity, type AclTargetClass, type AclGrant,
  type DefaultPrivilege, type RoleMembership, type RoleRecord, type ObjectOwnership, type ProjectedObject, type ValidatedProjection,
} from "./selectedCatalogProjection.js";
export * from "./rdsControlRoles.js";

export { packagedPlatformMigrationPosition } from "./packagedCatalog.js";
