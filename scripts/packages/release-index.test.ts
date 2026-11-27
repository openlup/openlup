import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RELEASE_INDEX_MAX_RELEASES,
  RELEASE_INDEX_PATH,
  buildReleaseIndexEntry,
  deriveReleaseIndexEntry,
  formatReleaseIndex,
  parseReleaseIndex,
  updateReleaseIndex,
  type ReleaseIndexEntry,
} from "./release-index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function gitFixture() {
  const root = mkdtempSync(join(tmpdir(), "release-index-"));
  roots.push(root);
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  const commit = (message: string) => {
    git("add", ".");
    git("commit", "-qm", message);
  };

  write("packages/core/package.json", JSON.stringify({ name: "@openlup/core", version: "1.4.0" }));
  write("packages/core/release-gates.json", JSON.stringify({
    packageSurface: { "./pricing": { snapshot: "api/pricing.api.md" } },
  }));
  write("packages/core/api/pricing.api.md", [
    "## dist/pricing/index.d.ts",
    "",
    "```ts",
    'export { calcPrice } from "./calc.js";',
    "export declare function legacyHelper(): void;",
    "```",
    "",
  ].join("\n"));
  write("packages/platform/settings-catalog.json", JSON.stringify({
    schemaVersion: 1,
    entries: [
      { key: "keep.unchanged", value: 1 },
      { key: "update.me", value: 1 },
      { key: "remove.me", value: 1 },
    ],
  }));
  git("init", "-q");
  commit("base 1.4.0");
  git("tag", "openlup-core-v1.4.0");
  return { root, write, git, commit };
}

describe("release-index", () => {
  it("derives subpaths, symbols, deprecations, SQL migrations, settings delta, and starter counts from git and fragments", () => {
    const f = gitFixture();
    f.write("packages/core/release-gates.json", JSON.stringify({
      packageSurface: {
        "./pricing": { snapshot: "api/pricing.api.md" },
        "./analytics": { snapshot: "api/analytics.api.md" },
      },
    }));
    f.write("packages/core/api/pricing.api.md", [
      "## dist/pricing/index.d.ts",
      "",
      "```ts",
      'export { calcPrice, calcTax } from "./calc.js";',
      "/** @deprecated Use modernHelper instead. */",
      "export declare function legacyHelper(): void;",
      "```",
      "",
    ].join("\n"));
    f.write("packages/core/api/analytics.api.md", [
      "## dist/analytics/index.d.ts",
      "",
      "```ts",
      "export declare const trackEvent: () => void;",
      "```",
      "",
    ].join("\n"));
    f.write("db/platform/migrations/20990101000000_new_table.sql", "SELECT 1;\n");
    f.write("packages/outbox/sql/0003_outbox_extra.sql", "SELECT 2;\n");
    f.write("packages/platform/settings-catalog.json", JSON.stringify({
      schemaVersion: 1,
      entries: [
        { key: "keep.unchanged", value: 1 },
        { key: "update.me", value: 2 },
        { key: "add.me", value: 3 },
      ],
    }));
    f.commit("changes for 1.5.0");

    const entry = deriveReleaseIndexEntry({
      root: f.root,
      version: "1.5.0",
      previousVersion: "1.4.0",
      since: "openlup-core-v1.4.0",
      fragments: [
        { path: "packages/core/changes/add-analytics.md", contents: "---\nkind: feature\n---\n\n- Add analytics subpath.\n" },
        { path: "packages/core/changes/starter-checkout.md", contents: "- Starter checkout update.\n" },
        { path: "packages/platform/changes/custom.md", contents: "---\naudience: starter\n---\n\n- Another starter note.\n" },
      ],
    });

    expect(entry).toEqual({
      version: "1.5.0",
      previousVersion: "1.4.0",
      actionRequired: true,
      subpathsAdded: ["@openlup/core/analytics"],
      symbolsAdded: ["calcTax", "trackEvent"],
      symbolsDeprecated: ["legacyHelper"],
      sqlAdded: [
        "db/platform/migrations/20990101000000_new_table.sql",
        "packages/outbox/sql/0003_outbox_extra.sql",
      ],
      settingsDelta: {
        added: ["add.me"],
        removed: ["remove.me"],
        changed: ["update.me"],
      },
      starterEntriesCount: 2,
    });
  });

  it("sets actionRequired false for pure additive feature/deprecation releases without SQL or removals", () => {
    const entry = buildReleaseIndexEntry({
      version: "1.5.0",
      previousVersion: "1.4.0",
      fragments: [
        { path: "packages/core/changes/feat.md", contents: "---\nkind: feature\n---\n- Feature.\n" },
        { path: "packages/core/changes/dep.md", contents: "---\nkind: deprecation\n---\n- Deprecation.\n" },
      ],
      apiSummary: {
        subpathsAdded: [],
        subpathsRemoved: [],
        symbolsAdded: ["newHelper"],
        symbolsRemoved: [],
        symbolsDeprecated: ["oldHelper"],
      },
      sqlAdded: [],
      settingsDelta: { added: [], removed: [], changed: [] },
    });
    expect(entry.actionRequired).toBe(false);
    expect(entry.starterEntriesCount).toBe(0);
  });

  it("caps stored releases to the last 10 entries, replaces duplicate versions, and round-trips JSON", () => {
    const makeEntry = (minor: number): ReleaseIndexEntry => ({
      version: `1.${minor}.0`,
      previousVersion: minor > 0 ? `1.${minor - 1}.0` : null,
      actionRequired: false,
      subpathsAdded: [],
      symbolsAdded: [],
      symbolsDeprecated: [],
      sqlAdded: [],
      settingsDelta: { added: [], removed: [], changed: [] },
      starterEntriesCount: 0,
    });

    let index = updateReleaseIndex(undefined, makeEntry(0));
    for (let minor = 1; minor <= 12; minor++) {
      index = updateReleaseIndex(index, makeEntry(minor));
    }
    expect(index.currentVersion).toBe("1.12.0");
    expect(index.releases).toHaveLength(RELEASE_INDEX_MAX_RELEASES);
    expect(index.releases.map((row) => row.version)).toEqual([
      "1.12.0", "1.11.0", "1.10.0", "1.9.0", "1.8.0", "1.7.0", "1.6.0", "1.5.0", "1.4.0", "1.3.0",
    ]);

    const updatedSame = updateReleaseIndex(index, { ...makeEntry(12), actionRequired: true });
    expect(updatedSame.releases).toHaveLength(RELEASE_INDEX_MAX_RELEASES);
    expect(updatedSame.releases[0]?.actionRequired).toBe(true);

    const parsed = parseReleaseIndex(formatReleaseIndex(updatedSame));
    expect(parsed).toEqual(updatedSame);
  });

  it("ships a valid seeded 1.4.0 baseline at packages/core/meta/release-index.json", () => {
    const source = readFileSync(resolve(RELEASE_INDEX_PATH), "utf8");
    const index = parseReleaseIndex(source);
    expect(index.schemaVersion).toBe(1);
    expect(index.currentVersion).toBe("1.4.0");
    expect(index.releases[0]).toMatchObject({
      version: "1.4.0",
      previousVersion: "1.3.0",
      actionRequired: true,
    });
    expect(index.releases[0]!.subpathsAdded).toContain("@openlup/platform/adapter-kit");
    expect(index.releases[0]!.symbolsDeprecated).toHaveLength(17);
    expect(index.releases[0]!.sqlAdded.length).toBeGreaterThan(0);
    expect(index.releases[0]!.settingsDelta.added.length).toBeGreaterThan(0);
  });
});
