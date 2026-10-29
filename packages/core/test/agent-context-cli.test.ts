import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(directory, "AGENT_CONTEXT.md"), `# Installed context\n<!-- openlup-context ${JSON.stringify(metadata)} -->\n${excerpt}<!-- /openlup-context -->\n`);
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

  it("reports an empty search without claiming the public seam is absent", () => {
    const root = fixture();
    expect(searchContext(root, "unmatchedneedle").hits).toEqual([]);
    const cli = fileURLToPath(new URL("../src/agent-context-cli.ts", import.meta.url));
    const run = spawnSync(process.execPath, [cli, "search", "unmatchedneedle"], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
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
});
