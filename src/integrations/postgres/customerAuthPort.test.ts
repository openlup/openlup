/** @vitest-environment jsdom -- a browser storage adapter; the node env only
 * ever had a store because the shared setup fakes one on `globalThis`. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/domains/customers/customerMagicLinkClient", () => ({
  requestCustomerMagicLink: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/bff/client", () => ({ requestBff: vi.fn() }));

import { requestBff } from "@/lib/bff/client";
import { createPostgresCustomerAuthPort } from "./customerAuthPort";

const SESSION = {
  accessToken: "signed-session",
  expiresAt: "2099-01-01T00:00:00.000Z",
  user: { id: "11111111-1111-4111-8111-111111111111", email: "customer@example.invalid" },
};

describe("postgres customer auth port", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(requestBff).mockReset().mockResolvedValue(SESSION as never);
  });

  it("stores the bounded bearer session, emits it and clears it on sign-out", async () => {
    const port = createPostgresCustomerAuthPort();
    const listener = vi.fn();
    port.onAuthStateChange(listener);

    await expect(port.verifyOtpCode({ email: SESSION.user.email, token: "otp" }))
      .resolves.toEqual({ error: null });
    await expect(port.getSession()).resolves.toEqual({
      accessToken: SESSION.accessToken,
      user: SESSION.user,
    });
    expect(listener).toHaveBeenCalledWith({ accessToken: SESSION.accessToken, user: SESSION.user });

    await port.signOut();
    await expect(port.getSession()).resolves.toBeNull();
    expect(listener).toHaveBeenLastCalledWith(null);
  });

  it("drops an expired or malformed stored session", async () => {
    localStorage.setItem("openlup.customer.session.v1", JSON.stringify({
      session: { accessToken: "expired", user: SESSION.user },
      expiresAt: "2000-01-01T00:00:00.000Z",
    }));
    await expect(createPostgresCustomerAuthPort().getSession()).resolves.toBeNull();
    expect(localStorage.getItem("openlup.customer.session.v1")).toBeNull();
  });

  it("refuses unsupported identity flows explicitly", async () => {
    const port = createPostgresCustomerAuthPort();
    await expect(port.signInWithOAuth({ provider: "google", redirectTo: "/" }))
      .resolves.toEqual({ error: "oauth_not_supported" });
    await expect(port.linkIdentity({ provider: "google", redirectTo: "/" }))
      .resolves.toEqual({ error: "identity_linking_not_supported" });
  });
});
