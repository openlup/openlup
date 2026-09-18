import { describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { AdminAuthPort } from "../../domains/auth/ports.js";
import {
  preflightAdminBffRoute,
  resolveAdminAuthBinding,
  type PlatformOperatorChecker,
} from "./adminAuthBinding.js";

const TOKEN = "o".repeat(32);
const OPERATOR_ID = "9f576216-011a-4f67-8404-3f28f7f624d5";
const DIRECT_ENV = {
  PLATFORM_BUNDLE: "node-postgres",
  PLATFORM_OPERATOR_TOKEN: TOKEN,
  PLATFORM_OPERATOR_ID: OPERATOR_ID,
};

function request(token?: string): VercelRequest {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} } as VercelRequest;
}

function response(): { res: VercelResponse; status: ReturnType<typeof vi.fn> } {
  const status = vi.fn();
  const res = { setHeader: vi.fn(), status, json: vi.fn() } as unknown as VercelResponse;
  status.mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return { res, status };
}

function checker(allowed = true): PlatformOperatorChecker {
  return {
    isOperatorAllowed: vi.fn(async () => allowed),
    close: vi.fn(async () => undefined),
  };
}

describe("admin auth binding", () => {
  it("refuses bad direct configuration before constructing a checker", () => {
    const checkerFactory = vi.fn();
    expect(resolveAdminAuthBinding({ PLATFORM_BUNDLE: "node-postgres" }, { checkerFactory }))
      .toEqual({ error: "direct_admin_auth_config_invalid" });
    expect(checkerFactory).not.toHaveBeenCalled();
  });

  it("does not open a checker for a missing or wrong bearer", async () => {
    const checkerFactory = vi.fn(async () => checker());
    const binding = resolveAdminAuthBinding(DIRECT_ENV, { checkerFactory }).binding!;
    await expect(binding.run(null, (auth) => auth.authorize(null))).resolves.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(binding.run("wrong", (auth) => auth.authorize("wrong"))).resolves.toMatchObject({ code: "UNAUTHORIZED" });
    expect(checkerFactory).not.toHaveBeenCalled();
  });

  it("closes the checker after success and allowlist refusal", async () => {
    const allowedChecker = checker();
    const allowedBinding = resolveAdminAuthBinding(DIRECT_ENV, {
      checkerFactory: async () => allowedChecker,
    }).binding!;
    await expect(allowedBinding.run(TOKEN, (auth) => auth.authorize(TOKEN))).resolves.toMatchObject({
      ok: true,
      role: "admin",
      isMachineActor: true,
    });
    expect(allowedChecker.close).toHaveBeenCalledOnce();

    const refusedChecker = checker(false);
    const refusedBinding = resolveAdminAuthBinding(DIRECT_ENV, {
      checkerFactory: async () => refusedChecker,
    }).binding!;
    await expect(refusedBinding.run(TOKEN, (auth) => auth.authorize(TOKEN))).resolves.toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(refusedChecker.close).toHaveBeenCalledOnce();
  });

  it("closes on work failure and propagates a close failure", async () => {
    const throwingWorkChecker = checker();
    const binding = resolveAdminAuthBinding(DIRECT_ENV, {
      checkerFactory: async () => throwingWorkChecker,
    }).binding!;
    await expect(binding.run(TOKEN, async (auth) => {
      await auth.authorize(TOKEN);
      throw new Error("work failed");
    })).rejects.toThrow("work failed");
    expect(throwingWorkChecker.close).toHaveBeenCalledOnce();

    const closeFailure = checker();
    vi.mocked(closeFailure.close).mockRejectedValueOnce(new Error("close failed"));
    const closeFailureBinding = resolveAdminAuthBinding(DIRECT_ENV, {
      checkerFactory: async () => closeFailure,
    }).binding!;
    await expect(closeFailureBinding.run(TOKEN, (auth) => auth.authorize(TOKEN)))
      .rejects.toThrow("close failed");
  });

  it("keeps managed auth on the existing AdminAuthPort behavior", async () => {
    const port: AdminAuthPort = {
      authorize: vi.fn(async () => ({
        ok: true as const,
        principalId: "managed-admin",
        role: "admin" as const,
        isMachineActor: false,
      })),
    };
    const managedAuthFactory = vi.fn(() => port);
    const resolved = resolveAdminAuthBinding({
      PLATFORM_BUNDLE: "vercel-supabase",
      SUPABASE_URL: "https://managed.example",
      VITE_SUPABASE_ANON_KEY: "anon",
    }, { managedAuthFactory });
    await expect(resolved.binding?.run("managed-token", (auth) => auth.authorize("managed-token")))
      .resolves.toMatchObject({ ok: true, isMachineActor: false });
    expect(managedAuthFactory).toHaveBeenCalledWith(
      { url: "https://managed.example", anonKey: "anon" },
      "managed-token",
    );
  });
});

