import { expect, it, vi } from "vitest";
import { createOperatorAdminAuth } from "../../src/identity/operatorAdminAuth.js";
const id = "11111111-1111-4111-8111-111111111111";
function fixture(role: unknown = "admin", membershipState = "active") {
  const authority = { findMembership: vi.fn(async () => ({ principalId: id, email: "admin@example.invalid", role, membershipState })) };
  return { authority, auth: createOperatorAdminAuth({ authority, verifier: { verifyAccessToken: async () => ({ principalId: id, email: null, emailVerified: false, role: "admin" }) } }) };
}
it("derives live authority, ignores forged role claims and never marks a human as machine", async () => {
  const f = fixture("distributor");
  expect(await f.auth.authorize("token")).toEqual({ ok: true, principalId: id, role: "distributor", isMachineActor: false });
  expect(await f.auth.authorize("token", { allowedRoles: ["admin"] })).toMatchObject({ code: "FORBIDDEN" });
  expect(f.authority.findMembership).toHaveBeenCalledWith(id);
});
it.each([null, "owner", "ADMIN", "", {}, undefined])("unknown role fails closed: %j", async role => {
  // Avoid a default parameter for the explicitly undefined case.
  const f = fixture(null); vi.mocked(f.authority.findMembership).mockResolvedValueOnce({ principalId: id, email: "admin@example.invalid", role, membershipState: "active" });
  expect(await f.auth.authorize("token")).toMatchObject({ code: "FORBIDDEN" });
});
it("revocation is checked on the next request", async () => {
  expect(await fixture("admin", "revoked").auth.authorize("token")).toMatchObject({ code: "FORBIDDEN" });
});
it("database failure never falls back to machine or allow", async () => {
  const f = fixture(); f.authority.findMembership.mockRejectedValueOnce(new Error("db failed"));
  await expect(f.auth.authorize("token")).rejects.toThrow("db failed");
});
