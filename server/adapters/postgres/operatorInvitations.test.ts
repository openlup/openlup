import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createPostgresOperatorInvitations } from "./operatorInvitations.js";

const principalId = "10000000-0000-4000-8000-000000000001";
function fixture() {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => ({
    rows: sql.includes("SELECT principal_id, email") ? [{ principal_id: principalId, email: "invitee@example.com" }] : [],
  }));
  const release = vi.fn();
  const end = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })), end };
  const poolFactory = vi.fn(() => pool as unknown as Pool);
  const env = { connectionString: "postgres://operator@example.invalid/application" };
  const store = createPostgresOperatorInvitations(env, { poolFactory });
  return { store, query, release, end, poolFactory, env };
}
describe("direct invitation composition", () => {
  it("uses the injected owner transaction lane and closes its pool", async () => {
    const { store, query, release, end, poolFactory, env } = fixture();
    expect(poolFactory).not.toHaveBeenCalled();
    await expect(store.read(principalId)).resolves.toBeNull();
    expect(poolFactory).toHaveBeenCalledExactlyOnceWith(env);
    expect(query.mock.calls[0][0]).toBe("BEGIN");
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(query.mock.calls.some(([sql]) => sql.includes("SET ROLE"))).toBe(false);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("platform_human_principals"), [principalId]);
    expect(release).toHaveBeenCalledOnce();
    await store.close();
    expect(end).toHaveBeenCalledOnce();
  });
  it("rolls back issuance when the caller lacks active human admin authority", async () => {
    const { store, query, release } = fixture();
    await expect(store.issue({ actorPrincipalId: principalId, targetPrincipalId: principalId,
      email: "invitee@example.com", role: "admin", ttlSeconds: 60 })).rejects.toMatchObject({ identityCode: "HUMAN_ADMIN_REQUIRED" });
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT"))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
});
