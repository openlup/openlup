import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import ts from "typescript";
import { assertAgentGuide } from "../scripts/documentation-contract.ts";

const root = fileURLToPath(new URL("../../platform", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const gates = JSON.parse(readFileSync(join(root, "release-gates.json"), "utf8"));

it("ships a guide with the exact release-gate maturity table and compiled wiring example", () => {
  const violations: string[] = [];
  expect(manifest.files).toContain("AGENTS.md");
  assertAgentGuide(root, gates.kind, manifest.exports, gates.packageSurface, new Set(["AGENTS.md"]), violations, "test/agentsWiringExample.ts");
  expect(violations).toEqual([]);
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
  const violations: string[] = [];
  const surface = { ...gates.packageSurface, "./http": { ...gates.packageSurface["./http"], maturity: "candidate" } };
  assertAgentGuide(root, gates.kind, manifest.exports, surface, new Set(["AGENTS.md"]), violations, "test/agentsWiringExample.ts");
  expect(violations).toContain("AGENTS.md: maturity row differs from release gates for ./http");
});
