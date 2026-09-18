import { describe, expect, it, vi } from "vitest";

import { createServiceAdminSession, type SignInResult } from "./session.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createServiceAdminSession", () => {
  it("caches the token and signs in only once while it is valid", async () => {
    const signIn = vi.fn(async (): Promise<SignInResult> => ({
      accessToken: "tok-1",
      expiresAtMs: 100_000,
    }));
    const session = createServiceAdminSession({ signIn, now: () => 0 });

    expect(await session.getBearer()).toBe("tok-1");
    expect(await session.getBearer()).toBe("tok-1");
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("is single-flight: concurrent callers share one in-flight sign-in", async () => {
    const gate = deferred<SignInResult>();
    const signIn = vi.fn(() => gate.promise);
    const session = createServiceAdminSession({ signIn, now: () => 0 });

    const a = session.getBearer();
    const b = session.getBearer();
    gate.resolve({ accessToken: "tok-x", expiresAtMs: 10_000 });

    expect(await a).toBe("tok-x");
    expect(await b).toBe("tok-x");
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("re-authenticates once the token is within the skew window of expiry", async () => {
    let clock = 0;
    const signIn = vi
      .fn<() => Promise<SignInResult>>()
      .mockResolvedValueOnce({ accessToken: "tok-1", expiresAtMs: 100_000 })
      .mockResolvedValueOnce({ accessToken: "tok-2", expiresAtMs: 200_000 });
    const session = createServiceAdminSession({ signIn, now: () => clock, skewMs: 30_000 });

    expect(await session.getBearer()).toBe("tok-1");
    clock = 80_000; // within 30s skew of the 100s expiry → must refresh
    expect(await session.getBearer()).toBe("tok-2");
    expect(signIn).toHaveBeenCalledTimes(2);
  });

  it("forceRefresh discards the cached token and re-auths", async () => {
    const signIn = vi
      .fn<() => Promise<SignInResult>>()
      .mockResolvedValueOnce({ accessToken: "tok-1", expiresAtMs: 100_000 })
      .mockResolvedValueOnce({ accessToken: "tok-2", expiresAtMs: 100_000 });
    const session = createServiceAdminSession({ signIn, now: () => 0 });

    expect(await session.getBearer()).toBe("tok-1");
    expect(await session.getBearer({ forceRefresh: true })).toBe("tok-2");
    expect(signIn).toHaveBeenCalledTimes(2);
  });

  it("is FAIL-CLOSED: a failed sign-in propagates and yields no token (no fallback)", async () => {
    const signIn = vi.fn(async (): Promise<SignInResult> => {
      throw new Error("invalid credentials");
    });
    const session = createServiceAdminSession({ signIn, now: () => 0 });

    await expect(session.getBearer()).rejects.toThrow("invalid credentials");
    // A subsequent call retries (no stuck in-flight promise, no cached fallback).
    await expect(session.getBearer()).rejects.toThrow("invalid credentials");
    expect(signIn).toHaveBeenCalledTimes(2);
  });
});
