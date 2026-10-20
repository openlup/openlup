import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { PublicReferenceApp } from "../../../src/public-reference/App.js";
import { renderRoute } from "../../../src/public-reference/entry-server.js";
import { routes } from "../../../api/bff/[...path].js";
import { BUNDLE_ACTIVATION_FLAG } from "../../../src/domains/bundle/bundleSpec.js";
import { commerceBundleActivationEnabled } from "../../../server/bff/admin/commerce/shared.js";

it("SSR/default-exposure-unchanged", () => {
  const site = JSON.parse(readFileSync("config/site-routes.json", "utf8"));
  expect(site.routes.map((route: { path: string }) => route.path)).toEqual(["/", "/items/field-notes"]);
  expect(site.csrFallback).toEqual({ exactPaths: [], routeFamilies: [] });
  for (const [path, title] of [["/", "Reference collection"], ["/items/field-notes", "Field notes"]]) {
    expect(renderRoute(path)).toContain(title);
    expect(renderRoute(path)).toBe(renderToString(createElement(PublicReferenceApp, { pathname: path })));
  }
  for (const path of ["/catalog", "/builder", "/admin/catalog", "/admin/bundles", "/api/bff/catalog/bundles", "/api/bff/admin/commerce/bundles/list"]) {
    expect(renderRoute(path)).toContain("Public reference not found");
    expect(site.routes.some((route: { path: string }) => route.path === path)).toBe(false);
  }
  expect(routes).toEqual([]);
  expect(BUNDLE_ACTIVATION_FLAG).toBe("COMMERCE_BUNDLE_ACTIVATION_ENABLED");
  vi.stubEnv(BUNDLE_ACTIVATION_FLAG, undefined);
  try { expect(commerceBundleActivationEnabled()).toBe(false); } finally { vi.unstubAllEnvs(); }
  // P5 pages/composer are absent on this stack; their consumer-derived SSR inputs are wired after the slot merge.
});
