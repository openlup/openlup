import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PortableSqlAdvisory {
  id: string;
  introducedIn: string;
  sourceSql: string;
  category: string;
  targetObjects: string[];
  requiresManagedAdaptation: boolean;
  transactionCaveat: string;
  securityDefinerNote: string;
  summary: string;
}

interface PortableSqlAdvisoriesDocument {
  schemaVersion: number;
  advisories: PortableSqlAdvisory[];
}

const sqlDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../sql");

describe("packages/platform/sql/portable-advisories.json", () => {
  it("matches schemaVersion 1, populates all required fields, and references real packaged SQL files", () => {
    const raw = readFileSync(resolve(sqlDir, "portable-advisories.json"), "utf8");
    const doc = JSON.parse(raw) as PortableSqlAdvisoriesDocument;
    const manifest = JSON.parse(readFileSync(resolve(sqlDir, "manifest.json"), "utf8")) as {
      migrations: Array<{ file: string }>;
    };
    const manifestFiles = new Set(manifest.migrations.map((entry) => entry.file));

    expect(doc.schemaVersion).toBe(1);
    expect(Array.isArray(doc.advisories)).toBe(true);
    expect(doc.advisories.length).toBeGreaterThan(0);

    const seenIds = new Set<string>();
    for (const advisory of doc.advisories) {
      expect(typeof advisory.id).toBe("string");
      expect(advisory.id.trim().length).toBeGreaterThan(0);
      expect(seenIds.has(advisory.id)).toBe(false);
      seenIds.add(advisory.id);

      expect(advisory.introducedIn).toMatch(/^\d+\.\d+\.\d+$/u);
      expect(advisory.sourceSql).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/u);
      expect(existsSync(resolve(sqlDir, advisory.sourceSql))).toBe(true);
      expect(manifestFiles.has(advisory.sourceSql)).toBe(true);

      expect(typeof advisory.category).toBe("string");
      expect(advisory.category.trim().length).toBeGreaterThan(0);

      expect(Array.isArray(advisory.targetObjects)).toBe(true);
      expect(advisory.targetObjects.length).toBeGreaterThan(0);
      for (const target of advisory.targetObjects) {
        expect(typeof target).toBe("string");
        expect(target.trim().length).toBeGreaterThan(0);
      }

      expect(advisory.requiresManagedAdaptation).toBe(true);
      expect(typeof advisory.transactionCaveat).toBe("string");
      expect(advisory.transactionCaveat.trim().length).toBeGreaterThan(0);
      expect(typeof advisory.securityDefinerNote).toBe("string");
      expect(advisory.securityDefinerNote.trim().length).toBeGreaterThan(0);
      expect(typeof advisory.summary).toBe("string");
      expect(advisory.summary.trim().length).toBeGreaterThan(0);
    }
  });
});
