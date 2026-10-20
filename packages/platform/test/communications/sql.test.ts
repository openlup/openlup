import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMUNICATIONS_MIGRATIONS } from "../../src/communications/sql.js";

describe("communications migration projection", () => {
  it("retains every canonical byte, path, digest and runner position", () => {
    const root = new URL("../../../../", import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL("config/platform-migration-manifest.json", root), "utf8"));
    const entries = [manifest.baseline, ...manifest.forward];
    expect(COMMUNICATIONS_MIGRATIONS.map((unit) => unit.position)).toEqual([2, 9, 20, 70]);
    for (const unit of COMMUNICATIONS_MIGRATIONS) {
      const canonical = readFileSync(new URL(unit.catalogPath, root));
      const projected = readFileSync(unit.url);
      expect(projected).toEqual(canonical);
      expect(createHash("sha256").update(projected).digest("hex")).toBe(unit.sha256);
      expect(entries[unit.position]).toEqual({ file: unit.catalogPath, sha256: unit.sha256 });
    }
  });
});

