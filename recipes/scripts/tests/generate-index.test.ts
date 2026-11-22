import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildRecipeIndex, syncRecipeIndex } from "../generate-index.js";

const RECIPES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT_PATH = path.resolve(RECIPES_ROOT, "scripts", "generate-index.ts");
const tempDirs: string[] = [];

function createTempCatalogCopy(): string {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "openlup-recipes-index-"));
  tempDirs.push(tmpDir);
  cpSync(path.join(RECIPES_ROOT, "schema"), path.join(tmpDir, "schema"), { recursive: true });
  cpSync(path.join(RECIPES_ROOT, "payments", "adyen"), path.join(tmpDir, "payments", "adyen"), {
    recursive: true,
  });
  cpSync(path.join(RECIPES_ROOT, "payments", "mollie"), path.join(tmpDir, "payments", "mollie"), {
    recursive: true,
  });
  cpSync(
    path.join(RECIPES_ROOT, "fulfillment", "shipbob"),
    path.join(tmpDir, "fulfillment", "shipbob"),
    { recursive: true },
  );
  copyFileSync(path.join(RECIPES_ROOT, "index.json"), path.join(tmpDir, "index.json"));
  return tmpDir;
}

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT_PATH, ...args], {
    encoding: "utf8",
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("recipes/scripts/generate-index", () => {
  it("validates all committed recipes and verifies recipes/index.json is deterministically synced", () => {
    const result = syncRecipeIndex({ recipesRoot: RECIPES_ROOT, check: true });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.recipeCount).toBeGreaterThanOrEqual(5);

    const ids = result.document?.recipes.map((r) => r.id) ?? [];
    const sortedIds = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(ids).toEqual(sortedIds);
  });

  it("regenerates index.json deterministically in ASCII id order and detects drift in --check mode", () => {
    const tmpCatalog = createTempCatalogCopy();

    const driftCheck = syncRecipeIndex({ recipesRoot: tmpCatalog, check: true });
    expect(driftCheck.ok).toBe(false);
    expect(driftCheck.changed).toBe(true);
    expect(driftCheck.issues[0]?.manifestPath).toBe("index.json");

    const writeResult = syncRecipeIndex({ recipesRoot: tmpCatalog });
    expect(writeResult.ok).toBe(true);
    expect(writeResult.changed).toBe(true);
    expect(writeResult.recipeCount).toBe(3);
    expect(writeResult.document?.recipes.map((r) => r.id)).toEqual([
      "fulfillment/shipbob",
      "payments/adyen",
      "payments/mollie",
    ]);

    const cleanCheck = syncRecipeIndex({ recipesRoot: tmpCatalog, check: true });
    expect(cleanCheck.ok).toBe(true);
    expect(cleanCheck.changed).toBe(false);

    // Tampering platformVersion in index.json is detected by --check (not self-ratified).
    const tamperedPath = path.join(tmpCatalog, "index.json");
    const tampered = JSON.parse(readFileSync(tamperedPath, "utf8")) as Record<string, unknown>;
    tampered.platformVersion = "9.9.9";
    writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    expect(syncRecipeIndex({ recipesRoot: tmpCatalog, check: true }).ok).toBe(false);
  });

  it("rejects mismatched manifest id, domain, unlisted disk files, and leaves index.json untouched on failure", () => {
    const tmpCatalog = createTempCatalogCopy();
    const indexBefore = readFileSync(path.join(tmpCatalog, "index.json"), "utf8");
    const manifestFile = path.join(tmpCatalog, "payments", "mollie", "recipe.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
    manifest.id = "payments/wrong-id";
    manifest.domain = "shipping";
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    writeFileSync(path.join(tmpCatalog, "payments", "mollie", "stray.txt"), "unlisted", "utf8");

    const result = syncRecipeIndex({ recipesRoot: tmpCatalog });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === "id")).toBe(true);
    expect(result.issues.some((i) => i.field === "domain")).toBe(true);
    expect(
      result.issues.some(
        (i) => i.field === "files.allFiles" && i.message.includes("stray.txt"),
      ),
    ).toBe(true);
    expect(readFileSync(path.join(tmpCatalog, "index.json"), "utf8")).toBe(indexBefore);
  });

  it("enforces allOf/if/then on adapter-component browserSurface and rejects Object.prototype extra keys and bad date-time", () => {
    const tmpCatalog = createTempCatalogCopy();
    const manifestFile = path.join(tmpCatalog, "payments", "adyen", "recipe.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
      browserSurface: Record<string, unknown>;
      liveQualification: Record<string, unknown>;
      [key: string]: unknown;
    };
    delete manifest.browserSurface.entry;
    delete manifest.browserSurface.cspManifest;
    Object.defineProperty(manifest, "constructor", {
      value: "prototype-bypass-attempt",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    manifest.liveQualification.qualifiedAt = "not-a-timestamp";
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const built = buildRecipeIndex(tmpCatalog);
    expect(built.document).toBeUndefined();
    expect(built.issues.some((i) => i.message.includes("browserSurface.entry"))).toBe(true);
    expect(built.issues.some((i) => i.message.includes("browserSurface.cspManifest"))).toBe(true);
    expect(built.issues.some((i) => i.message.includes("$.constructor"))).toBe(true);
    expect(built.issues.some((i) => i.message.includes("RFC 3339"))).toBe(true);
  });

  it("rejects path traversal, non-canonical paths, symlinks, invalid JSON, and egressOrigins typos without ReDoS", () => {
    const tmpCatalog = createTempCatalogCopy();
    const shipbobManifestPath = path.join(tmpCatalog, "fulfillment", "shipbob", "recipe.json");
    const shipbob = JSON.parse(readFileSync(shipbobManifestPath, "utf8")) as {
      egressOrigins: string[];
      files: { serverEntry: string; allFiles: string[] };
    };
    shipbob.files.allFiles.push("../../index.json", "server/../recipe.json");
    shipbob.files.serverEntry = "server/not-in-allfiles.ts";
    shipbob.egressOrigins = [
      "https://sellingpartnerapi-na.amazon.example.com/unexpected/path/suffix",
    ];
    writeFileSync(shipbobManifestPath, `${JSON.stringify(shipbob, null, 2)}\n`, "utf8");
    symlinkSync(
      path.join(tmpCatalog, "index.json"),
      path.join(tmpCatalog, "fulfillment", "shipbob", "escaped-link.json"),
    );

    const mollieManifestPath = path.join(tmpCatalog, "payments", "mollie", "recipe.json");
    writeFileSync(mollieManifestPath, "{invalid-json", "utf8");

    const start = Date.now();
    const built = buildRecipeIndex(tmpCatalog);
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(500);
    expect(built.document).toBeUndefined();
    expect(built.issues.some((i) => i.message.includes("unsafe or non-canonical"))).toBe(true);
    expect(built.issues.some((i) => i.message.includes("symbolic link"))).toBe(true);
    expect(built.issues.some((i) => i.field === "files.serverEntry")).toBe(true);
    expect(built.issues.some((i) => i.message.includes("egressOrigins"))).toBe(true);
    expect(built.issues.some((i) => i.message.includes("invalid JSON"))).toBe(true);
  });

  it("supports CLI --check, --json, --platform-version, and structured error exit codes", () => {
    const okRun = runCli(["--check", "--json", "--recipes-root", RECIPES_ROOT]);
    expect(okRun.status).toBe(0);
    const okPayload = JSON.parse(okRun.stdout) as {
      formatVersion: number;
      ok: boolean;
      recipeCount: number;
    };
    expect(okPayload.formatVersion).toBe(1);
    expect(okPayload.ok).toBe(true);
    expect(okPayload.recipeCount).toBeGreaterThanOrEqual(5);

    const badVer = runCli(["--platform-version", "not-semver", "--json"]);
    expect(badVer.status).toBe(64);
    expect(JSON.parse(badVer.stdout).ok).toBe(false);

    const swallowedFlag = runCli(["--recipes-root", "--check"]);
    expect(swallowedFlag.status).toBe(64);
    expect(swallowedFlag.stderr).toContain("Observed:");

    const missingRoot = runCli(["--recipes-root", path.join(os.tmpdir(), "nonexistent-recipes-xyz"), "--json"]);
    expect(missingRoot.status).toBe(1);
    expect(JSON.parse(missingRoot.stdout).ok).toBe(false);
  });
});
