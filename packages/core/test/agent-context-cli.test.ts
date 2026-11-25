import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { collectExportedSymbols, declaredSymbolMaturity, formatContextResult, jsdocTags, searchContext } from "../src/agent-context-cli";
import { declaredSymbolMaturities } from "../scripts/documentation-contract.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "openlup-context-test-"));
  roots.push(root);
  install(root, "core");
  return root;
}

function install(root: string, name: string, version = "0.31.0"): string {
  const directory = join(root, "node_modules", "@openlup", name);
  mkdirSync(join(directory, "dist"), { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: `@openlup/${name}`, version, exports: { "./subscription": "./dist/subscription.js" } }, null, 2));
  writeFileSync(join(directory, "dist", "subscription.d.ts"), "export declare function nextRetryAttemptAt(): number;\n");
  return directory;
}

describe("installed agent context", () => {
  it.each(["node_modules/shop", "node_modules/@fixture/shop", "node_modules/@openlup/core/consumer", "node_modules/@openlup/core"])("resolves the installed slot from selected package %s", (location) => {
    const root = realpathSync(fixture());
    const core = join(root, "node_modules/@openlup/core");
    const cwd = join(root, location);
    if (cwd !== core) {
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture-shop", private: true, dependencies: { "@openlup/core": "0.31.0" } }));
    }
    const found = searchContext(cwd, "nextRetryAttemptAt");
    expect(found.version).toBe("0.31.0");
    expect(found.hits.some(hit => hit.file === join(core, "dist/subscription.d.ts"))).toBe(true);
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL("../src/openlup-context.js", import.meta.url)), "search", "nextRetryAttemptAt", "--json"], { cwd, encoding: "utf8" });
    expect(cli.status, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout).hits.some((hit: { file: string }) => hit.file === join(core, "dist/subscription.d.ts"))).toBe(true);
  });

  it.each([false, true])("refuses source-package self-resolution even with an installed copy: %s", (installed) => {
    const root = fixture();
    if (!installed) rmSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@openlup/core", version: "9.9.0", exports: { "./subscription": "./source.js" } }));
    writeFileSync(join(root, "README.md"), "# Checkout-only evidence\n");
    const nested = join(root, "nested");
    mkdirSync(nested);
    for (const cwd of [root, nested]) {
      expect(() => searchContext(cwd, "checkout-only evidence")).toThrow(/self-references are not installed package evidence/);
      const cli = spawnSync(process.execPath, [fileURLToPath(new URL("../src/openlup-context.js", import.meta.url)), "search", "checkout-only evidence", "--json"], { cwd, encoding: "utf8" });
      expect(cli.status).toBe(1);
      expect(cli.stdout).toBe("");
      expect(cli.stderr).toContain("self-references are not installed package evidence");
    }
  });

  it("returns readable exact declaration spans offline", () => {
    const root = fixture();
    const result = searchContext(root, "nextRetryAttemptAt");
    expect(result.version).toBe("0.31.0");
    expect(result.packages).toEqual(["@openlup/core"]);
    const declaration = result.hits.find((hit) => hit.reason === "declaration occurrence; public import unverified");
    expect(declaration).toBeDefined();
    expect(declaration?.start).toBe(1);
    for (const hit of result.hits) {
      const cited = readFileSync(hit.file, "utf8").split("\n").slice(hit.start - 1, hit.end).join("\n");
      expect(cited).toContain("nextRetryAttemptAt");
    }
  });

  it.each([
    ["internal", "declare function contractNeedle(): void;\nexport {};"],
    ["imported", "import { contractNeedle } from './private.js';\nexport {};"],
    ["re-exported", "export { contractNeedle } from './private.js';"],
    ["aliased", "export { contractNeedle as publicAlias } from './private.js';"],
    ["type-only", "export type { contractNeedle } from './private.js';"],
  ])("labels a %s declaration occurrence without inventing an import recipe", (_kind, declaration) => {
    const root = fixture();
    const core = join(root, "node_modules/@openlup/core");
    writeFileSync(join(core, "dist/occurrence.d.ts"), declaration);
    writeFileSync(join(core, "dist/duplicate.d.ts"), "export interface contractNeedle { value: string }\n");
    writeFileSync(join(core, "README.md"), "# Public example\nRead exports and this version's example before importing contractNeedle.\n");
    const result = searchContext(root, "contractNeedle");
    expect(result.hits.filter(hit => hit.file.endsWith(".d.ts"))).toHaveLength(2);
    for (const hit of result.hits.filter(hit => hit.file.endsWith(".d.ts"))) {
      expect(hit.reason).toBe("declaration occurrence; public import unverified");
      expect(Object.keys(hit).sort()).toEqual(["end", "file", "packageName", "reason", "score", "start", "title"]);
    }
    expect(result.hits.some(hit => hit.reason === "installed README.md")).toBe(true);
    expect(formatContextResult(root, result)).not.toContain("import {");
    expect(searchContext(root, "@openlup/core/subscription").hits).toContainEqual(expect.objectContaining({ reason: "declared public export", title: "@openlup/core/subscription" }));
  });

  it("finds installed guide headings recursively without changing the result shape", () => {
    const root = fixture();
    const guide = join(root, "node_modules/@openlup/core/docs/guide");
    mkdirSync(join(guide, "nested"), { recursive: true });
    writeFileSync(join(guide, "README.md"), "# OpenLup guide\n\n## Guide discovery\nGuide discovery starts here.\n");
    writeFileSync(join(guide, "nested/page.md"), "# Guide discovery\nGuide discovery continues here.\n");
    const result = JSON.parse(JSON.stringify(searchContext(root, "reader discovery")));
    expect(Object.keys(result).sort()).toEqual(["hits", "packages", "scans", "version"]);
    expect(result.scans).toEqual([]);
    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((hit: { reason: string }) => hit.reason).sort()).toEqual(["installed docs/guide/README.md", "installed docs/guide/nested/page.md"]);
    for (const hit of result.hits) {
      expect(Object.keys(hit).sort()).toEqual(["end", "file", "packageName", "reason", "score", "start", "title"]);
      expect(hit).toMatchObject({ title: "Guide discovery", packageName: "@openlup/core", score: expect.any(Number) });
      expect(readFileSync(hit.file, "utf8").split("\n").slice(hit.start - 1, hit.end).join("\n")).toContain("Guide discovery");
    }
  });

  it("accepts older installs without a guide and indexes guide pages only in core", () => {
    const root = fixture();
    expect(searchContext(root, "discovery").hits).toEqual([]);
    const other = install(root, "outbox");
    mkdirSync(join(other, "docs/guide"), { recursive: true });
    writeFileSync(join(other, "docs/guide/README.md"), "# Guide discovery\n");
    expect(searchContext(root, "discovery").hits).toEqual([]);
  });

  it.each(["docs", "docs/guide", "docs/guide/nested", "docs/guide/page.md"])("does not follow the guide symlink %s", (link) => {
    const root = fixture();
    const directory = join(root, "node_modules/@openlup/core");
    const target = join(root, "outside");
    mkdirSync(target);
    writeFileSync(join(target, "page.md"), "# Escaped guide needle\n");
    const path = join(directory, link);
    mkdirSync(join(path, ".."), { recursive: true });
    symlinkSync(link.endsWith(".md") ? join(target, "page.md") : target, path);
    expect(searchContext(root, "escaped guide needle").hits).toEqual([]);
  });

  it("refuses guide traversal separators in directory entries", () => {
    const root = fixture();
    const guide = join(root, "node_modules/@openlup/core/docs/guide");
    mkdirSync(guide, { recursive: true });
    writeFileSync(join(guide, "..\\escape.md"), "# Traversal needle\n");
    expect(() => searchContext(root, "traversal needle")).toThrow(/Invalid installed guide path/);
  });

  it("walks guide files in sorted order, skips oversized pages and caps visited files", () => {
    const root = fixture();
    const guide = join(root, "node_modules/@openlup/core/docs/guide");
    mkdirSync(guide, { recursive: true });
    writeFileSync(join(guide, "0000.md"), "# Oversizedmarker\n" + "x".repeat(200_000));
    writeFileSync(join(guide, "0001.md"), "# Boundarymarker\n".padEnd(200_000, " "));
    for (let index = 2; index < 400; index++) writeFileSync(join(guide, `${String(index).padStart(4, "0")}.md`), "# Unrelated\n");
    writeFileSync(join(guide, "0400.md"), "# Beyondboundmarker\n");
    expect(searchContext(root, "oversizedmarker").hits).toEqual([]);
    expect(searchContext(root, "boundarymarker").hits).toHaveLength(1);
    expect(searchContext(root, "beyondboundmarker").hits).toEqual([]);
  });

  it("counts directories toward the guide walk bound", () => {
    const root = fixture();
    const guide = join(root, "node_modules/@openlup/core/docs/guide");
    mkdirSync(guide, { recursive: true });
    writeFileSync(join(guide, "0000.md"), "# Earlywalkmarker\n");
    for (let index = 1; index < 450; index++) mkdirSync(join(guide, `d${String(index).padStart(4, "0")}`));
    writeFileSync(join(guide, "zzzz.md"), "# Latewalkmarker\n");
    expect(searchContext(root, "earlywalkmarker").hits).toHaveLength(1);
    expect(searchContext(root, "latewalkmarker").hits).toEqual([]);
  });

  it("refuses mixed installed package versions before returning sources", () => {
    const root = fixture();
    install(root, "platform", "0.30.0");
    expect(() => searchContext(root, "retry")).toThrow(/Mixed @openlup/);
  });

  it("routes retry questions to the packaged subscription engine owner", () => {
    const root = fixture();
    const docs = join(root, "node_modules/@openlup/core/docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "SUBSCRIPTION_ENGINE.md"), "# Subscription engine\n\n## The retry ladder terminates\nA failed cycle uses the dunning retry ladder and remains active.\n");
    const hit = searchContext(root, "retry ladder dunning").hits.find((item) => item.reason === "installed docs/SUBSCRIPTION_ENGINE.md");
    expect(hit).toMatchObject({ title: "The retry ladder terminates", start: 3, end: 5 });
  });

  it("returns disjoint Markdown sections from an installed README", () => {
    const root = fixture();
    const directory = join(root, "node_modules/@openlup/core");
    const excerpt = "## Parent\nGeneral guidance.\n\n### Child\nUnique checkout replay evidence.\n";
    writeFileSync(join(directory, "README.md"), `# Guide\n\n${excerpt}\n## Other\nUnrelated.\n`);
    const hits = searchContext(root, "checkout replay evidence").hits;
    expect(hits.filter((hit) => hit.file === join(directory, "README.md")).map((hit) => hit.title)).toEqual(["Child"]);
  });

  it("searches installed agent instructions and includes changelogs for upgrade questions", () => {
    const root = fixture();
    const directory = join(root, "node_modules/@openlup/core");
    writeFileSync(join(directory, "AGENTS.md"), "# Agent instructions\nUse an extension seam for custom policy.\n");
    writeFileSync(join(directory, "CHANGELOG.md"), "# Changes\n\n## Upgrade guidance\nReview the extension seam before upgrading.\n");
    expect(searchContext(root, "extension seam").hits).toMatchObject([
      { file: join(directory, "AGENTS.md"), reason: "installed AGENTS.md" },
    ]);
    expect(searchContext(root, "upgrade extension seam").hits.some((hit) => hit.file === join(directory, "CHANGELOG.md"))).toBe(true);
  });

  it("refuses a lockfile that disagrees with installed bytes", () => {
    const root = fixture();
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/@openlup/core": { version: "0.30.0" } } }));
    expect(() => searchContext(root, "retry")).toThrow(/Lockfile and installed package disagree/);
  });

  it("selects a standalone app's declared packages instead of undeclared installations", () => {
    const root = fixture();
    install(root, "outbox", "0.30.0");
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "@openlup/core": "0.31.0" } }));
    expect(searchContext(root, "nextRetryAttemptAt").packages).toEqual(["@openlup/core"]);
  });

  it("keeps installed Core guidance readable with omitted non-Core declarations", () => {
    const root = fixture();
    writeFileSync(join(root, "package.json"), JSON.stringify({
      dependencies: { "@openlup/core": "0.31.0", "@openlup/platform": "0.31.0" },
      devDependencies: { "@openlup/development-only": "0.31.0" },
      optionalDependencies: { "@openlup/optional": "0.31.0" },
      peerDependencies: { "@openlup/peer": "0.31.0" },
    }));
    const result = searchContext(root, "nextRetryAttemptAt");
    expect(result.packages).toEqual(["@openlup/core"]);
    expect(result.scans.map(scan => scan.packageName)).toEqual(["@openlup/core"]);
    expect(result.hits).toHaveLength(1);
    const platform = install(root, "platform");
    writeFileSync(join(platform, "package.json"), "{ malformed");
    expect(() => searchContext(root, "retry")).toThrow();
  });

  it("resolves a hoisted npm workspace app's public import and excludes sibling packages and source", () => {
    const root = fixture();
    install(root, "outbox", "0.30.0");
    const app = join(root, "apps/store");
    const sibling = join(root, "apps/other");
    mkdirSync(app, { recursive: true });
    mkdirSync(sibling);
    writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { "@openlup/core": "0.31.0" } }));
    writeFileSync(join(sibling, "package.json"), JSON.stringify({ dependencies: { "@openlup/outbox": "0.30.0" } }));
    writeFileSync(join(app, "local.ts"), "export const selectedAppNeedle = 1;\n");
    writeFileSync(join(sibling, "private.ts"), "export const siblingAppNeedle = 1;\n");
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: {
      "apps/store": { dependencies: { "@openlup/core": "0.31.0" } },
      "apps/other": { dependencies: { "@openlup/outbox": "0.30.0" } },
      "node_modules/@openlup/core": { version: "0.31.0" },
      "node_modules/@openlup/outbox": { version: "0.30.0" },
    } }));
    writeFileSync(join(root, "node_modules/@openlup/core/dist/subscription.js"), "exports.nextRetryAttemptAt = () => '0.31.0';\n");
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e", "import { nextRetryAttemptAt } from '@openlup/core/subscription'; console.log(nextRetryAttemptAt());"], { cwd: app, encoding: "utf8" });
    expect(imported.status, imported.stderr).toBe(0);
    const result = searchContext(app, "nextRetryAttemptAt");
    expect(imported.stdout.trim()).toBe(result.version);
    expect(result.packages).toEqual(["@openlup/core"]);
    expect(result.hits[0]?.file).toBe(join(root, "node_modules/@openlup/core/dist/subscription.d.ts"));
    expect(searchContext(app, "selectedAppNeedle", true).hits[0]?.file).toBe(join(app, "local.ts"));
    expect(searchContext(app, "siblingAppNeedle", true).hits).toEqual([]);
    const cli = fileURLToPath(new URL("../src/agent-context-cli.ts", import.meta.url));
    const run = spawnSync(process.execPath, [cli, "search", "nextRetryAttemptAt", "--json"], { cwd: app, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    // A child process's cwd uses the real path (notably /private/var on macOS).
    expect(JSON.parse(run.stdout)).toEqual(searchContext(realpathSync(app), "nextRetryAttemptAt"));
  });

  it("uses Node's nearest reachable installation and the matching nested lock entry", () => {
    const root = fixture();
    const app = join(root, "apps/store");
    install(app, "core", "0.32.0");
    writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { "@openlup/core": "0.32.0" } }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: {
      "apps/store": {},
      "node_modules/@openlup/core": { version: "0.31.0" },
      "apps/store/node_modules/@openlup/core": { version: "0.32.0" },
    } }));
    expect(searchContext(app, "nextRetryAttemptAt")).toMatchObject({ version: "0.32.0", hits: [{ file: join(app, "node_modules/@openlup/core/dist/subscription.d.ts") }] });
  });

  it("refuses a hoisted owning-lock mismatch even when a sibling lock entry agrees", () => {
    const root = fixture();
    const app = join(root, "apps/store");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { "@openlup/core": "0.31.0" } }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: {
      "apps/store": {},
      "node_modules/@openlup/core": { version: "0.30.0" },
      "apps/other/node_modules/@openlup/core": { version: "0.31.0" },
    } }));
    expect(() => searchContext(app, "retry")).toThrow(/Lockfile and installed package disagree.*0.30.0 vs 0.31.0/);
  });

  it("refuses a missing owning-lock package entry and mixed declared reachable versions", () => {
    const root = fixture();
    const app = join(root, "apps/store");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { "@openlup/core": "0.31.0", "@openlup/outbox": "0.30.0" } }));
    install(root, "outbox", "0.30.0");
    expect(() => searchContext(app, "retry")).toThrow(/Mixed @openlup/);
    install(root, "outbox");
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "apps/store": {}, "node_modules/@openlup/core": { version: "0.31.0" } } }));
    expect(() => searchContext(app, "retry")).toThrow(/Owning npm lockfile has no package version for @openlup\/outbox/);
  });

  it("supports linked installs and the owning lock's linked target version", () => {
    const root = fixture();
    const installed = join(root, "node_modules/@openlup/core");
    const linked = join(root, "linked-core");
    // A package-manager link retains Node's lexical installation path for lock lookup.
    mkdirSync(linked);
    for (const name of ["package.json", "dist/subscription.d.ts"]) {
      mkdirSync(join(linked, name, ".."), { recursive: true });
      writeFileSync(join(linked, name), readFileSync(join(installed, name)));
    }
    rmSync(installed, { recursive: true });
    symlinkSync(linked, installed);
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "@openlup/core": "file:linked-core" } }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/@openlup/core": { link: true, resolved: "linked-core" }, "linked-core": { version: "0.31.0" } } }));
    expect(searchContext(root, "nextRetryAttemptAt")).toMatchObject({ version: "0.31.0", hits: [{ file: join(installed, "dist/subscription.d.ts") }] });
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/@openlup/core": { link: true, resolved: "linked-core" }, "linked-core": { version: "0.30.0" } } }));
    expect(() => searchContext(root, "retry")).toThrow(/Lockfile and installed package disagree/);
  });

  it("requires reachable Core and names the supported installation layout", () => {
    const root = fixture();
    rmSync(join(root, "node_modules/@openlup/core"), { recursive: true });
    install(root, "outbox");
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "@openlup/outbox": "0.31.0" }, packageManager: "yarn@4.0.0" }));
    expect(() => searchContext(root, "retry")).toThrow(/No installed @openlup\/core.*required.*npm node_modules layout/);
  });

  it("uses the selected app's own lock before an ancestor workspace lock", () => {
    const root = fixture();
    const app = join(root, "apps/store");
    install(app, "core");
    writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { "@openlup/core": "0.31.0" } }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "apps/store": {}, "apps/store/node_modules/@openlup/core": { version: "0.31.0" } } }));
    writeFileSync(join(app, "package-lock.json"), JSON.stringify({ packages: { "node_modules/@openlup/core": { version: "0.30.0" } } }));
    expect(() => searchContext(app, "retry")).toThrow(/Lockfile and installed package disagree/);
  });

  it("explains declaration evidence in CLI help without displaying an import recipe", () => {
    const root = fixture();
    const cli = fileURLToPath(new URL("../src/agent-context-cli.ts", import.meta.url));
    const run = spawnSync(process.execPath, [cli, "--help"], { cwd: root, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("Declaration occurrences are unverified import leads");
    expect(run.stdout).toContain("public specifiers and type/value usage");
  });

  it.each([["application", 2500], ["declarations", 2000], ["package-source", 2000]] as const)("reports bounded %s scans across directories", (scope, limit) => {
    const root = fixture();
    const core = join(root, "node_modules/@openlup/core");
    const directory = scope === "application" ? root : join(core, scope === "declarations" ? "dist" : "src");
    mkdirSync(directory, { recursive: true });
    if (scope === "declarations") rmSync(join(directory, "subscription.d.ts"));
    const extension = scope === "declarations" ? "d.ts" : "ts";
    const run = () => searchContext(root, "beyondBoundNeedle", scope === "application", scope === "package-source");
    const summary = () => run().scans.find((scan) => scan.scope === scope);
    for (let index = 0; index < limit - 1; index++) {
      writeFileSync(join(directory, `${String(index).padStart(4, "0")}.${extension}`), "export const unrelated = 1;\n");
    }
    expect(summary()).toMatchObject({ scannedFiles: limit - 1, fileLimit: limit, limitReached: false });
    const nested = join(directory, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, `0000.${extension}`), "export const unrelated = 1;\n");
    expect(summary()).toMatchObject({ scannedFiles: limit, limitReached: true });
    writeFileSync(join(nested, `0001.${extension}`), "export const beyondBoundNeedle = 1;\n");
    const result = run();
    expect(result.scans.find((scan) => scan.scope === scope)).toMatchObject({ scannedFiles: limit, limitReached: true });
    expect(result.hits).toEqual([]);
    if (scope === "application") {
      const cli = fileURLToPath(new URL("../src/agent-context-cli.ts", import.meta.url));
      const text = spawnSync(process.execPath, [cli, "search", "beyondBoundNeedle", "--code"], { cwd: root, encoding: "utf8" });
      expect(text.status, text.stderr).toBe(0);
      expect(text.stdout).toContain("application 2500/2500; inspect a known path with scoped rg");
      expect(text.stdout).toContain("does not prove a public seam is absent");
      const json = spawnSync(process.execPath, [cli, "search", "beyondBoundNeedle", "--code", "--json"], { cwd: root, encoding: "utf8" });
      expect(json.status, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout).scans).toContainEqual({ scope: "application", scannedFiles: limit, fileLimit: limit, limitReached: true });
    }
  });

  it("omits unrequested and ineligible scans and reports existing empty roots", () => {
    const root = fixture();
    const core = join(root, "node_modules/@openlup/core");
    expect(searchContext(root, "two words").scans).toEqual([]);
    expect(searchContext(root, "How to retry").scans).toEqual([]);
    rmSync(join(core, "dist"), { recursive: true });
    expect(searchContext(root, "someSymbol", false, true).scans).toEqual([]);
    mkdirSync(join(core, "dist"));
    mkdirSync(join(core, "src"));
    expect(searchContext(root, "someSymbol", true, true).scans).toEqual([
      { scope: "declarations", packageName: "@openlup/core", scannedFiles: 0, fileLimit: 2000, limitReached: false },
      { scope: "application", scannedFiles: 0, fileLimit: 2500, limitReached: false },
      { scope: "package-source", packageName: "@openlup/core", scannedFiles: 0, fileLimit: 2000, limitReached: false },
    ]);
  });

  it("ranks guide recipes and migration prose above repeated upgrade API diff blocks and matches PascalCase symbols in multi-word queries", () => {
    const root = fixture();
    const core = join(root, "node_modules/@openlup/core");
    writeFileSync(join(core, "dist/subscription.d.ts"),
      "export interface OneTimeOfferPricing { sku: string }\nexport declare const MAX_CADENCE_DAYS = 3660;\n");
    mkdirSync(join(core, "docs/guide/how-to/build"), { recursive: true });
    mkdirSync(join(core, "docs/guide/upgrade"), { recursive: true });
    writeFileSync(join(core, "docs/guide/how-to/build/quote-prices.md"),
      "## Price a fixed one-time offer\nPass OneTimeOfferPricing to the quote engine.\n");
    writeFileSync(join(core, "docs/guide/upgrade/v1-2-0.md"), [
      "# Upgrading to 1.2.0",
      "## @openlup/platform",
      "Pass OneTimeOfferPricing in authoritative quote options.",
      "## API changes",
      ...["catalog", "pricing", "promotions", "commerce", "commerce-server", "commerce-native"].map(
        (name) => `### \`packages/platform/api/${name}.api.md\`\n\`\`\`ts nocheck\nexport interface OneTimeOfferPricing {\n\`\`\``,
      ),
    ].join("\n\n"));

    const multiWord = searchContext(root, "OneTimeOfferPricing quote");
    expect(multiWord.hits[0]).toMatchObject({
      title: "OneTimeOfferPricing",
      reason: "declaration occurrence; public import unverified",
    });
    const guideIndex = multiWord.hits.findIndex((hit) => hit.file.endsWith("quote-prices.md"));
    const proseIndex = multiWord.hits.findIndex((hit) => hit.title === "@openlup/platform");
    const apiDiffHits = multiWord.hits.filter((hit) => hit.title.endsWith(".api.md`"));
    expect(guideIndex).toBeGreaterThan(0);
    expect(proseIndex).toBeGreaterThan(0);
    expect(apiDiffHits).toHaveLength(1);
    expect(guideIndex).toBeLessThan(multiWord.hits.indexOf(apiDiffHits[0]!));
    expect(proseIndex).toBeLessThan(multiWord.hits.indexOf(apiDiffHits[0]!));

    const constantQuery = searchContext(root, "MAX_CADENCE_DAYS bound");
    expect(constantQuery.hits[0]).toMatchObject({
      title: "MAX_CADENCE_DAYS",
      reason: "declaration occurrence; public import unverified",
    });

    const explicitReport = searchContext(root, "packages/platform/api/pricing.api.md OneTimeOfferPricing");
    expect(explicitReport.hits[1]?.title).toBe("`packages/platform/api/pricing.api.md`");
    expect(explicitReport.hits.filter((hit) => hit.title.endsWith(".api.md`"))).toHaveLength(5);
  });

  it("does not count excluded application and package source files", () => {
    const root = fixture();
    const src = join(root, "node_modules/@openlup/core/src");
    mkdirSync(src);
    for (const directory of [root, src]) {
      writeFileSync(join(directory, "large.ts"), "x".repeat(200_001));
      writeFileSync(join(directory, "ignored.txt"), "ignored");
      symlinkSync(join(directory, "large.ts"), join(directory, "link.ts"));
    }
    mkdirSync(join(root, ".hidden"));
    writeFileSync(join(root, ".hidden", "ignored.ts"), "ignored");
    const scans = searchContext(root, "unmatchedneedle", true, true).scans;
    expect(scans.find((scan) => scan.scope === "application")?.scannedFiles).toBe(0);
    expect(scans.find((scan) => scan.scope === "package-source")?.scannedFiles).toBe(0);
  });

  it("reports an empty search without claiming the public seam is absent", () => {
    const root = fixture();
    expect(searchContext(root, "unmatchedneedle").hits).toEqual([]);
    const cli = fileURLToPath(new URL("../src/agent-context-cli.ts", import.meta.url));
    const run = spawnSync(process.execPath, [cli, "search", "unmatchedneedle"], { cwd: root, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("does not prove a public seam is absent");
  });

  it("only reads application code when selected and reflects subsequent edits", () => {
    const root = fixture();
    const file = join(root, "checkout.ts");
    writeFileSync(file, "export const localCheckoutNeedle = 1;\n");
    expect(searchContext(root, "localCheckoutNeedle").hits).toEqual([]);
    const hit = searchContext(root, "localCheckoutNeedle", true).hits[0];
    expect(hit).toMatchObject({ file, start: 1, end: 1, packageName: "application" });
    writeFileSync(file, "export const renamedCheckoutNeedle = 1;\n");
    expect(searchContext(root, "localCheckoutNeedle", true).hits).toEqual([]);
    expect(searchContext(root, "renamedCheckoutNeedle", true).hits[0]?.file).toBe(file);
  });

  it("searches installed package source only when selected, including an exact source path", () => {
    const root = fixture();
    const directory = join(root, "node_modules/@openlup/core/src");
    mkdirSync(directory);
    const file = join(directory, "checkout.ts");
    writeFileSync(file, "export function packageCheckoutNeedle() { return 1; }\n");
    expect(searchContext(root, "packageCheckoutNeedle").hits).toEqual([]);
    expect(searchContext(root, "packageCheckoutNeedle", false, true).hits[0]).toMatchObject({ file, start: 1, end: 1, reason: "installed package source" });
    const exact = searchContext(root, "src/checkout.ts", false, true);
    expect(exact.hits[0]).toMatchObject({ file, start: 1, end: 1, reason: "exact installed source path" });
    expect(exact.scans.find((scan) => scan.scope === "package-source")?.scannedFiles).toBe(1);
    const outside = join(root, "outside.ts");
    writeFileSync(outside, "export const outsidePackageNeedle = 1;\n");
    symlinkSync(outside, join(directory, "outside.ts"));
    expect(searchContext(root, "outsidePackageNeedle", false, true).hits).toEqual([]);
  });

  it("supports configurable hit limits via searchContext and CLI --limit while failing closed on invalid values", () => {
    const root = fixture();
    const core = join(root, "node_modules/@openlup/core");
    const dist = join(core, "dist");
    for (let index = 0; index < 12; index++) {
      writeFileSync(join(dist, `f${String(index).padStart(2, "0")}.d.ts`), "export declare const MultiHitNeedle: number;\n");
    }
    expect(searchContext(root, "MultiHitNeedle").hits).toHaveLength(8);
    expect(searchContext(root, "MultiHitNeedle", false, false, { limit: 12 }).hits).toHaveLength(12);
    expect(searchContext(root, "MultiHitNeedle", false, false, { limit: 3 }).hits).toHaveLength(3);
    expect(() => searchContext(root, "MultiHitNeedle", false, false, { limit: 0 })).toThrow(/between 1 and 50/);
    expect(() => searchContext(root, "MultiHitNeedle", false, false, { limit: 51 })).toThrow(/between 1 and 50/);

    const cli = fileURLToPath(new URL("../src/agent-context-cli.ts", import.meta.url));
    const spaceFlag = spawnSync(process.execPath, [cli, "search", "MultiHitNeedle", "--limit", "10", "--json"], { cwd: root, encoding: "utf8" });
    expect(spaceFlag.status, spaceFlag.stderr).toBe(0);
    expect(JSON.parse(spaceFlag.stdout).hits).toHaveLength(10);

    const equalsFlag = spawnSync(process.execPath, [cli, "search", "MultiHitNeedle", "--limit=4", "--json"], { cwd: root, encoding: "utf8" });
    expect(equalsFlag.status, equalsFlag.stderr).toBe(0);
    expect(JSON.parse(equalsFlag.stdout).hits).toHaveLength(4);

    for (const badArgs of [["--limit", "0"], ["--limit", "51"], ["--limit=abc"], ["--limit"]]) {
      const bad = spawnSync(process.execPath, [cli, "search", "MultiHitNeedle", ...badArgs], { cwd: root, encoding: "utf8" });
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("Limit must be an integer between 1 and 50");
    }
  });

  it("traverses declarations and source trees in deterministic lexicographic order under scanLimits", () => {
    const root = fixture();
    const core = join(root, "node_modules/@openlup/core");
    const dist = join(core, "dist");
    rmSync(join(dist, "subscription.d.ts"));
    mkdirSync(join(dist, "b-dir"), { recursive: true });
    mkdirSync(join(dist, "a-dir"), { recursive: true });
    writeFileSync(join(dist, "z.d.ts"), "export declare const SortedNeedle: number;\n");
    writeFileSync(join(dist, "a-dir", "first.d.ts"), "export declare const SortedNeedle: number;\n");
    writeFileSync(join(dist, "b-dir", "second.d.ts"), "export declare const SortedNeedle: number;\n");

    const bounded = searchContext(root, "SortedNeedle", false, false, { scanLimits: { declarations: 2 } });
    expect(bounded.scans).toContainEqual({
      scope: "declarations",
      packageName: "@openlup/core",
      scannedFiles: 2,
      fileLimit: 2,
      limitReached: true,
    });
    expect(bounded.hits.map((hit) => hit.file)).toEqual([
      join(dist, "a-dir", "first.d.ts"),
      join(dist, "z.d.ts"),
    ]);
  });

  it("resolves directly exported symbols to their declared public subpath when exports declare types entrypoints", () => {
    const root = fixture();
    const platform = join(root, "node_modules/@openlup/platform");
    mkdirSync(join(platform, "dist/subscriptions"), { recursive: true });
    mkdirSync(join(platform, "dist/data"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "fixture-app",
      private: true,
      dependencies: { "@openlup/core": "0.31.0", "@openlup/platform": "0.31.0" },
    }));
    writeFileSync(join(platform, "package.json"), JSON.stringify({
      name: "@openlup/platform",
      version: "0.31.0",
      exports: {
        "./subscriptions": {
          types: "./dist/subscriptions/index.d.ts",
          import: "./dist/subscriptions/index.js",
          default: "./dist/subscriptions/index.js",
        },
        "./data": {
          types: "./dist/data/index.d.ts",
          import: "./dist/data/index.js",
          default: "./dist/data/index.js",
        },
      },
    }, null, 2));
    writeFileSync(
      join(platform, "dist/subscriptions/index.d.ts"),
      "export { createPostgresRenewalStore } from './store.js';\nexport { internalHelper as PublicHelper } from './internal.js';\n",
    );
    writeFileSync(join(platform, "dist/data/index.d.ts"), "export * from './sql.js';\n");
    writeFileSync(join(platform, "dist/data/sql.d.ts"), "export interface SqlExecutor { query(sql: string): Promise<unknown>; }\n");

    const renewal = searchContext(root, "createPostgresRenewalStore");
    expect(renewal.hits[0]).toMatchObject({
      title: "@openlup/platform/subscriptions (createPostgresRenewalStore)",
      file: join(platform, "package.json"),
      packageName: "@openlup/platform",
      reason: "declared public export",
    });

    const starExport = searchContext(root, "SqlExecutor");
    expect(starExport.hits[0]).toMatchObject({
      title: "@openlup/platform/data (SqlExecutor)",
      file: join(platform, "package.json"),
      packageName: "@openlup/platform",
      reason: "declared public export",
    });

    const aliasedOut = searchContext(root, "internalHelper");
    expect(aliasedOut.hits.some((hit) => hit.reason === "declared public export")).toBe(false);
    const aliasedIn = searchContext(root, "PublicHelper");
    expect(aliasedIn.hits[0]).toMatchObject({
      title: "@openlup/platform/subscriptions (PublicHelper)",
      reason: "declared public export",
    });
  });

  it("handles export type *, comment/string edge cases, and refuses symlinked declaration parents or files", () => {
    const root = fixture();
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "escaped.d.ts"), "export interface EscapedSecretType { x: string; }\n");

    const platform = join(root, "node_modules/@openlup/platform");
    mkdirSync(join(platform, "dist/contracts"), { recursive: true });
    symlinkSync(outside, join(platform, "dist/linked"));
    symlinkSync(join(outside, "escaped.d.ts"), join(platform, "dist/contracts/leafLink.d.ts"));
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "fixture-app",
      private: true,
      dependencies: { "@openlup/core": "0.31.0", "@openlup/platform": "0.31.0" },
    }));
    writeFileSync(join(platform, "package.json"), JSON.stringify({
      name: "@openlup/platform",
      version: "0.31.0",
      exports: {
        "./contracts": {
          types: "./dist/contracts/index.d.ts",
          import: "./dist/contracts/index.js",
          default: "./dist/contracts/index.js",
        },
        "./linked": {
          types: "./dist/linked/escaped.d.ts",
          import: "./dist/linked/escaped.js",
          default: "./dist/linked/escaped.js",
        },
      },
    }, null, 2));
    writeFileSync(
      join(platform, "dist/contracts/index.d.ts"),
      [
        "// line comment with /* should not swallow next export",
        'export declare const EndpointUrl = "https://example.invalid/*not-a-comment*/";',
        "export/*inline*/declare interface InlineCommentType { ok: true; }",
        "export type * from './types.js';",
        "export type * as TypeNamespace from './types.js';",
        "export * from '../linked/escaped.js';",
        "export * from './leafLink.js';",
      ].join("\n"),
    );
    writeFileSync(join(platform, "dist/contracts/types.d.ts"), "export interface StarTypeExport { id: string; }\n");

    expect(searchContext(root, "StarTypeExport").hits[0]).toMatchObject({
      title: "@openlup/platform/contracts (StarTypeExport)",
      reason: "declared public export",
    });
    expect(searchContext(root, "TypeNamespace").hits[0]).toMatchObject({
      title: "@openlup/platform/contracts (TypeNamespace)",
      reason: "declared public export",
    });
    expect(searchContext(root, "EndpointUrl").hits[0]).toMatchObject({
      title: "@openlup/platform/contracts (EndpointUrl)",
      reason: "declared public export",
    });
    expect(searchContext(root, "InlineCommentType").hits[0]).toMatchObject({
      title: "@openlup/platform/contracts (InlineCommentType)",
      reason: "declared public export",
    });
    expect(searchContext(root, "EscapedSecretType").hits.some((hit) => hit.reason === "declared public export")).toBe(false);
  });
});

