import { describe, expect, it, vi } from "vitest";

import type { HttpRequest } from "../../_lib/types/http.js";
import type { ScheduledJob } from "../scheduler/jobRegistry.js";
import { bearerToken, createVercelScheduler, verifyCronAuth } from "./scheduler.js";

function req(authorization?: string): HttpRequest {
  return { headers: { authorization } } as unknown as HttpRequest;
}

const JOBS: ScheduledJob[] = [
  { jobId: "cleanup", schedule: "0 3 * * *", path: "/api/cron/cleanup" },
];

describe("bearerToken", () => {
  it("extracts a Bearer token case-insensitively", () => {
    expect(bearerToken(req("Bearer abc123"))).toBe("abc123");
    expect(bearerToken(req("bearer  spaced "))).toBe("spaced");
  });
  it("returns null when no/!bearer header", () => {
    expect(bearerToken(req(undefined))).toBeNull();
    expect(bearerToken(req("Basic xyz"))).toBeNull();
  });
});

describe("verifyCronAuth (fail-closed)", () => {
  it("returns false when CRON_SECRET is unset (fail-closed)", () => {
    expect(verifyCronAuth(req("Bearer anything"), {})).toBe(false);
  });
  it("returns false when the token does not match", () => {
    expect(verifyCronAuth(req("Bearer wrong"), { CRON_SECRET: "right" })).toBe(false);
  });
  it("returns true only on an exact match", () => {
    expect(verifyCronAuth(req("Bearer right"), { CRON_SECRET: "right" })).toBe(true);
  });
});

describe("createVercelScheduler", () => {
  it("verifyInvocation delegates to verifyCronAuth with the bound env", () => {
    const scheduler = createVercelScheduler({ env: { CRON_SECRET: "s" }, jobs: JOBS });
    expect(scheduler.verifyInvocation(req("Bearer s"))).toBe(true);
    expect(scheduler.verifyInvocation(req("Bearer no"))).toBe(false);
  });

  it("register is a no-op for a declared job (Vercel owns the timer)", () => {
    const scheduler = createVercelScheduler({ env: {}, jobs: JOBS });
    expect(() =>
      scheduler.register({ jobId: "cleanup", schedule: "0 3 * * *", handler: vi.fn() }),
    ).not.toThrow();
  });

  it("register throws for an undeclared job (drift guard)", () => {
    const scheduler = createVercelScheduler({ env: {}, jobs: JOBS });
    expect(() =>
      scheduler.register({ jobId: "ghost", schedule: "* * * * *", handler: vi.fn() }),
    ).toThrow(/not declared/);
  });

  it("exposes the jobs derived from the single source", () => {
    expect(createVercelScheduler({ env: {} }).jobs.length).toBeGreaterThan(0);
  });
});
