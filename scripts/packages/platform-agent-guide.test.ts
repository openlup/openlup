import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import ts from "typescript";

const root = fileURLToPath(new URL("../../packages/platform", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const gates = JSON.parse(readFileSync(join(root, "release-gates.json"), "utf8"));
const checker = fileURLToPath(new URL("../../packages/core/scripts/documentation-contract.ts", import.meta.url));

function checkGuide(packageRoot: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", checker, "--agent-guide", packageRoot, "test/agentsWiringExample.ts"], {
    encoding: "utf8", timeout: 15_000,
  });
}

it("ships a guide with the exact release-gate maturity table and compiled wiring example", () => {
  expect(manifest.files).toContain("AGENTS.md");
  const result = checkGuide(root);
  expect(result.status, result.stderr).toBe(0);
  const example = readFileSync(join(root, "test/agentsWiringExample.ts"), "utf8");
  expect(readFileSync(join(root, "README.md"), "utf8")).toContain("```ts\n" + example + "```");
  const program = ts.createProgram([join(root, "test/agentsWiringExample.ts")], {
    noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: ["node"],
  });
  expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
});

it("refuses a guide whose maturity differs from its release gates", () => {
  const fixture = mkdtempSync(join(tmpdir(), "platform-agent-guide-"));
  try {
    for (const file of ["package.json", "release-gates.json", "AGENTS.md", "test/agentsWiringExample.ts"]) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true });
      cpSync(join(root, file), join(fixture, file));
    }
    const changed = { ...gates, packageSurface: { ...gates.packageSurface, "./http": { ...gates.packageSurface["./http"], maturity: "candidate" } } };
    writeFileSync(join(fixture, "release-gates.json"), JSON.stringify(changed));
    const result = checkGuide(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AGENTS.md: maturity row differs from release gates for ./http");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