describe("bundle-aware admin preflight", () => {
  const route = "/api/bff/admin/communications/delivery-operations";

  it("returns 503 for bad direct config and never runs a checker", async () => {
    const checkerFactory = vi.fn();
    const { res, status } = response();
    await expect(preflightAdminBffRoute(request(TOKEN), res, route, {
      PLATFORM_BUNDLE: "node-postgres",
    }, { checkerFactory })).resolves.toBe(false);
    expect(status).toHaveBeenCalledWith(503);
    expect(checkerFactory).not.toHaveBeenCalled();
  });

  it("preserves managed missing-env and authorization responses", async () => {
    const missingEnv = response();
    await expect(preflightAdminBffRoute(request(), missingEnv.res, route, {
      PLATFORM_BUNDLE: "vercel-supabase",
    })).resolves.toBe(false);
    expect(missingEnv.status).toHaveBeenCalledWith(500);

    const deniedPort: AdminAuthPort = {
      authorize: vi.fn(async () => ({
        ok: false as const,
        code: "UNAUTHORIZED" as const,
        message: "Admin session required",
      })),
    };
    const denied = response();
    await expect(preflightAdminBffRoute(request(), denied.res, route, {
      PLATFORM_BUNDLE: "vercel-supabase",
      SUPABASE_URL: "https://managed.example",
      VITE_SUPABASE_ANON_KEY: "anon",
    }, { managedAuthFactory: () => deniedPort })).resolves.toBe(false);
    expect(denied.status).toHaveBeenCalledWith(401);
    expect(deniedPort.authorize).toHaveBeenCalledWith(null, { allowedRoles: ["admin"] });
  });

  it("maps missing/wrong bearer to 401 with zero checker and allowlist refusal to 403", async () => {
    const checkerFactory = vi.fn(async () => checker());
    const missing = response();
    await expect(preflightAdminBffRoute(request(), missing.res, route, DIRECT_ENV, { checkerFactory }))
      .resolves.toBe(false);
    expect(missing.status).toHaveBeenCalledWith(401);
    const wrong = response();
    await expect(preflightAdminBffRoute(request("wrong"), wrong.res, route, DIRECT_ENV, { checkerFactory }))
      .resolves.toBe(false);
    expect(wrong.status).toHaveBeenCalledWith(401);
    expect(checkerFactory).not.toHaveBeenCalled();

    const forbidden = response();
    await expect(preflightAdminBffRoute(request(TOKEN), forbidden.res, route, DIRECT_ENV, {
      checkerFactory: async () => checker(false),
    })).resolves.toBe(false);
    expect(forbidden.status).toHaveBeenCalledWith(403);
  });

  it("authorizes a durable machine admin and maps checker errors to 503", async () => {
    const allowed = response();
    await expect(preflightAdminBffRoute(request(TOKEN), allowed.res, route, DIRECT_ENV, {
      checkerFactory: async () => checker(),
    })).resolves.toBe(true);

    const unavailable = response();
    await expect(preflightAdminBffRoute(request(TOKEN), unavailable.res, route, DIRECT_ENV, {
      checkerFactory: async () => { throw new Error("db unavailable"); },
    })).resolves.toBe(false);
    expect(unavailable.status).toHaveBeenCalledWith(503);
  });
});