// Symbol maturity. Every fixture here is synthetic: no test names a real symbol, so promoting
// or deprecating a symbol of the package never breaks one.
function maturityFixture(files: Record<string, string>, options: { gates?: false | string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "openlup-maturity-test-"));
  roots.push(root);
  const core = join(root, "node_modules/@openlup/core");
  mkdirSync(join(core, "dist/feature"), { recursive: true });
  writeFileSync(join(core, "package.json"), JSON.stringify({
    name: "@openlup/core",
    version: "0.31.0",
    exports: { "./feature": { types: "./dist/feature/index.d.ts", import: "./dist/feature/index.js", default: "./dist/feature/index.js" } },
  }, null, 2));
  if (options.gates !== false) {
    writeFileSync(join(core, "release-gates.json"), JSON.stringify({ packageSurface: { "./feature": { role: "kernel", maturity: options.gates ?? "stable", entrypoint: "dist/feature/index.d.ts" } } }));
  }
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(core, "dist/feature", path)), { recursive: true });
    writeFileSync(join(core, "dist/feature", path), contents);
  }
  return { root, core };
}

const exportHit = (root: string, symbol: string) =>
  searchContext(root, symbol).hits.find((hit) => hit.reason === "declared public export" && hit.title === `@openlup/core/feature (${symbol})`);
