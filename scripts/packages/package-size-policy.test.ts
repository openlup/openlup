import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLATFORM_MODULE_GRAPH } from "../../eslint.config.js";
import { parsePackagesConfig } from "./package-manifest-policy.ts";
import { checkTarballEntries } from "./package-tarball-gate.ts";
import { browserEntryBytes, checkBrowserEntry, checkPackBudget, measurePack, readPackBudget, type PackBudget } from "./package-size-policy.ts";

const entry = { name: "@openlup/example", directory: "packages/example", publish: true };
const budget: PackBudget = { code: { maxPackedBytes: 1000, maxFiles: 10 }, docs: { maxPackedBytes: 1000, maxFiles: 10 }, maxPackedBytes: 2000, maxUnpackedBytes: 4000, maxFiles: 20, baseline: { version: "0.16.0", packedBytes: 1000 }, browserEntries: {} };
const measurement = { packedBytes: 1000, unpackedBytes: 2000, files: 10, code: { packedBytes: 500, files: 8 }, docs: { packedBytes: 300, files: 2 } };
const roots: string[] = [];
const root = process.cwd();
const publishedPackages = parsePackagesConfig(readFileSync(join(root, "config/openlup-packages.json"), "utf8")).packages.filter(({ publish }) => publish);
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const check = (measured = measurement) => checkPackBudget(entry, budget, measured);
const checkSet = (measured = measurement, notes = "") => checkPackBudget(entry, budget, measured, "0.17.0", notes);

