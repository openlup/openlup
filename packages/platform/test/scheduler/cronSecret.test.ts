import { afterEach, describe, expect, it, vi } from "vitest";

const crypto = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView) => {
      crypto.calls += 1;
      return actual.timingSafeEqual(left, right);
    },
  };
});

import { cronSecretMatches } from "../../src/scheduler/cronSecret.js";
import { authorizeCron } from "../../src/scheduler/cronGuard.js";
import { verifyCronAuth } from "../../src/scheduler/vercelScheduler.js";
import type { HttpRequest } from "../../src/http/types.js";

afterEach(() => { crypto.calls = 0; });

const request = (authorization?: string | string[], method = "GET") =>
  ({ method, headers: authorization === undefined ? {} : { authorization } }) as unknown as HttpRequest;

describe("constant-time cron secret comparison", () => {
  it("compares equal-length tokens with a constant-time comparison", () => {
    expect(cronSecretMatches("secret-a", "secret-a")).toBe(true);
    expect(cronSecretMatches("secret-b", "secret-a")).toBe(false);
    expect(crypto.calls).toBe(2);
  });

  it("refuses other byte lengths before comparing, including non-ASCII tokens, without throwing", () => {
    expect(cronSecretMatches("secret", "secret-a")).toBe(false);
    expect(cronSecretMatches("secret-ä", "secret-a")).toBe(false);
    expect(cronSecretMatches("sécret-a", "secret-a")).toBe(false);
    expect(cronSecretMatches(null, "secret-a")).toBe(false);
    expect(crypto.calls).toBe(0);
  });

  it("compares a same-byte-length non-ASCII token without throwing", () => {
    // "ä" is two bytes, so "secret-ä" and "secret-ab" have equal byte lengths.
    expect(cronSecretMatches("secret-ä", "secret-ab")).toBe(false);
    expect(crypto.calls).toBe(1);
  });

  it("is the comparison both the guard and the scheduler verifier use", () => {
    const env = { CRON_SECRET: "secret-a" };
    expect(authorizeCron(request("Bearer secret-a"), env)).toBeNull();
    expect(authorizeCron(request("Bearer secret-b"), env)).toEqual({ status: 401, body: { ok: false, error: "unauthorized" } });
    expect(verifyCronAuth(request("Bearer secret-a"), env)).toBe(true);
    expect(verifyCronAuth(request("Bearer secret-b"), env)).toBe(false);
    expect(crypto.calls).toBe(4);
  });

  it("keeps the guard's results for every refusal class", () => {
    const env = { CRON_SECRET: "secret-a" };
    expect(authorizeCron(request("Bearer secret-a", "PUT"), env)).toEqual({ status: 405, body: { ok: false, error: "method_not_allowed" } });
    expect(authorizeCron(request("Bearer secret-a"), { CRON_SECRET: "" })).toEqual({ status: 503, body: { ok: false, error: "cron_secret_required" } });
    expect(authorizeCron(request(["Bearer secret-a", "Bearer other"]), env)).toBeNull();
    expect(authorizeCron(request("bearer   secret-a  "), env)).toBeNull();
    expect(authorizeCron(request("Bearer secret-a"), { CRON_SECRET: " secret-a" })).toEqual({ status: 401, body: { ok: false, error: "unauthorized" } });
    expect(authorizeCron(request("Bearer sécret-a"), env)).toEqual({ status: 401, body: { ok: false, error: "unauthorized" } });
    expect(authorizeCron(request(), env)).toEqual({ status: 401, body: { ok: false, error: "unauthorized" } });
  });
});
