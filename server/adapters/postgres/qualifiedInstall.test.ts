import { describe, expect, it } from "vitest";
import { assertQualifiedAdminPostgresSelection, assertQualifiedPostgresSelection, qualifiedPostgresStartupOptions,
  type QualifiedAdminPostgresInstallation } from "./qualifiedInstall.js";

const selection = {
  generation: "qualified-v2", roleMode: "installer-managed", migrationLogin: "migration_login",
  bootstrapLogin: "cluster_root", runtimeLogin: "runtime_login", restoreLogin: "restore_login",
} as const;

describe("qualified PostgreSQL role input transport", () => {
  it("admits only the explicit RDS serial pair and preserves other extra-field refusals", () => {
    const admin = { ...selection, generation: "qualified-admin" } as const;
    expect(() => assertQualifiedAdminPostgresSelection(admin)).not.toThrow();
    expect(() => assertQualifiedAdminPostgresSelection({ ...admin, target: "rds", layout: "serial-cluster" })).not.toThrow();
    for (const extra of [{ target: "neon", layout: "serial-cluster" }, { target: "rds" },
      { layout: "serial-cluster" }, { target: "rds", layout: "parallel" }, { target: undefined, layout: undefined }]) {
      expect(() => assertQualifiedAdminPostgresSelection({ ...admin, ...extra } as QualifiedAdminPostgresInstallation))
        .toThrow("invalid_selection_keys");
    }
  });
  it("transports only the fixed enum and validated identifiers without credentials or arbitrary options", () => {
    expect(qualifiedPostgresStartupOptions(selection)).toBe("-c openlup.qualified.runtime_login=runtime_login -c openlup.qualified.role_mode=installer-managed -c openlup.qualified.restore_login=restore_login");
    expect(qualifiedPostgresStartupOptions({ ...selection, roleMode: "operator-provisioned", migrationLogin: "cluster_root" })).toContain("role_mode=operator-provisioned");
    const { restoreLogin: _restoreLogin, ...withoutRestore } = selection;
    expect(qualifiedPostgresStartupOptions(withoutRestore)).toBe("-c openlup.qualified.runtime_login=runtime_login -c openlup.qualified.role_mode=installer-managed");
  });

  it("refuses unsafe identifiers, aliases, unsupported modes and additional startup fields", () => {
    for (const runtimeLogin of ["runtime -c session_replication_role=replica", "runtime'", "runtime;SELECT", "a".repeat(64), "ümlaut", "PUBLIC", "service_role", "pg_read_all_data", "migration_login", "cluster_root", "restore_login"]) {
      expect(() => assertQualifiedPostgresSelection({ ...selection, runtimeLogin })).toThrow("refused");
    }
    expect(() => assertQualifiedPostgresSelection({ ...selection, restoreLogin: "runtime_login" })).toThrow("principal_alias_not_permitted");
    expect(() => assertQualifiedPostgresSelection({ ...selection, roleMode: "automatic" } as unknown as typeof selection)).toThrow("invalid_selection");
    expect(() => assertQualifiedPostgresSelection({ ...selection, options: "-c role=cluster_root" } as unknown as typeof selection)).toThrow("invalid_selection");
  });
});
