import { describe, expect, it, vi, beforeEach } from "vitest";

const { requestBff } = vi.hoisted(() => ({ requestBff: vi.fn() }));
vi.mock("@/lib/bff/client", () => ({ requestBff }));

import { reconcileCustomerAccount } from "./customerReconcileClient";

describe("reconcileCustomerAccount", () => {
  beforeEach(() => {
    requestBff.mockReset();
    requestBff.mockResolvedValue({ accountId: "acct-1", created: true, linked: true });
  });

  it("POSTs /api/bff/customers/reconcile-account with the bearer token", async () => {
    const result = await reconcileCustomerAccount("access-token-123");

    expect(result).toEqual({ accountId: "acct-1", created: true, linked: true });
    expect(requestBff).toHaveBeenCalledTimes(1);
    const [path, , options] = requestBff.mock.calls[0];
    expect(path).toBe("/api/bff/customers/reconcile-account");
    expect(options.method).toBe("POST");
    expect(options.body).toEqual({});
    const headers = options.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer access-token-123");
  });

  it("propagates the BFF error for the caller to interpret", async () => {
    requestBff.mockRejectedValueOnce(new Error("conflict"));
    await expect(reconcileCustomerAccount("tok")).rejects.toThrow("conflict");
  });
});