describe("package artifact limits", () => {
  it("passes within caps and refuses each planted class/aggregate overflow with package, measurement, cap and remedy", () => {
    expect(check()).toEqual([]);
    for (const field of ["packedBytes", "unpackedBytes", "files"] as const) {
      const limit = field === "packedBytes" ? budget.maxPackedBytes : field === "unpackedBytes" ? budget.maxUnpackedBytes : budget.maxFiles;
      expect(check({ ...measurement, [field]: limit + 1 })).toContainEqual({ subject: entry.name, rule: "package-size-cap", detail: expect.stringContaining(`${limit + 1} exceeds cap ${limit}; raise the cap in a reviewed PR`) });
    }
    for (const kind of ["code", "docs"] as const) for (const field of ["packedBytes", "files"] as const) {
      const limit = field === "packedBytes" ? budget[kind].maxPackedBytes : budget[kind].maxFiles;
      expect(check({ ...measurement, [kind]: { ...measurement[kind], [field]: limit + 1 } })).toContainEqual({ subject: entry.name, rule: "package-size-cap", detail: expect.stringContaining(`${kind} ${field === "files" ? "files" : "packed bytes"} ${limit + 1} exceeds cap ${limit}`) });
    }
  });
  it("passes PR-mode growth above 30% without release notes", () => {
    expect(check({ ...measurement, packedBytes: 1301 })).toEqual([]);
  });
  it("requires a nonempty, package-specific growth line only above 30% in the new release-set section and dispatch body", () => {
    expect(checkSet({ ...measurement, packedBytes: 1300 })).toEqual([]);
    const grown = { ...measurement, packedBytes: 1301 };
    const line = `- ${entry.name} size growth: additional public contracts.`;
    for (const note of ["", `## [0.16.0]\n\n${line}\n`, `## [Unreleased]\n\n${line}\n`, `## [0.17.0]\n\n- @openlup/other size growth: more code.\n`, `## [0.17.0]\n\n- ${entry.name} size growth: \n`, `## [0.17.0]\n${line}\n## [0.17.0]\n${line}`]) expect(checkSet(grown, note)).toContainEqual(expect.objectContaining({ subject: entry.name, rule: "package-size-growth" }));
    expect(checkSet(grown, `## [Unreleased]\n\n## [0.17.0]\n\n${line}\n`)).toEqual([]);
    const notes = `## [0.17.0]\n\n${line}\n`;
    for (const body of ["", "Release notes."]) expect(checkPackBudget(entry, budget, grown, "0.17.0", notes, body)).toContainEqual(expect.objectContaining({ rule: "package-size-growth", detail: expect.stringContaining("dispatched RELEASE_NOTES") }));
    expect(checkPackBudget(entry, budget, grown, "0.17.0", notes, line)).toEqual([]);
  });
  it.each(["0.17.0", "0.18.0"])("refuses a release-set baseline %s that is not a previous release, even with growth notes", (version) => {
    const line = `- ${entry.name} size growth: additional public contracts.`;
    expect(checkPackBudget(entry, { ...budget, baseline: { ...budget.baseline, version } }, { ...measurement, packedBytes: 1301 }, "0.17.0", `## [0.17.0]\n${line}\n`, line)).toContainEqual(expect.objectContaining({ subject: entry.name, rule: "package-growth-baseline", detail: expect.stringContaining("use the previously released version") }));
  });
  it.each(["src/x.test.ts", "src/x.spec.ts", "src/__tests__/x.ts", "src/fixtures/x.ts", "src/x.testFixtures.ts", "dist/x.js.map", ".env.local", ".vscode/settings.json", ".idea/x.js", "src/x.swp", ".DS_Store", "dist/x.tsbuildinfo", "x.tgz", "coverage/x.js", "stray.json", "script.sh"])("refuses packed %s even when tracked", (path) => {
    const bytes = Buffer.from("// fixture\n");
    const findings = checkTarballEntries(entry, [{ path: "package.json", bytes: Buffer.from("{}") }, { path, bytes }], (file) => file.endsWith("package.json") ? Buffer.from("{}") : bytes);
    expect(findings).toContainEqual({ subject: `${entry.name}:${path}`, rule: path.endsWith(".map") ? "sourcemap" : "package-content-allowlist", detail: expect.any(String) });
  });
  it("measures a real browser bundle and refuses planted retained growth", () => {
    const root = mkdtempSync(join(tmpdir(), "openlup-browser-size-")); roots.push(root);
    writeFileSync(join(root, "entry.js"), "export const value = 'small';\n");
    const small = browserEntryBytes(root, "entry.js");
    expect(checkBrowserEntry(entry, "./contracts", small, small * 2)).toEqual([]);
    writeFileSync(join(root, "entry.js"), `export const value = ${JSON.stringify(randomBytes(8192).toString("hex"))};\n`);
    const grown = browserEntryBytes(root, "entry.js");
    expect(checkBrowserEntry(entry, "./contracts", grown, small * 2)).toEqual([{ subject: `${entry.name}:./contracts`, rule: "browser-entry-size", detail: `minified+gzip bytes ${grown} exceeds cap ${small * 2}; raise the cap in a reviewed PR` }]);
  }, 25_000);
  // Keep each package's real artifact witness independent of the package count.
  it.each(publishedPackages)("passes $name real working-tree pack contents, budgets and browser-safe declarations", (entry) => {
    const tracked = new Set(execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", timeout: 5_000 }).split("\0"));
    const directory = join(root, entry.directory);
    const [report] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--workspaces=false"], { cwd: directory, encoding: "utf8", timeout: 20_000 }));
    const entries = report.files.map(({ path }: { path: string }) => ({ path, bytes: readFileSync(join(directory, path)) }));
    const budget = readPackBudget(root, entry);
    expect(checkTarballEntries(entry, entries, (path) => tracked.has(path) ? readFileSync(resolve(root, path)) : undefined), entry.name).toEqual([]);
    expect(checkPackBudget(entry, budget, measurePack(entries, report.size)), entry.name).toEqual([]);
    const declared = entry.name === "@openlup/platform" ? Object.entries(PLATFORM_MODULE_GRAPH).filter(([, module]) => "contracts" in module && module.contracts).map(([name]) => `./${name}/contracts`) : [];
    expect(Object.keys(budget.browserEntries).sort(), entry.name).toEqual(declared.sort());
  }, 30_000);
  it.each(publishedPackages.flatMap((entry) => Object.entries(readPackBudget(root, entry).browserEntries).map(([subpath, cap]) => ({ entry, subpath, cap }))))("caps $entry.name:$subpath real browser bundle", ({ entry, subpath, cap }) => {
    const directory = join(root, entry.directory);
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    expect(checkBrowserEntry(entry, subpath, browserEntryBytes(directory, manifest.exports[subpath].import), cap)).toEqual([]);
  }, 15_000);
});
