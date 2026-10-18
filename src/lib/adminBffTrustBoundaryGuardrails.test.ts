import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createBffDispatcher } from "@openlup/platform/bff";
import type { HttpRequest, HttpResponse } from "@openlup/platform/http";
import { createReferenceBffDispatch } from "../../server/runtime/bffDispatch.js";
import { preflightAdminBffRoute } from "../../server/runtime/auth/adminAuthBinding.js";
import { privacyRoutes } from "../../server/runtime/auth/privacyRoutes.js";
import { operatorRoutes } from "../../server/runtime/auth/operatorRoutes.js";
import { handlePrivacyRequest } from "../../server/runtime/auth/privacyBinding.js";
import { enforceDeploymentRoutePolicy } from "../../server/_lib/publicDeploymentPolicies.js";
import {
  allowedAdminRolesForBffRoute,
  DISTRIBUTOR_ADMIN_BFF_ROUTES,
  MACHINE_ACTOR_WRITE_ROUTES,
  PUBLIC_ADMIN_BFF_ROUTES,
} from "../../server/_lib/admin-domain/auth.js";

vi.mock("@openlup/platform/bff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openlup/platform/bff")>();
  return { ...actual, createBffDispatcher: vi.fn(actual.createBffDispatcher) };
});
vi.mock("../../server/runtime/auth/adminAuthBinding.js", () => ({ preflightAdminBffRoute: vi.fn() }));
vi.mock("../../server/runtime/auth/privacyBinding.js", () => ({ handlePrivacyRequest: vi.fn() }));
vi.mock("../../server/runtime/settlementProfileBootstrap.js", () => ({ bootstrapAmbientSettlementProfile: vi.fn() }));
vi.mock("#deployment-route-policy", async (importOriginal) => ({
  ...await importOriginal<object>(), enforceDeploymentRoutePolicy: vi.fn(),
}));

