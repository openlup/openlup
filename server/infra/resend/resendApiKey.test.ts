import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveResendApiKey } from "./resendApiKey.js";
import { getResendEmail, postResendEmail, redactResendSensitiveText } from "./resendEmailClient.js";

describe("resolveResendApiKey", () => {
  it("resolves the live key when no provider mode is set", () => {
    expect(resolveResendApiKey({ RESEND_API_KEY: "re_live_123" })).toEqual({
      apiKey: "re_live_123",
      mode: "live",
    });
  });

  it("resolves the sandbox key when RESEND_PROVIDER_MODE=sandbox", () => {
    expect(
      resolveResendApiKey({
        RESEND_PROVIDER_MODE: "sandbox",
        RESEND_SANDBOX_API_KEY: "re_sb_123",
        // A live key may be absent on preview (the guard forbids it).
      }),
    ).toEqual({ apiKey: "re_sb_123", mode: "sandbox" });
  });

  it("ignores the live key in sandbox mode and reports missing when the sandbox key is absent", () => {
    expect(
      resolveResendApiKey({ RESEND_PROVIDER_MODE: "sandbox", RESEND_API_KEY: "re_live_123" }),
    ).toEqual({ apiKey: undefined, mode: "sandbox" });
  });

  it("returns undefined in live mode when no key is present", () => {
    expect(resolveResendApiKey({})).toEqual({ apiKey: undefined, mode: "live" });
  });

  it("treats blank/whitespace keys as missing and trims real keys", () => {
    expect(resolveResendApiKey({ RESEND_API_KEY: "   " }).apiKey).toBeUndefined();
    expect(resolveResendApiKey({ RESEND_API_KEY: "  re_x  " }).apiKey).toBe("re_x");
  });

  it("is case-insensitive and trims the provider mode", () => {
    expect(
      resolveResendApiKey({ RESEND_PROVIDER_MODE: "  SANDBOX ", RESEND_SANDBOX_API_KEY: "re_sb" }).mode,
    ).toBe("sandbox");
  });
});

