import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagedEmailTrustPolicy, parseEmailVerifyingProviders } from "../../src/identity/managedEmailTrustPolicy.js";
import { createVerifierResultOnlyEmailTrustPolicy } from "../../src/identity/emailTrustPolicy.js";
const safe = { mailer_autoconfirm: false, external: { email: true } };
const unavailable = { trusted: false, code: "EMAIL_TRUST_SETTINGS_UNAVAILABLE" };
const refused = { trusted: false, code: "EMAIL_TRUST_ENVELOPE_REFUSED" };
function setup(payload: unknown = safe, providers: string[] = []) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json(payload));
  let time = 0;
  const policy = createManagedEmailTrustPolicy({ authBaseUrl: "https://identity.invalid", publicKey: "public-test-key", emailVerifyingProviders: providers, fetch, now: () => time });
  return { policy, fetch, advance: (ms: number) => { time += ms; } };
}
afterEach(() => vi.useRealTimers());
describe("managed email trust", () => {
  it("autoconfirm_refuses_email_association", async () => {
    expect(await setup({ ...safe, mailer_autoconfirm: true }).policy.assess()).toEqual(refused);
  });
  it("enabled_undeclared_provider_refuses", async () => {
    expect(await setup({ ...safe, external: { email: true, opaque: true } }).policy.assess()).toEqual(refused);
  });
  it("declared providers and disabled unknown entries are allowed", async () => {
    expect(await setup({ ...safe, external: { email: true, opaque: true, future: false } }, ["opaque"]).policy.assess()).toEqual({ trusted: true });
    expect(await setup({ ...safe, mailer_autoconfirm: true }, ["opaque"]).policy.assess()).toEqual(refused);
  });
  it.each([null, [], {}, { external: {} }, { ...safe, mailer_autoconfirm: "false" }, { ...safe, external: null }, { ...safe, external: [] }, { ...safe, external: { opaque: "false" } }, { ...safe, external: { "*": true } }])("malformed_settings_fail_closed: %j", async value => {
    expect(await setup(value).policy.assess()).toEqual(unavailable);
  });
  it("settings_failure_is_unavailable_not_trusted", async () => {
    const s = setup();
    s.fetch.mockRejectedValue(new Error("private transport detail"));
    expect(await s.policy.assess()).toEqual(unavailable);
    s.advance(4999); await s.policy.assess(); expect(s.fetch).toHaveBeenCalledTimes(1);
    s.advance(1); expect(await s.policy.assess()).toEqual(unavailable); expect(s.fetch).toHaveBeenCalledTimes(2);
  });
  it("expired_trusted_cache_cannot_survive_failure", async () => {
    const s = setup();
    expect(await s.policy.assess()).toEqual({ trusted: true });
    s.fetch.mockRejectedValue(new Error("offline"));
    s.advance(60000);
    expect(await s.policy.assess()).toEqual(unavailable);
  });
  it("cache_expires_and_coalesces_requests", async () => {
    const s = setup();
    expect(await Promise.all([s.policy.assess(), s.policy.assess(), s.policy.assess()])).toEqual(Array(3).fill({ trusted: true }));
    expect(s.fetch).toHaveBeenCalledTimes(1);
    s.advance(59999); await s.policy.assess(); expect(s.fetch).toHaveBeenCalledTimes(1);
    s.advance(1); await Promise.all([s.policy.assess(), s.policy.assess()]); expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(s.fetch).toHaveBeenCalledWith(new URL("https://identity.invalid/auth/v1/settings"), expect.objectContaining({ headers: { apikey: "public-test-key" }, redirect: "error", signal: expect.any(AbortSignal) }));
  });
  it("unsafe settings have the same 60 second observation window", async () => {
    const s = setup({ ...safe, mailer_autoconfirm: true });
    await s.policy.assess(); s.advance(59999); await s.policy.assess(); expect(s.fetch).toHaveBeenCalledTimes(1);
    s.advance(1); await s.policy.assess(); expect(s.fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["headers", "body"])("deadline covers stalled %s", async phase => {
    vi.useFakeTimers();
    const s = setup();
    if (phase === "headers") s.fetch.mockImplementation(() => new Promise(() => {}));
    else s.fetch.mockResolvedValue(new Response(new ReadableStream({ start() {} })));
    const result = s.policy.assess();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toEqual(unavailable);
    expect((s.fetch.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
  });
  it.each([new Response("{}", { status: 503 }), new Response("not-json"), Response.json({ ...safe, padding: "x".repeat(65536) }), new Response(null)])("refuses non-success, invalid, oversized and missing bodies", async response => {
    const s = setup(); s.fetch.mockResolvedValue(response); expect(await s.policy.assess()).toEqual(unavailable);
  });
  it("aborts a stalled error body before releasing the settings deadline", async () => {
    vi.useFakeTimers();
    const s = setup();
    const cancel = vi.fn();
    s.fetch.mockImplementation(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({ cancel });
      init?.signal?.addEventListener("abort", () => { void body.cancel(); }, { once: true });
      return new Response(body, { status: 503 });
    });
    expect(await s.policy.assess()).toEqual(unavailable);
    expect(cancel).toHaveBeenCalledOnce();
    expect(s.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("configuration validation and explicit verifier-only policy", async () => {
    expect(parseEmailVerifyingProviders(" Opaque,other_id,opaque ")).toEqual(["opaque", "other_id"]);
    expect(parseEmailVerifyingProviders(" ")).toEqual([]);
    for (const value of ["*", "opaque,", "a b", "opaque,,other"]) expect(() => parseEmailVerifyingProviders(value)).toThrow();
    for (const authBaseUrl of ["https://user:secret@identity.invalid", "https://identity.invalid/path", "https://identity.invalid?query", "file:///path"]) {
      expect(() => createManagedEmailTrustPolicy({ authBaseUrl, publicKey: "public" })).toThrow();
    }
    expect(await createVerifierResultOnlyEmailTrustPolicy().assess()).toEqual({ trusted: true });
  });
});