const cliSource = fileURLToPath(new URL("../src/agent-context-cli.ts", import.meta.url));

const tagged = [
  "/** @experimental */",
  "export declare const TaggedAbove: number;",
  "/**",
  " * Neutral product data.",
  " * @beta",
  " * @experimental",
  " */",
  "export declare function TaggedBeta(): void;",
  "/** Neutral product data. @experimental */",
  "export interface TaggedAfterProse { a: 1 }",
  "/** @deprecated Use TaggedAbove. */",
  "export declare const Retired: number;",
  "/**",
  " * @experimental",
  " * @deprecated",
  " */",
  "export type Both = string;",
  "export declare const Untagged: number;",
  "",
].join("\n");
const named = [
  "export interface Named { a: 1 }",
  "export declare const original: number;",
  "/** @beta @experimental */ export declare const OneLine: number;",
  "export type TypeOnly = string;",
  "",
].join("\n");
const featureIndex = [
  'export * from "./declared.js";',
  'export { Named, original as Renamed, OneLine } from "./named.js";',
  'export type { TypeOnly } from "./named.js";',
  "",
].join("\n");

const maturityRows: [string, { maturity: string; deprecated?: true }][] = [
  ["TaggedAbove", { maturity: "experimental" }],
  ["TaggedBeta", { maturity: "experimental" }],
  ["TaggedAfterProse", { maturity: "experimental" }],
  ["Retired", { maturity: "stable", deprecated: true }],
  ["Both", { maturity: "experimental", deprecated: true }],
  ["Untagged", { maturity: "stable" }],
  ["Named", { maturity: "stable" }],
  ["Renamed", { maturity: "stable" }],
  ["OneLine", { maturity: "experimental" }],
  ["TypeOnly", { maturity: "stable" }],
];