describe("provider email HTTP client hardening", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const SINK_ENV = {
    COMMS_SANDBOX_SINK_ADDRESS: "sink@example.invalid",
  };

  it("sends sandbox_sink mail with redirect: manual and AbortSignal", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ id: "msg_123" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postResendEmail({
      apiKey: "re_test_key_123",
      fromEmail: "sender@example.invalid",
      to: "recipient@example.invalid",
      subject: "Hello",
      html: "<p>Hello</p>",
      idempotencyKey: "idem-1",
      env: SINK_ENV,
    });

    expect(result.outcome).toMatchObject({
      ok: true,
      resendId: "msg_123",
      httpStatus: 200,
      egressMode: "sandbox_sink",
      egressReason: "public_default_sink",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/emails$/);
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer re_test_key_123",
      "Idempotency-Key": "idem-1",
      "X-Original-Recipient": "recipient@example.invalid",
    });
  });

  it("drops without calling fetch when egress mode is drop", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await postResendEmail({
      apiKey: "re_test_key_123",
      fromEmail: "sender@example.invalid",
      to: "recipient@example.invalid",
      subject: "Hello",
      html: "<p>Hello</p>",
      env: {},
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(result.outcome).toMatchObject({
      ok: true,
      suppressed: "drop",
      egressMode: "drop",
    });
  });

  it("enforces default 15s timeout and redacts tokens/emails on send errors", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = postResendEmail({
      apiKey: "re_test_key_123",
      fromEmail: "sender@example.invalid",
      to: "recipient@example.invalid",
      subject: "Hello",
      html: "<p>Hello</p>",
      env: SINK_ENV,
    });
    await vi.advanceTimersByTimeAsync(15_000);
    const timedOut = await pending;
    expect(timedOut.outcome).toMatchObject({ ok: false, httpStatus: 0, aborted: true });

    vi.useRealTimers();
    fetchMock.mockRejectedValueOnce(new Error("Auth failed Bearer tok_abc key re_live_secret for alice@example.invalid"));
    const failed = await postResendEmail({
      apiKey: "re_test_key_123",
      fromEmail: "sender@example.invalid",
      to: "recipient@example.invalid",
      subject: "Hello",
      html: "<p>Hello</p>",
      env: SINK_ENV,
    });
    expect(failed.outcome.providerError).toBe("Auth failed Bearer [redacted] key [redacted] for [email]");
  });

  it("reads status and recipient with redirect: manual", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      last_event: "delivered",
      to: ["reader@example.invalid"],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getResendEmail({ apiKey: "re_test_key", resendId: "msg/1" });
    expect(result).toEqual({
      ok: true,
      httpStatus: 200,
      lastEvent: "delivered",
      recipientEmail: "reader@example.invalid",
      providerError: null,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/emails\/msg%2F1$/);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "manual",
      headers: { Authorization: "Bearer re_test_key" },
    });
  });

  it("refuses 3xx redirects without reading body", async () => {
    let cancelled = false;
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("redirect")); },
      cancel() { cancelled = true; },
    }), { status: 307, headers: { location: "https://evil.example.invalid" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getResendEmail({ apiKey: "re_test_key", resendId: "msg_1" });
    expect(cancelled).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      httpStatus: 307,
      lastEvent: null,
      recipientEmail: null,
    });
    expect(result.providerError).toMatch(/HTTP 307$/);
  });

  it("enforces default 15s timeout across fetch and stalled response body, and honors caller signal", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetchMock);

    const pendingFetch = getResendEmail({ apiKey: "re_test_key", resendId: "msg_1" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pendingFetch).toMatchObject({ ok: false, httpStatus: 0 });

    let cancelled = false;
    fetchMock.mockImplementationOnce(async () => new Response(new ReadableStream({
      start() {},
      cancel() { cancelled = true; },
    }), { status: 200 }));
    const pendingBody = getResendEmail({ apiKey: "re_test_key", resendId: "msg_2" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pendingBody).toMatchObject({ ok: false, httpStatus: 0 });
    expect(cancelled).toBe(true);

    const caller = new AbortController();
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("caller-aborted", "AbortError")));
    }));
    const pendingCaller = getResendEmail({ apiKey: "re_test_key", resendId: "msg_3", signal: caller.signal });
    caller.abort(new DOMException("caller-aborted", "AbortError"));
    expect(await pendingCaller).toMatchObject({ ok: false, httpStatus: 0, providerError: "caller-aborted" });
  });

  it("enforces 256 KiB response body cap on Content-Length and streaming reads", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(256 * 1024 + 1) },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const declared = await getResendEmail({ apiKey: "re_test_key", resendId: "msg_1" });
    expect(declared.ok).toBe(false);
    expect(declared.providerError).toContain("exceeded");

    let cancelled = false;
    fetchMock.mockImplementationOnce(async () => new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() { cancelled = true; },
    }), { status: 200 }));
    const streamed = await getResendEmail({ apiKey: "re_test_key", resendId: "msg_2" });
    expect(cancelled).toBe(true);
    expect(streamed.ok).toBe(false);
    expect(streamed.providerError).toContain("exceeded");
  });

  it("redacts emails, bearer tokens, and provider keys in HTTP errors, catch errors, and text helper", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      message: "Bad Bearer tok_123 re_live_secret_456 for user@example.invalid",
    }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const httpErr = await getResendEmail({ apiKey: "re_test_key", resendId: "msg_1" });
    expect(httpErr.providerError).toBe("Bad Bearer [redacted] [redacted] for [email]");

    fetchMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED Bearer tok_999 re_prod_999 for victim@example.invalid"));
    const catchErr = await getResendEmail({ apiKey: "re_test_key", resendId: "msg_2" });
    expect(catchErr.providerError).toBe("connect ECONNREFUSED Bearer [redacted] [redacted] for [email]");
    expect(catchErr.providerError).not.toContain("victim@example.invalid");
    expect(catchErr.providerError).not.toContain("tok_999");
    expect(catchErr.providerError).not.toContain("re_prod_999");

    expect(
      redactResendSensitiveText("Bearer abc.def re_123_xyz whsec_YWJj test@example.invalid"),
    ).toBe("Bearer [redacted] [redacted] [redacted] [email]");
  });
});
