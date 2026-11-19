import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { formatContextResult, searchContext } from "../src/agent-context-cli";

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
});