describe("symbol maturity in export hits", () => {
  it("reports the declared maturity and deprecation from the declaration's own comment, in hits, text and JSON", () => {
    const { root } = maturityFixture({ "index.d.ts": featureIndex, "declared.d.ts": tagged, "named.d.ts": named });
    for (const [symbol, expected] of maturityRows) {
      const hit = exportHit(root, symbol);
      expect(hit, symbol).toBeDefined();
      expect(hit, symbol).toMatchObject(expected);
      // An absent member is absent, never present with the value undefined.
      expect(Object.keys(hit!).includes("deprecated"), symbol).toBe(expected.deprecated === true);
      const text = formatContextResult(root, searchContext(root, symbol));
      const suffix = `(declared public export); maturity ${expected.maturity}${expected.deprecated ? "; deprecated" : ""}\n`;
      expect(text, symbol).toContain(suffix);
      const cli = spawnSync(process.execPath, [cliSource, "search", symbol, "--json"], { cwd: root, encoding: "utf8" });
      expect(cli.status, cli.stderr).toBe(0);
      const json = (JSON.parse(cli.stdout).hits as { reason: string; title: string }[]).find((item) => item.title === `@openlup/core/feature (${symbol})`);
      expect(json, symbol).toMatchObject(expected);
    }
  });

  it("falls back to the tag when a gate file is absent and to the subpath's maturity when the tag is removed", () => {
    // The control: the same declarations with the experimental tag turned into a beta tag.
    const untagged = (source: string) => source.replaceAll("@experimental", "@beta");
    const removed = maturityFixture({ "index.d.ts": featureIndex, "declared.d.ts": untagged(tagged), "named.d.ts": named });
    expect(exportHit(removed.root, "TaggedAbove")).toMatchObject({ maturity: "stable" });
    expect(exportHit(removed.root, "TaggedBeta")).toMatchObject({ maturity: "stable" });
    expect(exportHit(removed.root, "Both")).toMatchObject({ maturity: "stable", deprecated: true });
    const ungated = maturityFixture({ "index.d.ts": featureIndex, "declared.d.ts": tagged, "named.d.ts": named }, { gates: false });
    expect(exportHit(ungated.root, "TaggedAbove")).toMatchObject({ maturity: "experimental" });
    expect(exportHit(ungated.root, "Retired")).toMatchObject({ deprecated: true });
    expect(Object.keys(exportHit(ungated.root, "Retired")!)).not.toContain("maturity");
    const untaggedHit = exportHit(ungated.root, "Untagged");
    expect(untaggedHit).toBeDefined();
    expect(Object.keys(untaggedHit!)).not.toContain("maturity");
    expect(Object.keys(untaggedHit!)).not.toContain("deprecated");
  });

  it("takes the maturity of a testing or experimental subpath for an untagged symbol and keeps a tag inside it", () => {
    for (const subpath of ["testing", "experimental"]) {
      const { root } = maturityFixture({ "index.d.ts": featureIndex, "declared.d.ts": tagged, "named.d.ts": named }, { gates: subpath });
      expect(exportHit(root, "Untagged")).toMatchObject({ maturity: subpath });
      expect(exportHit(root, "TaggedAbove")).toMatchObject({ maturity: "experimental" });
    }
    const unknown = maturityFixture({ "index.d.ts": featureIndex, "declared.d.ts": tagged, "named.d.ts": named }, { gates: "candidate" });
    expect(Object.keys(exportHit(unknown.root, "Untagged")!)).not.toContain("maturity");
  });

  it("does not add the members to other hit kinds", () => {
    const { root, core } = maturityFixture({ "index.d.ts": featureIndex, "declared.d.ts": tagged, "named.d.ts": named });
    writeFileSync(join(core, "README.md"), "# Package\nRead TaggedAbove before importing it.\n");
    const hits = searchContext(root, "TaggedAbove").hits.filter((hit) => !(hit.reason === "declared public export" && hit.title.includes("(")));
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(Object.keys(hit)).not.toContain("maturity");
    expect(searchContext(root, "@openlup/core/feature").hits).toContainEqual(expect.objectContaining({ title: "@openlup/core/feature", reason: "declared public export" }));
    for (const hit of searchContext(root, "@openlup/core/feature").hits) {
      expect(Object.keys(hit)).not.toContain("maturity");
      expect(Object.keys(hit)).not.toContain("deprecated");
    }
  });

  it("applies a statement's tag to every name it exports unless the declaration carries its own", () => {
    const { root } = maturityFixture({
      "index.d.ts": [
        "/** @deprecated Use Fresh. */",
        'export { Old, Older as Oldest } from "./impl.js";',
        "/** @experimental */",
        'export * from "./star.js";',
        'export { Own } from "./own.js";',
        "/** @deprecated */",
        'export * as Space from "./star.js";',
        "/** @deprecated */",
        'export { Override } from "./own.js";',
        "/** @experimental */",
        'export type { Typed } from "./impl.js";',
        "",
      ].join("\n"),
      "impl.d.ts": "export declare const Old: number;\nexport declare const Older: number;\nexport type Typed = string;\n",
      "star.d.ts": "export declare const FromStar: number;\n",
      "own.d.ts": "export declare const Own: number;\n/** @experimental */\nexport declare const Override: number;\n",
    });
    expect(exportHit(root, "Old")).toMatchObject({ maturity: "stable", deprecated: true });
    expect(exportHit(root, "Oldest")).toMatchObject({ maturity: "stable", deprecated: true });
    expect(exportHit(root, "FromStar")).toMatchObject({ maturity: "experimental" });
    expect(Object.keys(exportHit(root, "FromStar")!)).not.toContain("deprecated");
    expect(exportHit(root, "Own")).toMatchObject({ maturity: "stable" });
    expect(Object.keys(exportHit(root, "Own")!)).not.toContain("deprecated");
    expect(exportHit(root, "Space")).toMatchObject({ maturity: "stable", deprecated: true });
    // The declaration's own tag wins over the statement's.
    expect(exportHit(root, "Override")).toMatchObject({ maturity: "experimental" });
    expect(Object.keys(exportHit(root, "Override")!)).not.toContain("deprecated");
    expect(exportHit(root, "Typed")).toMatchObject({ maturity: "experimental" });
  });

  it("finds the declaration through named re-exports, aliases and star chains, and omits maturity when a link is missing", () => {
    const files = {
      "index.d.ts": [
        'export * from "./stars.js";',
        'export type { TypedHop } from "./typed.js";',
        'export { Hop as Final } from "./first.js";',
        "",
      ].join("\n"),
      "stars.d.ts": 'export * from "./deeper.js";\nexport declare const InStars: number;\n',
      "deeper.d.ts": "/** @experimental */\nexport declare const Deep: number;\n",
      "typed.d.ts": "/** @deprecated */\nexport interface TypedHop { a: 1 }\n",
      "first.d.ts": 'export { Hop } from "./second.js";\n',
      "second.d.ts": "/** @experimental */\nexport declare const Hop: number;\n",
    };
    const { root, core } = maturityFixture(files);
    expect(exportHit(root, "Deep")).toMatchObject({ maturity: "experimental" });
    expect(exportHit(root, "InStars")).toMatchObject({ maturity: "stable" });
    expect(exportHit(root, "TypedHop")).toMatchObject({ maturity: "stable", deprecated: true });
    expect(exportHit(root, "Final")).toMatchObject({ maturity: "experimental" });
    rmSync(join(core, "dist/feature/second.d.ts"));
    rmSync(join(core, "dist/feature/deeper.d.ts"));
    const broken = exportHit(root, "Final");
    expect(broken).toBeDefined();
    expect(Object.keys(broken!)).not.toContain("maturity");
    // A star target that is gone does not make the walk throw.
    expect(() => searchContext(root, "Deep")).not.toThrow();
    expect(searchContext(root, "Deep").hits.find((hit) => hit.title.includes("(Deep)"))).toBeUndefined();
  });

  it("omits maturity when the declaration is not inside the package, and keeps it for the same symbol declared inside", () => {
    const outside = join(tmpdir(), `openlup-maturity-outside-${process.pid}`);
    mkdirSync(outside, { recursive: true });
    roots.push(outside);
    writeFileSync(join(outside, "linked.d.ts"), "/** @experimental */\nexport declare const Linked: number;\n");
    const index = [
      'export { External } from "@openlup/core/pricing";',
      'import { Imported } from "./imported.js";',
      "export { Imported };",
      'export { Missing } from "./gone.js";',
      'export { Linked } from "./linked.js";',
      'export { Inside } from "./inside.js";',
      "",
    ].join("\n");
    const { root, core } = maturityFixture({
      "index.d.ts": index,
      "imported.d.ts": "/** @experimental */\nexport declare const Imported: number;\n",
      "inside.d.ts": "/** @experimental */\nexport declare const Inside: number;\n",
    });
    symlinkSync(join(outside, "linked.d.ts"), join(core, "dist/feature/linked.d.ts"));
    for (const symbol of ["External", "Imported", "Missing", "Linked"]) {
      const hit = exportHit(root, symbol);
      expect(hit, symbol).toBeDefined();
      expect(Object.keys(hit!), symbol).not.toContain("maturity");
      expect(Object.keys(hit!), symbol).not.toContain("deprecated");
    }
    expect(exportHit(root, "Inside")).toMatchObject({ maturity: "experimental" });
  });

  it("states the limit: a one-line declaration reached only through export * yields no export hit", () => {
    const { root, core } = maturityFixture({
      "index.d.ts": 'export * from "./one.js";\nexport { Through } from "./one.js";\n',
      "one.d.ts": "/** @beta @experimental */ export declare const OnlyStar: number;\n/** @beta @experimental */ export declare const Through: number;\n",
    });
    expect(exportHit(root, "OnlyStar")).toBeUndefined();
    // The walk itself reads the one-line form, so a named re-export resolves it.
    expect(exportHit(root, "Through")).toMatchObject({ maturity: "experimental" });
    expect(declaredSymbolMaturity(core, join(core, "dist/feature/index.d.ts"), "OnlyStar", "stable")).toEqual({ maturity: "experimental" });
  });

  it("states the limit: the export collector lists neither a later declarator nor a declaration after a comment on its line", () => {
    const { root, core } = maturityFixture({
      "index.d.ts": 'export * from "./more.js";\nexport { Named } from "./more.js";\n',
      "more.d.ts": "/** @experimental */\nexport declare const First: number, Later: string;\n/**\n * @experimental\n */ export declare const Named: number;\n",
    });
    expect(exportHit(root, "First")).toMatchObject({ maturity: "experimental" });
    expect(exportHit(root, "Later")).toBeUndefined();
    // The walk reads both, and a named re-export lists the second.
    expect(declaredSymbolMaturity(core, join(core, "dist/feature/index.d.ts"), "Later", "stable")).toEqual({ maturity: "experimental" });
    expect(exportHit(root, "Named")).toMatchObject({ maturity: "experimental" });
  });

  it("is bounded: a re-export cycle terminates without a maturity", () => {
    const { root, core } = maturityFixture({
      "index.d.ts": 'export { Loop } from "./a.js";\n',
      "a.d.ts": 'export { Loop } from "./b.js";\n',
      "b.d.ts": 'export { Loop } from "./a.js";\n',
    });
    expect(declaredSymbolMaturity(core, join(core, "dist/feature/index.d.ts"), "Loop", "stable")).toBeUndefined();
    expect(Object.keys(exportHit(root, "Loop")!)).not.toContain("maturity");
  });

  it("explains maturity in the CLI help", () => {
    const run = spawnSync(process.execPath, [cliSource, "--help"], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("maturity is the declared maturity");
    expect(run.stdout).toContain("read the declaration");
  });
});

// Each row is a declaration source and what the compiler reads from it for the symbol X; the
// shipped reader must agree with both the explicit value and the compiler.
const tagRule: [string, string, { maturity: string; deprecated: boolean } | undefined][] = [
  ["tag on the line above", "/** @experimental */\nexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["tag after @beta", "/** @beta @experimental */\nexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["multi-line block", "/**\n * Text.\n * @beta\n * @experimental\n */\nexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["one-line declaration", "/** @beta @experimental */ export declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["tag after prose", "/** Neutral. @experimental */\nexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["deprecated", "/** @deprecated use Y */\nexport declare function X(): void;", { maturity: "stable", deprecated: true }],
  ["both tags", "/**\n * @experimental\n * @deprecated\n */\nexport declare const X: number;", { maturity: "experimental", deprecated: true }],
  ["blank line between", "/** @experimental */\n\nexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["line comment between", "/** @experimental */\n// note\nexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["plain block comment between", "/** @experimental */\n/* note */\nexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["stacked blocks, the last one counts: tag first", "/** @experimental */\n/** other */\nexport declare const X: number;", { maturity: "stable", deprecated: false }],
  ["stacked blocks, the last one counts: tag last", "/** other */\n/** @experimental */\nexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["a plain comment is not a doc comment", "/* @experimental */\nexport declare const X: number;", { maturity: "stable", deprecated: false }],
  ["tag on an earlier declaration only", "/** @experimental */\nexport declare const Y: number;\nexport declare const X: number;", { maturity: "stable", deprecated: false }],
  ["comment after the previous statement on its line", "export declare const Y: number; /** @experimental */\nexport declare const X: number;", { maturity: "stable", deprecated: false }],
  ["member-level tag in an interface", "export interface X {\n    /** @experimental */\n    a: number;\n}", { maturity: "stable", deprecated: false }],
  ["member-level tag in a class", "export declare class X {\n    /** @deprecated */\n    a(): void;\n}", { maturity: "stable", deprecated: false }],
  ["tag in a code span", "/** Use `@experimental` sparingly. */\nexport declare const X: number;", { maturity: "stable", deprecated: false }],
  ["tag in a code span in a later tag's text", "/**\n * @beta Use `@experimental` sparingly.\n */\nexport declare const X: number;", { maturity: "stable", deprecated: false }],
  ["code span closed before the tag in a tag's text", "/**\n * @beta Use `a` @experimental\n */\nexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["code span left open ends with its line", "/**\n * @beta `open\n * @experimental\n */\nexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["tag inside an @example fence still counts", "/**\n * @example\n * ```ts\n * @experimental\n * ```\n */\nexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["name continues with a hyphen", "/** @experimental-foo */\nexport declare const X: number;", { maturity: "stable", deprecated: false }],
  ["name continues with a letter", "/** @experimentalx */\nexport declare const X: number;", { maturity: "stable", deprecated: false }],
  ["name continues with a digit", "/** @experimental2 */\nexport declare const X: number;", { maturity: "stable", deprecated: false }],
  ["name ends at a full stop", "/** @experimental. */\nexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["name ends at a comma", "/** @experimental, */\nexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["name ends at the end of the comment", "/** @experimental*/\nexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["case matters", "/** @Experimental */\nexport declare const X: number;", { maturity: "stable", deprecated: false }],
  ["no whitespace before the at sign", "/** foo@experimental */\nexport declare const X: number;", { maturity: "stable", deprecated: false }],
  ["inline tag brace", "/** {@experimental} */\nexport declare const X: number;", { maturity: "stable", deprecated: false }],
  ["tag after an inline link", "/** {@link Y} see @experimental */\nexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["asterisk before the tag", "/**\n *@experimental\n */\nexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["overloads, one tagged", "/** @experimental */\nexport declare function X(a: number): void;\nexport declare function X(a: string): void;", { maturity: "experimental", deprecated: false }],
  ["merged declarations, one deprecated", "export interface X { a: 1 }\n/** @deprecated */\nexport interface X { b: 2 }", { maturity: "stable", deprecated: true }],
  ["indented export in a namespace block is not a declaration", "export declare namespace N {\n    /** @experimental */\n    export const X: number;\n}", undefined],
  ["import then export", 'import { X } from "./gone.js";\nexport { X };', undefined],
  ["Windows line endings", "/**\r\n * @experimental\r\n */\r\nexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["const enum", "/** @experimental */\nexport declare const enum X { A = 0 }", { maturity: "experimental", deprecated: false }],
  ["abstract class", "/** @deprecated */\nexport declare abstract class X {}", { maturity: "stable", deprecated: true }],
  ["namespace", "/** @experimental */\nexport declare namespace X { const a: number; }", { maturity: "experimental", deprecated: false }],
  ["an empty comment between is not a doc comment", "/** @experimental */\n/**/\nexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["next-line character before the at sign", "/** a\u0085@experimental */\nexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["lone carriage return ends the previous statement's line", "export declare const Y: number;\r/** @experimental */\rexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["lone carriage return ends a line comment", "export declare const Y: number; // note\r/** @experimental */\rexport declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["comment before a lone carriage return stays on the previous line", "export declare const Y: number; /** @experimental */\rexport declare const X: number;", { maturity: "stable", deprecated: false }],
  ["later declarator of a variable statement", "/** @deprecated */\nexport declare const W: Record<string, number>, X: (a: 1, b: 2) => void;", { maturity: "stable", deprecated: true }],
  ["later declarator after an object type", "/** @experimental */\nexport declare const W: { a: 1; b: [2, 3] }, X: Map<string, number>;", { maturity: "experimental", deprecated: false }],
  ["multi-line doc comment closing on the declaration's line", "/**\n * @experimental\n */ export declare const X: number;", { maturity: "experimental", deprecated: false }],
  ["multi-line plain comment closing on the declaration's line", "/** @experimental */\n/* a\n b */ export declare const X: number;", { maturity: "experimental", deprecated: false }],
];

function compilerReads(source: string) {
  const read = declaredSymbolMaturities(new Map([["dist/index.d.ts", source]]), "dist/index.d.ts", "stable").symbols.get("X");
  return read === undefined ? undefined : { maturity: read.maturity, deprecated: read.deprecated };
}
function shippedReads(source: string) {
  const root = mkdtempSync(join(tmpdir(), "openlup-tag-rule-"));
  roots.push(root);
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist/index.d.ts"), source);
  const read = declaredSymbolMaturity(root, join(root, "dist/index.d.ts"), "X", "stable");
  return read === undefined ? undefined : { maturity: read.maturity, deprecated: read.deprecated === true };
}

describe("the declared-tag rule follows the TypeScript compiler's", () => {
  it.each(tagRule)("%s", (_label, source, expected) => {
    expect(compilerReads(source)).toEqual(expected);
    expect(shippedReads(source)).toEqual(expected);
  });

  it("reads a comment block exactly as the compiler's JSDoc parser does over generated shapes", () => {
    // Well-formed comment shapes: tags, prose, code spans, inline links, asterisks, odd blanks and line ends.
    const pieces = ["@experimental", "@deprecated", "@beta", "@example", "@remarks", "@experimental-x", "@Experimental", "@experimental.", "@experimental,", "`", "``", "```", " ", "  ", "\t", "\n", "\n * ", "\n *", "\n\n", "*", "**", "{@link X}", "{@linkcode Y}", "{", "}", "text", ",", "(", ")", " @", "x@y", "\r\n", "\u00a0", "\u2028", "'", "\""];
    let seed = 20_260_001;
    const next = (limit: number) => { seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0; return seed % limit; };
    const disagreements: string[] = [];
    for (let index = 0; index < 6000; index++) {
      const body = Array.from({ length: 1 + next(10) }, () => pieces[next(pieces.length)]!).join("");
      const block = `/**${body}*/`;
      const source = `${block}\nexport declare const X: number;`;
      const file = ts.createSourceFile("a.d.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const names = new Set(ts.getJSDocTags(file.statements[0]!).map((tag) => tag.tagName.text));
      const expected = { experimental: names.has("experimental"), deprecated: names.has("deprecated") };
      const actual = jsdocTags(block);
      if (actual.experimental !== expected.experimental || actual.deprecated !== expected.deprecated) disagreements.push(JSON.stringify(block));
    }
    expect(disagreements.slice(0, 10)).toEqual([]);
  });

  it("reads the trivia before a statement as the compiler does, over generated files", () => {
    // Comments, line ends and earlier statements placed before the statements X and Y, in every order.
    const comments = ["/** @experimental */", "/** @deprecated */", "/** other */", "/**\n * @experimental\n */", "/**/", "/***/", "/* */", "/* @experimental */", "/*\n @deprecated\n */", "// @experimental", "// note"];
    const lineEnds = ["\n", "\r", "\r\n", "\n\n"];
    const separators = ["", " ", ...lineEnds, "\t", "\u0085"];
    const statements = ["export declare const Y: number;", "export declare const Y: number, X: string;", "export {};", 'export { Z } from "./gone.js";'];
    let seed = 20_260_002;
    const next = (limit: number) => { seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0; return seed % limit; };
    const pick = <T,>(items: readonly T[]) => items[next(items.length)]!;
    const root = mkdtempSync(join(tmpdir(), "openlup-trivia-"));
    roots.push(root);
    mkdirSync(join(root, "dist"));
    const entry = join(root, "dist/index.d.ts");
    const disagreements: string[] = [];
    for (let index = 0; index < 3000; index++) {
      let source = "";
      for (let part = 0, count = 1 + next(3); part < count; part++) {
        if (next(2)) {
          for (let item = 0, items = 1 + next(3); item < items; item++) {
            const comment = pick(comments);
            // A line comment swallows the rest of its line, so a line end must follow it.
            source += comment + pick(comment.startsWith("//") ? lineEnds : separators);
          }
        }
        if (part + 1 < count) source += pick(statements) + pick(separators);
      }
      source += `${source.trimEnd().includes("//") && /\/\/[^\n\r]*$/u.test(source) ? pick(lineEnds) : pick(separators)}export declare const X: number;`;
      const files = new Map([["dist/index.d.ts", source]]);
      const oracle = declaredSymbolMaturities(files, "dist/index.d.ts", "stable").symbols;
      writeFileSync(entry, source);
      for (const name of ["X", "Y"]) {
        const expected = oracle.get(name);
        const found = declaredSymbolMaturity(root, entry, name, "stable");
        const actual = found === undefined ? undefined : { maturity: found.maturity, deprecated: found.deprecated === true };
        if (JSON.stringify(actual) !== JSON.stringify(expected === undefined ? undefined : { maturity: expected.maturity, deprecated: expected.deprecated })) disagreements.push(`${name} in ${JSON.stringify(source)}: lookup ${JSON.stringify(actual)}, compiler ${JSON.stringify(expected)}`);
      }
    }
    expect(disagreements.slice(0, 10)).toEqual([]);
  }, 120_000);

  it("refuses to treat text that is not a doc comment as one", () => {
    for (const block of ["/* @experimental */", "/**/", "// @experimental", "@experimental", ""]) {
      expect(jsdocTags(block)).toEqual({ experimental: false, deprecated: false });
    }
  });
});

const builtCore = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("the shipped reader and the compiler agree on built Core", () => {
  it("returns the same maturity for every symbol of every subpath, in both directions", () => {
    expect(existsSync(join(builtCore, "dist/pricing/index.d.ts")), "build Core first: npm run build -w packages/core").toBe(true);
    const root = mkdtempSync(join(tmpdir(), "openlup-built-core-"));
    roots.push(root);
    const core = join(root, "node_modules/@openlup/core");
    // A copy, not a link: the lookup refuses linked declaration files.
    mkdirSync(core, { recursive: true });
    for (const name of ["package.json", "release-gates.json"]) cpSync(join(builtCore, name), join(core, name));
    cpSync(join(builtCore, "dist"), join(core, "dist"), { recursive: true, filter: (source) => !source.endsWith(".js") && !source.endsWith(".map") });
    const declarations = new Map<string, string>();
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".d.ts")) declarations.set(relative(core, path).split("\\").join("/"), readFileSync(path, "utf8"));
      }
    };
    walk(join(core, "dist"));
    const gates = JSON.parse(readFileSync(join(core, "release-gates.json"), "utf8")) as { packageSurface: Record<string, { maturity: string; entrypoint: string }> };
    const realRoot = realpathSync(core);
    const disagreements: string[] = [];
    let pairs = 0;
    for (const [subpath, contract] of Object.entries(gates.packageSurface)) {
      const entry = join(core, contract.entrypoint);
      const compiled = declaredSymbolMaturities(declarations, contract.entrypoint, contract.maturity);
      expect(compiled.unresolved, `${subpath} declares nothing outside the package`).toEqual([]);
      const read = (name: string) => {
        const found = declaredSymbolMaturity(core, entry, name, contract.maturity);
        return found === undefined ? undefined : { maturity: found.maturity, deprecated: found.deprecated === true };
      };
      // Compiler to shipped reader: every symbol the compiler exports.
      for (const [name, expected] of compiled.symbols) {
        pairs++;
        const actual = read(name);
        if (actual?.maturity !== expected.maturity || actual.deprecated !== expected.deprecated) disagreements.push(`${subpath} ${name}: shipped ${JSON.stringify(actual)}, compiler ${JSON.stringify(expected)}`);
      }
      // Shipped reader to compiler: every name the lookup would report as an export hit.
      for (const name of collectExportedSymbols(core, realRoot, entry)) {
        const expected = compiled.symbols.get(name);
        const actual = read(name);
        if (expected === undefined || actual?.maturity !== expected.maturity || actual.deprecated !== expected.deprecated) disagreements.push(`${subpath} ${name}: lookup lists it, compiler ${JSON.stringify(expected)}`);
      }
    }
    expect(pairs).toBeGreaterThan(100);
    expect(disagreements.slice(0, 10)).toEqual([]);
  }, 120_000);
});
