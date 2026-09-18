import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  allowedAdminRolesForBffRoute,
  DISTRIBUTOR_ADMIN_BFF_ROUTES,
  PUBLIC_ADMIN_BFF_ROUTES,
} from "../../server/_lib/admin-domain/auth.js";

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

function adminRoutesFromBffRouter(): string[] {
  const source = read("api/bff/[...path].ts");
  return [...source.matchAll(/route:\s*"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((route) => route.startsWith("/api/bff/admin/"))
    .sort();
}

describe("admin BFF trust boundary guardrails", () => {
  it("preflights admin BFF routes before dispatching handlers", () => {
    // The dispatch loop (preflight-before-handler) was extracted to server/runtime/bffDispatch.ts
    // in the platform-runtime wave; api/bff/[...path].ts now delegates to it. The guardrail holds —
    // it just lives in the extracted dispatcher.
    const source = read("server/runtime/bffDispatch.ts");

    expect(source).toContain("preflightAdminBffRoute");
    expect(source.indexOf("preflightAdminBffRoute(req, res, entry.route)"))
      .toBeLessThan(source.indexOf("return entry.handler(req, res)"));
  });

  it("keeps every admin BFF route covered by the role-aware route policy", () => {
    for (const route of adminRoutesFromBffRouter()) {
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

    for (const route of adminRoutesFromBffRouter()) {
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