const dispatcherPreflight = vi.mocked(createBffDispatcher).mock.calls[0][0].preflight;
const repoRoot = process.cwd();

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function walkTsFiles(dir: string): string[] {
  return readdirSync(join(repoRoot, dir)).flatMap((entry) => {
    const absolute = join(repoRoot, dir, entry);
    const path = join(dir, entry);
    if (statSync(absolute).isDirectory()) return walkTsFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

function adminRoutesFromInventory(): string[] {
  // The bounded reference router can be empty; handlers retain their observed route declarations.
  const sources = ["api/bff/[...path].ts", ...walkTsFiles("server/bff/admin")];
  return [...new Set([
    ...sources.flatMap(file => [...read(file).matchAll(/route:\s*["']([^"']+)["']/g)]
      .map(match => match[1]).filter(route => route.startsWith("/api/bff/admin/"))),
    ...DISTRIBUTOR_ADMIN_BFF_ROUTES,
    ...PUBLIC_ADMIN_BFF_ROUTES,
    ...MACHINE_ACTOR_WRITE_ROUTES,
    ...operatorRoutes({ PLATFORM_BUNDLE: "node-postgres" }).map(entry => entry.route),
  ])].sort();
}

describe("admin BFF trust boundary guardrails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(preflightAdminBffRoute).mockReset().mockResolvedValue(true);
    vi.mocked(enforceDeploymentRoutePolicy).mockReturnValue(true);
    vi.stubEnv("PLATFORM_BUNDLE", "node-postgres");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  function requestResponse(route: string) {
    const req = { url: route, method: "POST", headers: {} } as HttpRequest;
    const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
    res.status.mockReturnValue(res);
    return { req, res: res as unknown as HttpResponse };
  }

  it.each([
    { bundle: "node-postgres", label: "direct" },
    { bundle: "", label: "managed default" },
  ])("preflights admin BFF routes before dispatching handlers ($label)", async ({ bundle }) => {
    vi.stubEnv("PLATFORM_BUNDLE", bundle);
    const dispatcher = read("packages/platform/src/bff/dispatch.ts");
    expect(dispatcher.indexOf("options.preflight(req, res, entry.route)")).toBeGreaterThan(-1);
    expect(dispatcher.indexOf("options.preflight(req, res, entry.route)"))
      .toBeLessThan(dispatcher.indexOf("return entry.handler(req, res)"));

    const privacyMounts = privacyRoutes({ PLATFORM_BUNDLE: bundle }).map(entry => entry.route);
    expect(privacyMounts).toEqual([
      "/api/bff/admin/identity/privacy/export",
      "/api/bff/admin/identity/privacy/erase",
    ]);
    const adminRoutes = adminRoutesFromInventory();
    for (const namespace of ["commerce", "fulfillment", "platform"]) {
      expect(adminRoutes.some(route => route.startsWith(`/api/bff/admin/${namespace}/`)), namespace).toBe(true);
    }
    expect(adminRoutes).toEqual(expect.arrayContaining([
      ...DISTRIBUTOR_ADMIN_BFF_ROUTES,
      ...PUBLIC_ADMIN_BFF_ROUTES,
      ...MACHINE_ACTOR_WRITE_ROUTES,
      "/api/bff/admin/platform/settings/update",
      "/api/bff/admin/commerce/orders/note",
    ]));
    const routes = new Set([
      ...adminRoutes,
      ...privacyMounts,
      "/api/bff/admin/identity/other",
      "/api/bff/admin/identity/privacy",
      "/api/bff/admin/identity/export",
      "/api/bff/admin/identity/erase",
      ...privacyMounts.flatMap(route => [route + "/other", route + "-other", route + "/"]),
    ]);
    for (const route of routes) {
      for (const admitted of [false, true]) {
        vi.mocked(preflightAdminBffRoute).mockClear().mockResolvedValue(admitted);
        const { req, res } = requestResponse(route);
        expect(await dispatcherPreflight(req, res, route), route)
          .toBe(privacyMounts.includes(route) || admitted);
        if (privacyMounts.includes(route)) {
          expect(preflightAdminBffRoute, route).not.toHaveBeenCalled();
        } else {
          expect(preflightAdminBffRoute, route).toHaveBeenCalledExactlyOnceWith(req, res, route);
        }
      }
    }
  });

  it.each(["export", "erase"] as const)("privacy %s awaits its own preflight and stops on refusal", async operation => {
    const env = { PLATFORM_BUNDLE: "node-postgres" };
    const entry = privacyRoutes(env).find(entry => entry.route.endsWith("/" + operation))!;
    for (const admitted of [false, true]) {
      vi.clearAllMocks();
      let settle!: (admitted: boolean) => void;
      vi.mocked(preflightAdminBffRoute).mockReturnValueOnce(new Promise<boolean>(resolve => { settle = resolve; }));
      const { req, res } = requestResponse(entry.route);
      const pending = entry.handler(req, res);
      expect(enforceDeploymentRoutePolicy).toHaveBeenCalledExactlyOnceWith({
        route: entry.route, domain: "auth", surface: "admin", risk: "mutation",
      }, req, res);
      expect(preflightAdminBffRoute).toHaveBeenCalledExactlyOnceWith(req, res, entry.route, env);
      expect(vi.mocked(enforceDeploymentRoutePolicy).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(preflightAdminBffRoute).mock.invocationCallOrder[0]);
      expect(handlePrivacyRequest).not.toHaveBeenCalled();
      settle(admitted);
      await pending;
      if (admitted) {
        expect(handlePrivacyRequest).toHaveBeenCalledExactlyOnceWith(operation, req, res, env);
      } else {
        expect(handlePrivacyRequest).not.toHaveBeenCalled();
      }
    }
  });

  it.each(["export", "erase"] as const)("mounted privacy %s refuses at observed mutation policy before preflight", async operation => {
    vi.mocked(enforceDeploymentRoutePolicy).mockReturnValue(false);
    const route = "/api/bff/admin/identity/privacy/" + operation;
    const { req, res } = requestResponse(route);
    const supplied = vi.fn();
    await createReferenceBffDispatch()([{ route, pattern: new RegExp(`^${route}$`), params: [], handler: supplied }], req, res);
    expect(enforceDeploymentRoutePolicy).toHaveBeenCalledExactlyOnceWith({
      route, domain: "auth", surface: "admin", risk: "mutation",
    }, req, res);
    expect(preflightAdminBffRoute).not.toHaveBeenCalled();
    expect(handlePrivacyRequest).not.toHaveBeenCalled();
    expect(supplied).not.toHaveBeenCalled();
  });

  it("keeps every admin BFF route covered by the role-aware route policy", () => {
    for (const route of adminRoutesFromInventory()) {
      if ((PUBLIC_ADMIN_BFF_ROUTES as readonly string[]).includes(route)) {
        expect(allowedAdminRolesForBffRoute(route)).toBeNull();
        continue;
      }
      expect(allowedAdminRolesForBffRoute(route), route).not.toBeNull();
    }
  });

  it("keeps the distributor admin BFF allowlist explicit and narrow", () => {
    expect([...DISTRIBUTOR_ADMIN_BFF_ROUTES].sort()).toEqual([
      "/api/bff/admin/fulfillment/dhl-book-courier",
      "/api/bff/admin/fulfillment/dhl-cleanup",
      "/api/bff/admin/fulfillment/dhl-clear-shipment-state",
      "/api/bff/admin/fulfillment/dhl-create-shipment",
      "/api/bff/admin/fulfillment/dhl-label",
      "/api/bff/admin/fulfillment/dhl-merge-labels",
      "/api/bff/admin/fulfillment/shipments-overview",
      "/api/bff/admin/tester-program/return-to-admin",
      "/api/bff/admin/tester-program/status",
    ].sort());

    for (const route of adminRoutesFromInventory()) {
      const roles = allowedAdminRolesForBffRoute(route);
      if ((PUBLIC_ADMIN_BFF_ROUTES as readonly string[]).includes(route)) continue;
      if ((DISTRIBUTOR_ADMIN_BFF_ROUTES as readonly string[]).includes(route)) {
        expect(roles, route).toEqual(["admin", "distributor"]);
      } else {
        expect(roles, route).toEqual(["admin"]);
      }
    }
  });

  it("blocks local admin_users id-only authorization checks in admin BFF handlers", () => {
    const offenders = walkTsFiles("server/bff/admin").filter((file) => {
      const source = read(file);
      return /\.from\(["']admin_users["']\)[\s\S]*?\.select\(["']id["']\)/.test(source);
    });

    expect(offenders.map((file) => relative(repoRoot, join(repoRoot, file)))).toEqual([]);
  });
});
