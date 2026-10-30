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

  it("refuses mixed installed package versions before returning sources", () => {
    const root = fixture();
    install(root, "platform", "0.30.0");
    expect(() => searchContext(root, "retry")).toThrow(/Mixed @openlup/);
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

  it("returns a shared canonical excerpt once across installed packages", () => {
    const root = fixture();
    const excerpt = "## Idempotency\nRetry an outbox dispatch handler with one durable effect.\n";
    for (const [name, id] of [["outbox", "outbox-retry-dispatch-handler"], ["platform", "checkout-payment-idempotency"]]) {
      const directory = install(root, name);
      const metadata = { id, source: "docs/platform/CANONICAL_CONTRACTS.md", heading: "Idempotency", sha256: createHash("sha256").update(excerpt).digest("hex") };
      writeFileSync(join(directory, "AGENT_CONTEXT.md"), `# Installed context\n<!-- openlup-context-inventory ${JSON.stringify([metadata])} -->\n<!-- openlup-context ${JSON.stringify(metadata)} -->\n${excerpt}<!-- /openlup-context -->\n`);
    }
    const hits = searchContext(root, "outbox retry dispatch handler idempotency").hits;
    expect(hits.filter((hit) => hit.owner === "docs/platform/CANONICAL_CONTRACTS.md")).toHaveLength(1);
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

  it.each([["application", 2500], ["declaration", 1200]] as const)("bounds a flat %s directory", (kind, limit) => {
    const root = fixture();
    const directory = kind === "application" ? root : join(root, "node_modules/@openlup/core/dist");
    if (kind === "declaration") rmSync(join(directory, "subscription.d.ts"));
    for (let index = 0; index <= limit; index++) {
      writeFileSync(join(directory, `${String(index).padStart(4, "0")}.${kind === "application" ? "ts" : "d.ts"}`), index === limit ? "export const beyondBoundNeedle = 1;\n" : "export const unrelated = 1;\n");
    }
    expect(searchContext(root, "beyondBoundNeedle", kind === "application").hits).toEqual([]);
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
    expect(searchContext(root, "src/checkout.ts", false, true).hits[0]).toMatchObject({ file, start: 1, end: 1, reason: "exact installed source path" });
    const outside = join(root, "outside.ts");
    writeFileSync(outside, "export const outsidePackageNeedle = 1;\n");
    symlinkSync(outside, join(directory, "outside.ts"));
    expect(searchContext(root, "outsidePackageNeedle", false, true).hits).toEqual([]);
  });
});
