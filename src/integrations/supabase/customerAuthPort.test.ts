import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { supabaseAuth, requestMagicLink } = vi.hoisted(() => ({
  supabaseAuth: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    verifyOtp: vi.fn(),
    signInWithOAuth: vi.fn(),
    linkIdentity: vi.fn(),
    signOut: vi.fn(),
  },
  requestMagicLink: vi.fn(),
}));

vi.mock("./customerClient", () => ({
  getCustomerSupabase: () => ({ auth: supabaseAuth }),
}));
vi.mock("@/domains/customers/customerMagicLinkClient", () => ({
  requestCustomerMagicLink: requestMagicLink,
}));

const { createSupabaseCustomerAuthPort } = await import("./customerAuthPort");

beforeEach(() => {
  for (const fn of Object.values(supabaseAuth)) fn.mockReset();
  requestMagicLink.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("createSupabaseCustomerAuthPort", () => {
  it("maps a Supabase session to the generic AuthSession", async () => {
    supabaseAuth.getSession.mockResolvedValue({
      data: { session: { access_token: "tok", user: { id: "u1", email: "a@b.com" } } },
    });
    const port = createSupabaseCustomerAuthPort();
    expect(await port.getSession()).toEqual({
      accessToken: "tok",
      user: { id: "u1", email: "a@b.com" },
    });
  });

  it("maps a null session to null", async () => {
    supabaseAuth.getSession.mockResolvedValue({ data: { session: null } });
    const port = createSupabaseCustomerAuthPort();
    expect(await port.getSession()).toBeNull();
  });

  it("delegates onAuthStateChange and forwards the mapped session", () => {
    const unsubscribe = vi.fn();
    let captured: ((event: string, session: unknown) => void) | undefined;
    supabaseAuth.onAuthStateChange.mockImplementation((cb: typeof captured) => {
      captured = cb;
      return { data: { subscription: { unsubscribe } } };
    });
    const port = createSupabaseCustomerAuthPort();
    const listener = vi.fn();
    const off = port.onAuthStateChange(listener);

    captured?.("SIGNED_IN", { access_token: "t2", user: { id: "u2", email: null } });
    expect(listener).toHaveBeenCalledWith({ accessToken: "t2", user: { id: "u2", email: null } });

    off();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("forwards refreshed credentials and the following signed-out state", () => {
    let captured: ((event: string, session: unknown) => void) | undefined;
    supabaseAuth.onAuthStateChange.mockImplementation((cb: typeof captured) => {
      captured = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    const listener = vi.fn();
    createSupabaseCustomerAuthPort().onAuthStateChange(listener);

    captured?.("TOKEN_REFRESHED", {
      access_token: "refreshed-token",
      user: { id: "u2", email: "owner@example.test" },
    });
    captured?.("SIGNED_OUT", null);

    expect(listener).toHaveBeenNthCalledWith(1, {
      accessToken: "refreshed-token",
      user: { id: "u2", email: "owner@example.test" },
    });
    expect(listener).toHaveBeenNthCalledWith(2, null);
  });

  it("requests the email scope per provider on OAuth sign-in", async () => {
    supabaseAuth.signInWithOAuth.mockResolvedValue({ error: null });
    const port = createSupabaseCustomerAuthPort();

    await port.signInWithOAuth({ provider: "facebook", redirectTo: "https://x/cb" });
    expect(supabaseAuth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "facebook",
      options: { redirectTo: "https://x/cb", scopes: "email" },
    });

    await port.signInWithOAuth({ provider: "google", redirectTo: "https://x/cb" });
    expect(supabaseAuth.signInWithOAuth).toHaveBeenLastCalledWith({
      provider: "google",
      options: { redirectTo: "https://x/cb", scopes: undefined },
    });
  });

  it("surfaces an OAuth provider error message", async () => {
    supabaseAuth.signInWithOAuth.mockResolvedValue({ error: { message: "popup blocked" } });
    const port = createSupabaseCustomerAuthPort();
    expect(await port.signInWithOAuth({ provider: "google", redirectTo: "r" })).toEqual({
      error: "popup blocked",
    });
  });

  it("delegates magic-link send and reports a typed failure", async () => {
    requestMagicLink.mockResolvedValueOnce(undefined);
    const port = createSupabaseCustomerAuthPort();
    expect(await port.signInWithOtp({ email: "a@b.com", locale: "en" })).toEqual({ error: null });
    expect(requestMagicLink).toHaveBeenCalledWith("a@b.com", "en", { returnTo: null });

    requestMagicLink.mockRejectedValueOnce(new Error("boom"));
    expect(await port.signInWithOtp({ email: "a@b.com", locale: "pl" })).toEqual({
      error: "magic_link_send_failed",
    });
  });

  it("verifies the magic-link OTP fallback code", async () => {
    supabaseAuth.verifyOtp.mockResolvedValue({ error: null });
    const port = createSupabaseCustomerAuthPort();
    expect(await port.verifyOtpCode({ email: "a@b.com", token: "77323522" })).toEqual({
      error: null,
    });
    expect(supabaseAuth.verifyOtp).toHaveBeenCalledWith({
      email: "a@b.com",
      token: "77323522",
      type: "magiclink",
    });

    supabaseAuth.verifyOtp.mockResolvedValue({ error: { message: "Token has expired or is invalid" } });
    expect(await port.verifyOtpCode({ email: "a@b.com", token: "00000000" })).toEqual({
      error: "Token has expired or is invalid",
    });
  });
});
