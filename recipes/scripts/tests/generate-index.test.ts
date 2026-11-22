import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildRecipeIndex, syncRecipeIndex } from "../generate-index.js";

const RECIPES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tempDirs: string[] = [];

function createTempCatalogCopy(): string {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "openlup-recipes-index-"));
  tempDirs.push(tmpDir);
  cpSync(path.join(RECIPES_ROOT, "schema"), path.join(tmpDir, "schema"), { recursive: true });
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
    expect(writeResult.recipeCount).toBe(2);
    expect(writeResult.document?.recipes.map((r) => r.id)).toEqual([
      "fulfillment/shipbob",
      "payments/mollie",
    ]);

    const cleanCheck = syncRecipeIndex({ recipesRoot: tmpCatalog, check: true });
    expect(cleanCheck.ok).toBe(true);
    expect(cleanCheck.changed).toBe(false);

    // Second write is a byte-identical no-op.
    const secondWrite = syncRecipeIndex({ recipesRoot: tmpCatalog });
    expect(secondWrite.ok).toBe(true);
    expect(secondWrite.changed).toBe(false);
  });

  it("rejects mismatched manifest id/domain and unlisted files on disk (negative control)", () => {
    const tmpCatalog = createTempCatalogCopy();
    const manifestFile = path.join(tmpCatalog, "payments", "mollie", "recipe.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
    manifest.id = "payments/wrong-id";
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    writeFileSync(path.join(tmpCatalog, "payments", "mollie", "stray.txt"), "unlisted", "utf8");

    const built = buildRecipeIndex(tmpCatalog);
    expect(built.document).toBeUndefined();
    expect(built.issues.some((i) => i.field === "id")).toBe(true);
    expect(
      built.issues.some(
        (i) => i.field === "files.allFiles" && i.message.includes("stray.txt"),
      ),
    ).toBe(true);
  });

  it("rejects declared files missing from disk and invalid status values (negative control)", () => {
    const tmpCatalog = createTempCatalogCopy();
    const manifestFile = path.join(tmpCatalog, "fulfillment", "shipbob", "recipe.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
      status: string;
      files: { allFiles: string[] };
    };
    manifest.status = "not-a-real-status";
    manifest.files.allFiles.push("server/ghost.ts");
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const built = buildRecipeIndex(tmpCatalog);
    expect(built.document).toBeUndefined();
    expect(built.issues.some((i) => i.field === "schema")).toBe(true);
    expect(
      built.issues.some(
        (i) => i.field === "files.allFiles" && i.message.includes("server/ghost.ts"),
      ),
    ).toBe(true);
  });
});
