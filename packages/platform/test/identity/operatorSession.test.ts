import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createOperatorSessionService } from "../../src/identity/operatorSession.js";
import { createCapturedCustomerChallengeDelivery } from "../../src/identity/customerSessionBinding.js";
import type { OperatorIdentityStore } from "../../src/identity/operatorPorts.js";
const token = "a".repeat(43);
const identity = { principalId: "11111111-1111-4111-8111-111111111111", email: "admin@example.invalid" };
function fixture() {
  const store: OperatorIdentityStore = { issue: vi.fn(async () => ({ deliverable: true as const, email: identity.email, expiresAt: "2026-10-18T12:10:00Z" })), redeem: vi.fn(async () => identity), findMembership: vi.fn(), bootstrapFirstAdministrator: vi.fn(), pruneChallenges: vi.fn(), close: vi.fn() };
  const delivery = { deliver: vi.fn(async () => {}) };
  const issuer = { issue: vi.fn(async () => ({ accessToken: "signed", expiresAt: "2026-10-18T12:15:00Z" })) };
  const deliveryFailed = vi.fn();
  return { store, delivery, issuer, deliveryFailed, sessions: createOperatorSessionService({ store, delivery, issuer, deliveryFailed, generateToken: () => token }) };
}
it("stores only the normalized email and hash; delivers only after issuance commits", async () => {
  const f = fixture(); await f.sessions.requestChallenge(" ADMIN@EXAMPLE.INVALID ");
  expect(f.store.issue).toHaveBeenCalledWith({ email: identity.email, tokenHash: createHash("sha256").update(token).digest("hex") });
  expect(f.delivery.deliver).toHaveBeenCalledWith({ email: identity.email, token, expiresAt: "2026-10-18T12:10:00Z" });
  expect(vi.mocked(f.store.issue).mock.invocationCallOrder[0]).toBeLessThan(f.delivery.deliver.mock.invocationCallOrder[0]);
});
it("unknown, revoked and limited requests have the same public result; delivery failure discloses nothing", async () => {
  const f = fixture();
  vi.mocked(f.store.issue).mockResolvedValueOnce({ deliverable: false });
  await expect(f.sessions.requestChallenge(identity.email)).resolves.toBeUndefined();
  expect(f.delivery.deliver).not.toHaveBeenCalled();
  f.delivery.deliver.mockRejectedValueOnce(new Error("secret upstream detail"));
  await expect(f.sessions.requestChallenge(identity.email)).resolves.toBeUndefined();
  expect(f.deliveryFailed).toHaveBeenCalledExactlyOnceWith("operator_challenge_delivery_failed");
});
it("default delivery discards without logging secrets", async () => {
  const log = vi.spyOn(console, "info"); const warn = vi.spyOn(console, "warn");
  await createCapturedCustomerChallengeDelivery().deliver({ email: identity.email, token, expiresAt: "2026-10-18T12:10:00Z" });
  expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); vi.restoreAllMocks();
});
it("failed signing follows committed redemption and never compensates by deleting or linking identities", async () => {
  const f = fixture(); f.issuer.issue.mockRejectedValueOnce(new Error("sign failed"));
  await expect(f.sessions.verifyChallenge(token)).rejects.toThrow("sign failed");
  expect(f.store.redeem).toHaveBeenCalledExactlyOnceWith({ tokenHash: createHash("sha256").update(token).digest("hex") });
  expect(vi.mocked(f.store.redeem).mock.invocationCallOrder[0]).toBeLessThan(f.issuer.issue.mock.invocationCallOrder[0]);
  expect(f.store.issue).not.toHaveBeenCalled(); expect(f.store.bootstrapFirstAdministrator).not.toHaveBeenCalled();
});
it("invalid or refused challenges never reach signing", async () => {
  const f = fixture(); expect(await f.sessions.verifyChallenge("bad")).toBeNull(); expect(f.store.redeem).not.toHaveBeenCalled();
  vi.mocked(f.store.redeem).mockResolvedValueOnce(null); expect(await f.sessions.verifyChallenge(token)).toBeNull(); expect(f.issuer.issue).not.toHaveBeenCalled();
});
