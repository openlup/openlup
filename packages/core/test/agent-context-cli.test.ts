import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { searchContext } from "../src/agent-context-cli";

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
  const excerpt = "## Retry policy\nUse nextRetryAttemptAt for the retry schedule.\n";
  const metadata = { id: "retry-policy", source: "packages/core/docs/SUBSCRIPTION_ENGINE.md", heading: "Retry policy", sha256: createHash("sha256").update(excerpt).digest("hex") };
  writeFileSync(join(directory, "AGENT_CONTEXT.md"), `# Installed context\n<!-- openlup-context-inventory ${JSON.stringify([metadata])} -->\n<!-- openlup-context ${JSON.stringify(metadata)} -->\n${excerpt}<!-- /openlup-context -->\n`);
  writeFileSync(join(directory, "dist", "subscription.d.ts"), "export declare function nextRetryAttemptAt(): number;\n");
  return directory;
}

function setSource(directory: string, source: string): void {
  const file = join(directory, "AGENT_CONTEXT.md");
  writeFileSync(file, readFileSync(file, "utf8").replaceAll(/"source":"[^"]+"/gu, `"source":${JSON.stringify(source)}`));
}

describe("installed agent context", () => {
  it("returns readable exact declaration and canonical excerpt spans offline", () => {
    const root = fixture();
    const result = searchContext(root, "nextRetryAttemptAt");
    expect(result.version).toBe("0.31.0");
    expect(result.packages).toEqual(["@openlup/core"]);
    const declaration = result.hits.find((hit) => hit.reason === "exact declaration symbol");
    expect(declaration).toBeDefined();
    expect(declaration?.start).toBe(1);
    const owner = result.hits.find((hit) => hit.owner);
    expect(owner?.owner).toBe("packages/core/docs/SUBSCRIPTION_ENGINE.md");
    for (const hit of result.hits) {
      const cited = readFileSync(hit.file, "utf8").split("\n").slice(hit.start - 1, hit.end).join("\n");
      expect(cited).toContain("nextRetryAttemptAt");
    }
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

  it("returns a matching guide page once when it is also a canonical excerpt owner", () => {
    const root = fixture();
    const directory = join(root, "node_modules/@openlup/core");
    mkdirSync(join(directory, "docs/guide"), { recursive: true });
    writeFileSync(join(directory, "docs/guide/retry.md"), "## Retry policy\nUse nextRetryAttemptAt for the retry schedule.\n");
    setSource(directory, "docs/guide/retry.md");
    const hits = searchContext(root, "retry schedule").hits;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ reason: "installed docs/guide/retry.md", file: join(directory, "docs/guide/retry.md") });
  });

  it("refuses mixed installed package versions before returning sources", () => {
    const root = fixture();
    install(root, "platform", "0.30.0");
    expect(() => searchContext(root, "retry")).toThrow(/Mixed @openlup/);
  });

  it("accepts its own installed-version repository URL and retains the offline excerpt citation", () => {
    const root = fixture();
    const source = "https://github.com/openlup/openlup/blob/openlup-core-v0.31.0/docs/platform/CANONICAL_CONTRACTS.md";
    setSource(join(root, "node_modules/@openlup/core"), source);
    const hit = searchContext(root, "nextRetryAttemptAt").hits.find(item => item.owner);
    expect(hit).toMatchObject({ owner: source, file: join(root, "node_modules/@openlup/core/AGENT_CONTEXT.md") });
    const excerpt = readFileSync(hit!.file, "utf8").split("\n").slice(hit!.start - 1, hit!.end).join("\n");
    expect(excerpt).toContain("nextRetryAttemptAt");
  });

  it.each([
    "https://github.com/openlup/openlup/blob/openlup-core-v0.30.0/docs/owner.md",
    "https://github.com/openlup/openlup/blob/openlup-platform-v0.31.0/docs/owner.md",
    "https://github.com/openlup/openlup/blob/main/docs/owner.md",
    "http://github.com/openlup/openlup/blob/openlup-core-v0.31.0/docs/owner.md",
    "https://example.invalid/openlup/openlup/blob/openlup-core-v0.31.0/docs/owner.md",
    "https://github.com/openlup/openlup/blob/openlup-core-v0.31.0/../owner.md",
    "https://github.com/openlup/openlup/blob/openlup-core-v0.31.0/%2e%2e/owner.md",
    "https://github.com/openlup/openlup/blob/openlup-core-v0.31.0//owner.md",
    "https://github.com/openlup/openlup/blob/openlup-core-v0.31.0/docs/owner.md#L1",
  ])("refuses an unbound or nonrelative repository source %s even for an unmatched query", source => {
    const root = fixture();
    setSource(join(root, "node_modules/@openlup/core"), source);
    expect(() => searchContext(root, "unmatchedneedle")).toThrow(/Invalid corpus source/);
  });

  it("searches the supported corpus when another same-version OpenLup package has none", () => {
    const root = fixture();
    const other = install(root, "ui");
    rmSync(join(other, "AGENT_CONTEXT.md"));
    expect(searchContext(root, "nextRetryAttemptAt").hits.some((hit) => hit.reason === "exact declaration symbol")).toBe(true);
  });

  it("routes retry questions to the packaged subscription engine owner", () => {
    const root = fixture();
    const docs = join(root, "node_modules/@openlup/core/docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "SUBSCRIPTION_ENGINE.md"), "# Subscription engine\n\n## The retry ladder terminates\nA failed cycle uses the dunning retry ladder and remains active.\n");
    const hit = searchContext(root, "retry ladder dunning").hits.find((item) => item.reason === "installed docs/SUBSCRIPTION_ENGINE.md");
    expect(hit).toMatchObject({ title: "The retry ladder terminates", start: 3, end: 5 });
  });

  it("returns disjoint Markdown sections and one installed source instead of its copied excerpt", () => {
    const root = fixture();
    const directory = join(root, "node_modules/@openlup/core");
    const excerpt = "## Parent\nGeneral guidance.\n\n### Child\nUnique checkout replay evidence.\n";
    const metadata = { id: "checkout-replay", source: "README.md", heading: "Parent", sha256: createHash("sha256").update(excerpt).digest("hex") };
    writeFileSync(join(directory, "README.md"), `# Guide\n\n${excerpt}\n## Other\nUnrelated.\n`);
    writeFileSync(join(directory, "AGENT_CONTEXT.md"), `# Installed context\n<!-- openlup-context-inventory ${JSON.stringify([metadata])} -->\n<!-- openlup-context ${JSON.stringify(metadata)} -->\n${excerpt}<!-- /openlup-context -->\n`);
    const hits = searchContext(root, "checkout replay evidence").hits;
    expect(hits.filter((hit) => hit.file === join(directory, "README.md")).map((hit) => hit.title)).toEqual(["Child"]);
    expect(hits.some((hit) => hit.file === join(directory, "AGENT_CONTEXT.md"))).toBe(false);
  });

  it.each([false, true])("returns a shared canonical excerpt once across installed packages (release URLs: %s)", releaseUrls => {
    const root = fixture();
    const excerpt = "## Idempotency\nRetry an outbox dispatch handler with one durable effect.\n";
    for (const [name, id] of [["outbox", "outbox-retry-dispatch-handler"], ["platform", "checkout-payment-idempotency"]]) {
      const directory = install(root, name);
      const source = releaseUrls ? `https://github.com/openlup/openlup/blob/openlup-${name}-v0.31.0/docs/platform/CANONICAL_CONTRACTS.md` : "docs/platform/CANONICAL_CONTRACTS.md";
      const metadata = { id, source, heading: "Idempotency", sha256: createHash("sha256").update(excerpt).digest("hex") };
      writeFileSync(join(directory, "AGENT_CONTEXT.md"), `# Installed context\n<!-- openlup-context-inventory ${JSON.stringify([metadata])} -->\n<!-- openlup-context ${JSON.stringify(metadata)} -->\n${excerpt}<!-- /openlup-context -->\n`);
    }
    const hits = searchContext(root, "outbox retry dispatch handler idempotency").hits;
    expect(hits.filter((hit) => hit.owner?.endsWith("docs/platform/CANONICAL_CONTRACTS.md"))).toHaveLength(1);
    expect(hits.find((hit) => hit.owner)?.owner).toBe(releaseUrls ? "https://github.com/openlup/openlup/blob/openlup-outbox-v0.31.0/docs/platform/CANONICAL_CONTRACTS.md" : "docs/platform/CANONICAL_CONTRACTS.md");
    expect(hits.find((hit) => hit.owner)?.packageName).toBe("@openlup/outbox");
  });

  it("refuses a lockfile that disagrees with installed bytes", () => {
    const root = fixture();
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/@openlup/core": { version: "0.30.0" } } }));
    expect(() => searchContext(root, "retry")).toThrow(/Lockfile and installed package disagree/);
  });

  it("checks corpus integrity even when the altered section does not match", () => {
    const root = fixture();
    const file = join(root, "node_modules/@openlup/core/AGENT_CONTEXT.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("retry schedule", "fabricated schedule"));
    expect(() => searchContext(root, "unmatchedneedle")).toThrow(/digest mismatch/);
  });

  it.each([
    (corpus: string) => corpus.replace('<!-- openlup-context {', '<!-- openlup-context BROKEN {'),
    (corpus: string) => corpus.replace(/<!-- openlup-context \{[^\n]*\} -->\n[\s\S]*?<!-- \/openlup-context -->\n/u, ''),
    (corpus: string) => corpus.replace('<!-- /openlup-context -->', '<!-- /openlup-context BROKEN -->'),
  ])("refuses malformed or missing sections for an unmatched query", (alter) => {
    const root = fixture();
    const file = join(root, "node_modules/@openlup/core/AGENT_CONTEXT.md");
    writeFileSync(file, alter(readFileSync(file, "utf8")));
    expect(() => searchContext(root, "unmatchedneedle")).toThrow(/corpus|context/);
  });

  it.each([["application", 2500], ["declarations", 1200], ["package-source", 1200]] as const)("reports bounded %s scans across directories", (scope, limit) => {
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
    rmSync(join(core, "dist"), { recursive: true });
    expect(searchContext(root, "someSymbol", false, true).scans).toEqual([]);
    mkdirSync(join(core, "dist"));
    mkdirSync(join(core, "src"));
    expect(searchContext(root, "someSymbol", true, true).scans).toEqual([
      { scope: "declarations", packageName: "@openlup/core", scannedFiles: 0, fileLimit: 1200, limitReached: false },
      { scope: "application", scannedFiles: 0, fileLimit: 2500, limitReached: false },
      { scope: "package-source", packageName: "@openlup/core", scannedFiles: 0, fileLimit: 1200, limitReached: false },
    ]);
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
