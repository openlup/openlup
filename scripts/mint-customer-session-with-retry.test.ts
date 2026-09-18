import { describe, expect, it } from "vitest";
import {
  isConsumedOrExpiredLinkError,
  isRetryableMintError,
  isThrottleError,
  isTransientFetchError,
  mintCustomerSessionWithRetry,
  type MintSessionData,
} from "./mint-customer-session-with-retry.ts";

const OK_SESSION: MintSessionData = {
  session: { access_token: "access-token" },
  user: { id: "user-123" },
};

const EXPIRED_LINK = { name: "AuthApiError", status: 403, code: "otp_expired", message: "Email link is invalid or has expired" };
const RATE_LIMITED = { name: "AuthApiError", status: 429, code: "over_email_send_rate_limit", message: "email rate limit exceeded" };

function fastOptions(overrides: Partial<Parameters<typeof mintCustomerSessionWithRetry>[1]> = {}) {
  const sleeps: number[] = [];
  return {
    sleeps,
    options: {
      retryDelaysMs: [10, 20, 30],
      throttleDelaysMs: [100, 200, 300],
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      ...overrides,
    },
  };
}

describe("mintCustomerSessionWithRetry", () => {
  it("returns the session on the happy path without sleeping", async () => {
    const { sleeps, options } = fastOptions();
    let generated = 0;
    let verified = 0;

    const result = await mintCustomerSessionWithRetry(
      {
        generateTokenHash: async () => {
          generated += 1;
          return `hash-${generated}`;
        },
        verify: async (tokenHash) => {
          verified += 1;
          expect(tokenHash).toBe("hash-1");
          return { data: OK_SESSION, error: null };
        },
      },
      options,
    );

    expect(result).toEqual({ accessToken: "access-token", userId: "user-123", attempts: 1 });
    expect(generated).toBe(1);
    expect(verified).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("regenerates a FRESH link and retries after a consumed/expired link", async () => {
    const { sleeps, options } = fastOptions();
    const seenHashes: string[] = [];
    let attempt = 0;

    const result = await mintCustomerSessionWithRetry(
      {
        generateTokenHash: async () => {
          attempt += 1;
          return `hash-${attempt}`;
        },
        verify: async (tokenHash) => {
          seenHashes.push(tokenHash);
          if (seenHashes.length === 1) return { data: null as unknown as MintSessionData, error: EXPIRED_LINK };
          return { data: OK_SESSION, error: null };
        },
      },
      options,
    );

    expect(result.attempts).toBe(2);
    // Second verify must use a distinct, freshly generated token — never the consumed one.
    expect(seenHashes).toEqual(["hash-1", "hash-2"]);
    expect(sleeps).toEqual([10]);
  });

  it("backs off on the throttle schedule when GoTrue rate-limits", async () => {
    const { sleeps, options } = fastOptions();
    let attempt = 0;

    const result = await mintCustomerSessionWithRetry(
      {
        generateTokenHash: async () => `hash-${(attempt += 1)}`,
        verify: async () => {
          if (attempt === 1) return { data: null as unknown as MintSessionData, error: RATE_LIMITED };
          return { data: OK_SESSION, error: null };
        },
      },
      options,
    );

    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([100]);
  });

  it("retries when the generate step itself throttles", async () => {
    const { sleeps, options } = fastOptions();
    let attempt = 0;

    const result = await mintCustomerSessionWithRetry(
      {
        generateTokenHash: async () => {
          attempt += 1;
          if (attempt === 1) throw RATE_LIMITED;
          return `hash-${attempt}`;
        },
        verify: async () => ({ data: OK_SESSION, error: null }),
      },
      options,
    );

    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([100]);
  });

  it("gives up after maxAttempts and reports attempts, status, and code", async () => {
    const { sleeps, options } = fastOptions();
    let generated = 0;

    await expect(
      mintCustomerSessionWithRetry(
        {
          generateTokenHash: async () => `hash-${(generated += 1)}`,
          verify: async () => ({ data: null as unknown as MintSessionData, error: EXPIRED_LINK }),
        },
        options,
      ),
    ).rejects.toThrow(/mint failed after 4 attempt\(s\).*status 403, otp_expired/);

    expect(generated).toBe(4); // 1 initial + 3 retries, each a fresh link
    expect(sleeps).toEqual([10, 20, 30]);
  });

  it("does not retry a non-retryable auth error", async () => {
    const { sleeps, options } = fastOptions();
    let generated = 0;

    await expect(
      mintCustomerSessionWithRetry(
        {
          generateTokenHash: async () => `hash-${(generated += 1)}`,
          verify: async () => ({
            data: null as unknown as MintSessionData,
            error: { name: "AuthApiError", status: 400, message: "bad request" },
          }),
        },
        options,
      ),
    ).rejects.toThrow(/mint failed after 1 attempt/);

    expect(generated).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("does not retry a session that comes back empty without an error", async () => {
    const { sleeps, options } = fastOptions();
    let generated = 0;

    await expect(
      mintCustomerSessionWithRetry(
        {
          generateTokenHash: async () => `hash-${(generated += 1)}`,
          verify: async () => ({ data: { session: null, user: null }, error: null }),
        },
        options,
      ),
    ).rejects.toThrow(/did not return a customer session/);

    expect(generated).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe("mint retry classifiers", () => {
  it("classifies the exact 'Email link is invalid or has expired' failure as retryable", () => {
    expect(isConsumedOrExpiredLinkError(EXPIRED_LINK)).toBe(true);
    expect(isConsumedOrExpiredLinkError({ status: 403, message: "Email link is invalid or has expired" })).toBe(true);
    expect(isRetryableMintError(EXPIRED_LINK)).toBe(true);
  });

  it("classifies throttle/rate-limit failures", () => {
    expect(isThrottleError(RATE_LIMITED)).toBe(true);
    expect(isThrottleError({ message: "email_quota exceeded" })).toBe(true);
    expect(isThrottleError({ status: 403, code: "otp_expired" })).toBe(false);
  });

  it("classifies transient fetch/5xx failures", () => {
    expect(isTransientFetchError({ name: "AuthRetryableFetchError", status: 500 })).toBe(true);
    expect(isTransientFetchError({ status: 503 })).toBe(true);
    expect(isTransientFetchError({ status: 400 })).toBe(false);
  });

  it("does not retry a plain non-auth error (e.g. redirect-origin guard)", () => {
    expect(isRetryableMintError(new Error("Generated auth action redirect pointed at production"))).toBe(false);
  });
});
