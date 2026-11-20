import { beforeEach, expect, it, vi } from "vitest";

const { readFileSync } = vi.hoisted(() => ({ readFileSync: vi.fn() }));
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>(), readFileSync }));

const installation = await import("../../src/catalog/sql.js");
const unit = installation.CATALOG_MIGRATIONS.at(-1)!;
const manifestReadsAtImport = readFileSync.mock.calls.length;
const baseline = { file: "db/platform/migrations/00000000000000_platform_baseline.sql", sha256: "a".repeat(64) };
const published = { file: unit.catalogPath, sha256: unit.sha256 };
const skipped = { file: "db/platform/migrations/20261123180000_example.sql", sha256: "b".repeat(64) };
function manifest(forward: readonly unknown[]) {
  readFileSync.mockReturnValue(JSON.stringify({ schemaVersion: 1, catalog: { schemaVersion: 1, baseline, forward, objectInventorySha256: "c".repeat(64) }, migrations: [] }));
}

beforeEach(() => readFileSync.mockReset());

it("computes the publication position lazily when a forward lands before it", () => {
  expect(manifestReadsAtImport).toBe(0);
  manifest([published]);
  expect(unit.position).toBe(1);
  manifest([skipped, published]);
  expect(unit.position).toBe(2);
  expect(readFileSync.mock.calls.flat().map(String)).toEqual([
    expect.stringMatching(/\/sql\/manifest\.json$/u), "utf8",
    expect.stringMatching(/\/sql\/manifest\.json$/u), "utf8",
  ]);
});

it.each([["missing", [skipped]], ["mismatched hash", [{ ...published, sha256: "0".repeat(64) }]]] as const)(
  "refuses a %s packaged position",
  (_name, entries) => {
    manifest([...entries]);
    expect(() => unit.position).toThrow(unit.catalogPath);
  },
);

it.each([{}, null, { file: skipped.file, sha256: "invalid" }])("refuses malformed prefix metadata before deriving a position (%j)", entry => {
  manifest([entry, published]);
  expect(() => unit.position).toThrow(/platform migration manifest\.forward\[0\]/u);
  expect(readFileSync).toHaveBeenCalledTimes(1);
});
