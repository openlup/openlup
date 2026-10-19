import { expect, it, vi } from "vitest";
import { postResendEmail, type EmailEgressResolver } from "../../src/communications/resendEmailClient.js";

const provider = { endpoint: "https://mail.example.invalid/emails", httpErrorPrefix: "Synthetic HTTP" };

it("retains transport payload bytes, sink headers/tags, drop and blocked responses and bounded provider diagnostics", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "synthetic:1", ignored: true }) });
  vi.stubGlobal("fetch", fetch);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const input = { apiKey: "synthetic", fromEmail: "sender@example.invalid", to: "recipient@example.invalid", subject: "Synthetic", html: "<p>Synthetic</p>", idempotencyKey: "synthetic:key" };
  const policy = (mode: "production" | "sandbox_sink" | "drop", extra = {}): EmailEgressResolver => (_, intendedRecipient) => ({ mode, intendedRecipient, recipient: mode === "sandbox_sink" ? "sink@example.invalid" : null, reason: "synthetic", ...extra });
  try {
    expect(await postResendEmail(input, policy("sandbox_sink", { apiKeyOverride: "synthetic-sink" }), provider)).toEqual({
      outcome: { ok: true, resendId: "synthetic:1", httpStatus: 200, providerError: null, aborted: false, egressMode: "sandbox_sink", egressReason: "synthetic" }, providerResponse: { id: "synthetic:1" },
    });
    expect(fetch.mock.calls[0]).toEqual(["https://mail.example.invalid/emails", {
      method: "POST", headers: { Authorization: "Bearer synthetic-sink", "Content-Type": "application/json", "Idempotency-Key": "synthetic:key", "X-Original-Recipient": input.to },
      body: '{"from":"sender@example.invalid","to":["sink@example.invalid"],"subject":"Synthetic","html":"<p>Synthetic</p>","tags":[{"name":"openlup_env","value":"non_production"}]}', signal: undefined,
    }]);
    const drop = await postResendEmail(input, policy("drop"), provider);
    expect(drop).toEqual({ outcome: { ok: true, resendId: null, httpStatus: 0, providerError: null, aborted: false, suppressed: "drop", egressMode: "drop", egressReason: "synthetic" }, providerResponse: { suppressed: "drop", egress_reason: "synthetic" } });
    const blocked = await postResendEmail(input, policy("drop", { reason: "production_like_sandbox_missing", blockedReason: "synthetic_block" }), provider);
    expect(blocked.providerResponse).toEqual({ egress_reason: "email_delivery_profile_blocked", deliveryMode: "sandbox" });
    expect(blocked.outcome).toMatchObject({ ok: false, providerError: "synthetic_block", httpStatus: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ error: { message: "Bad recipient person@example.invalid", code: "rate limit" } }) });
    const failure = await postResendEmail(input, policy("production"), provider);
    expect(failure.providerResponse).toEqual({ http_status: 429, provider_error_message: "Bad recipient [email]", provider_error_code: "rate_limit" });
    expect(failure.outcome).toMatchObject({ ok: false, resendId: null, httpStatus: 429, providerError: "Bad recipient [email]", providerErrorCode: "rate_limit", aborted: false });
    expect(JSON.parse(fetch.mock.calls[1]![1].body).tags).toEqual([{ name: "openlup_env", value: "production" }]);
  } finally { consoleError.mockRestore(); vi.unstubAllGlobals(); }
});
