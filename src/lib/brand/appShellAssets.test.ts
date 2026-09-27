// Both halves of the shell seam must be real files, and the substitution must be
// total. A missing neutral file is a 404 in the published tree; a missing
// override is a 404 on this deployment; a leftover neutral path in the served
// document is the second one wearing the first one's clothes.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { APP_SHELL_ASSET_OVERRIDES, applyAppShellAssetOverrides } from "./appShellAssets.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const STATIC_ROOT = "public";
const isFile = (path: string) =>
  existsSync(join(ROOT, path)) && statSync(join(ROOT, path)).isFile();

describe("app shell asset overrides", () => {
  const entries = Object.entries(APP_SHELL_ASSET_OVERRIDES);

  it("maps neutral shell files this repository ships onto override files it also ships", () => {
    expect(entries.length).toBeGreaterThan(0);
    const missing = entries
      .flatMap(([neutral, override]) => [neutral, override])
      .filter((path) => !isFile(`${STATIC_ROOT}${path}`));
    expect(missing, `shell paths with no tracked file: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps every neutral path under the prefix a published tree contains", () => {
    const stray = entries.map(([neutral]) => neutral).filter((path) => !path.startsWith("/platform/"));
    expect(stray, `neutral shell paths outside /platform/: ${stray.join(", ")}`).toEqual([]);
  });

  it("substitutes without order dependence", () => {
    // A key that appears inside another key or inside any value would make the
    // result depend on iteration order.
    const keys = entries.map(([neutral]) => neutral);
    const values = entries.map(([, override]) => override);
    const entangled = keys.filter((key) =>
      keys.some((other) => other !== key && other.includes(key)) || values.some((value) => value.includes(key)),
    );
    expect(entangled, `shell paths that overlap another entry: ${entangled.join(", ")}`).toEqual([]);
  });

  it("leaves no neutral shell path in the served entry document", () => {
    const served = applyAppShellAssetOverrides(readFileSync(join(ROOT, "index.html"), "utf8"));
    // Comments explain the seam and legitimately name the neutral prefix; only what the browser
    // fetches has to be free of it.
    const fetched = [...served.replace(/<!--[\s\S]*?-->/g, "").matchAll(/\b(?:href|src|content)\s*=\s*"([^"]*)"/g)];
    const leftover = fetched.map(([, value]) => value).filter((value) => value.includes("/platform/"));
    expect(leftover, `neutral shell paths still served: ${leftover.join(", ")}`).toEqual([]);
    for (const [, override] of entries) expect(served).toContain(override);
  });

  it("is inert for a document that names no shell path", () => {
    const untouched = "<html><head><link rel=\"icon\" href=\"/other.svg\"></head></html>";
    expect(applyAppShellAssetOverrides(untouched)).toBe(untouched);
  });
});
