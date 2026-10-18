import { createVerifierResultOnlyEmailTrustPolicy } from "../../src/identity/emailTrustPolicy.js";
import { describe, expect, it, vi } from "vitest";
import { createReconcileAccountHandler } from "../../src/identity/reconcileAccountHandler.js";
import type { AccountLinkStore } from "../../src/identity/ports.js";
function response() {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res);
  return res;
}
function store(): AccountLinkStore {
  return {
    isReservedPrincipal: vi.fn(async () => false), findAccountByPrincipalId: vi.fn(async () => null),
    findAccountByEmail: vi.fn(async () => null), linkPrincipalToAccount: vi.fn(async () => ({ ok: true, alreadyLinked: false })),
    createAccount: vi.fn(async () => ({ id: "new-account" })),
  };
}
describe("neutral reconcile handler", () => {
  it.each([
    ["NO_VERIFIED_EMAIL", 400], ["RESERVED_PRINCIPAL_REFUSED", 403],
    ["PRINCIPAL_EMAIL_MISMATCH", 409], ["EMAIL_OWNED_BY_OTHER_PRINCIPAL", 409], ["ACCOUNT_LINK_CONFLICT", 409],
  ] as const)("maps %s to %s through the real engine", async (code, status) => {
    const accountStore = store();
    if (code === "RESERVED_PRINCIPAL_REFUSED") accountStore.isReservedPrincipal = async () => true;
    if (code === "PRINCIPAL_EMAIL_MISMATCH") accountStore.findAccountByPrincipalId = async () => ({ id: "account", email: "different@example.invalid", principalId: "principal" });
    if (code === "EMAIL_OWNED_BY_OTHER_PRINCIPAL") accountStore.findAccountByEmail = async () => ({ id: "account", email: "user@example.invalid", principalId: "other" });
    if (code === "ACCOUNT_LINK_CONFLICT") {
      accountStore.findAccountByEmail = async () => ({ id: "account", email: "user@example.invalid", principalId: null });
      accountStore.linkPrincipalToAccount = async () => ({ ok: false, existingPrincipalId: "other" });
    }
    const res = response();
    await createReconcileAccountHandler({ emailTrustPolicy: createVerifierResultOnlyEmailTrustPolicy(), store: accountStore, verifier: { verifyAccessToken: async () => ({ principalId: "principal", email: "user@example.invalid", emailVerified: code !== "NO_VERIFIED_EMAIL" }) } })({ method: "POST", headers: { authorization: "Bearer token" } } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ details: { code } }) }));
    expect(accountStore.createAccount).not.toHaveBeenCalled();
  });
  it("returns only the account result and accepts no personalization hook", async () => {
    const res = response();
    await createReconcileAccountHandler({ emailTrustPolicy: createVerifierResultOnlyEmailTrustPolicy(), store: store(), verifier: { verifyAccessToken: async () => ({ principalId: "principal", email: "user@example.invalid", emailVerified: true }) } })({ method: "POST", headers: { authorization: "Bearer token" } } as never, res as never);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accountId: "new-account", created: true, linked: true } });
  });
});

describe("reconcile_maps_refusal_and_unavailability", () => {
  it.each([["EMAIL_TRUST_ENVELOPE_REFUSED", 403, "FORBIDDEN"], ["EMAIL_TRUST_SETTINGS_UNAVAILABLE", 503, "UPSTREAM_UNAVAILABLE"]] as const)("maps %s", async (code, status, outerCode) => {
    const accountStore = store();
    const res = response();
    await createReconcileAccountHandler({ store: accountStore,
      emailTrustPolicy: { assess: async () => ({ trusted: false, code }) },
      verifier: { verifyAccessToken: async () => ({ principalId: "principal", email: "user@example.invalid", emailVerified: true }) },
    })({ method: "POST", headers: { authorization: "Bearer token" } } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: outerCode, details: { code } }) }));
    expect(accountStore.findAccountByEmail).not.toHaveBeenCalled();
    expect(accountStore.linkPrincipalToAccount).not.toHaveBeenCalled();
    expect(accountStore.createAccount).not.toHaveBeenCalled();
  });
});
