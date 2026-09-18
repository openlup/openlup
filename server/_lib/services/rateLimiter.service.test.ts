import { describe, it, expect } from "vitest";
import { rateLimiter } from "./rateLimiter.service.js";

describe("rateLimiter shim (default in-memory singleton)", () => {
  it("returns a SYNCHRONOUS decision (callers like api/process.ts depend on this)", () => {
    const decision = rateLimiter.check("shim-ip-sync", 0);
    expect(decision).not.toBeInstanceOf(Promise);
    expect(decision).toEqual({ allowed: true, retryAfterSec: 0 });
  });

  it("preserves the original 10-req / 60s window contract", () => {
    const ip = "shim-ip-window";
    for (let i = 0; i < 10; i += 1) {
      expect(rateLimiter.check(ip, i)).toMatchObject({ allowed: true });
    }
    const denied = rateLimiter.check(ip, 10);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBe(60);
  });
});
