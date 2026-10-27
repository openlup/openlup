import { describe, expect, it, vi } from "vitest";
import { inspectLegacyPostgresInstallRoles } from "../../src/lifecycle/postgresInstallQualification.js";

const request = { migrationLogin: "installer", runtimeLogin: "installer", roleMode: "installer-managed" } as const;
const role = { name: "installer", login: true, superuser: true, inherit: false, createRole: false,
  createDatabase: false, replication: false, bypassRls: false };
const observation = () => ({ database: "synthetic", currentUser: "installer", sessionUser: "installer", roles: [role], memberships: [] });

describe("legacy fresh-bootstrap role observation", () => {
  it("uses one fixed SELECT with bound role names, even for SQL-looking input", async () => {
    const query = vi.fn(async () => ({ rows: [observation()] }));
    const name = "untrusted'; DROP SCHEMA public; --";
    const report = await inspectLegacyPostgresInstallRoles({ query }, { ...request, runtimeLogin: name });
    expect(query).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[][]];
    expect(sql.startsWith("SELECT ")).toBe(true);
    expect(sql).not.toContain(name);
    expect(values[0]).toContain(name);
    expect(report.scope).toBe("legacy-fresh-bootstrap-role-prerequisites");
    expect(report.blockers).toContainEqual({ code: "legacy_bootstrap_requires_shared_runtime_login" });
  });

  it("redacts driver diagnostics, including their cause", async () => {
    const query = async () => { throw new Error("postgres://user:sensitive@example.invalid/db"); };
    await expect(inspectLegacyPostgresInstallRoles({ query }, request)).rejects.toEqual(new Error("postgres_install_observation_failed"));
  });

  it("refuses malformed observations and invalid requests without claiming readiness", async () => {
    await expect(inspectLegacyPostgresInstallRoles({ query: async () => ({ rows: [{ ...observation(), roles: [{ ...role, superuser: "true" }] }] }) }, request))
      .rejects.toThrow("postgres_install_observation_invalid");
    const query = vi.fn();
    await expect(inspectLegacyPostgresInstallRoles({ query }, { ...request, migrationLogin: " " }))
      .rejects.toThrow("postgres_install_request_invalid");
    expect(query).not.toHaveBeenCalled();
  });
});
