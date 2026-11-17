import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("types shared tooling without inventing inventory fields or required sweep fields", () => {
  const root = process.cwd();
  const parent = join(root, ".context/scratch");
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(join(parent, "tooling-types-"));
  const imports = [
    `import { currentRunId, disposableLabelArgs, parseOwnerStart, ownerStart, classify, sweep, type DisposableSweepRecord } from ${JSON.stringify(resolve("scripts/disposable-docker.mjs"))};`,
    `import { INVENTORY_PATH, MIGRATION_REGISTRIES, inventoryEnvelope, inventoryOnlyCurrent, migrationRegistryUnion } from ${JSON.stringify(resolve("scripts/agent-review-derived.mjs"))};`,
  ];
  const valid = [
    ...imports,
    "const run: string | undefined = currentRunId();",
    "const labels: string[] = disposableLabelArgs({ run });",
    "const start: number = parseOwnerStart('Thu Jan 1 00:00:00 2037');",
    "const observed: number = await ownerStart(123, { PATH: '/bin' }, 1000);",
    "const verdict = classify(null, { platform: 'darwin', hostname: () => 'fixture', kill: () => undefined, ps: () => '' }, 0);",
    "const decision: 'keep' | 'dead' = verdict.decision;",
    "const unidentified: DisposableSweepRecord = { decision: 'keep', reason: 'unavailable' };",
    "const failedRemoval: DisposableSweepRecord = { decision: 'dead', reason: 'docker_remove_failed_or_timeout', action: 'keep' };",
    "for (const row of await sweep({ mode: 'report', budgetMs: 1000 })) {",
    "  const reason: string = row.reason;",
    "  if (row.id !== undefined) { const id: string = row.id; }",
    "  if (row.action !== undefined) { const action: 'keep' | 'would_remove' | 'removed' = row.action; }",
    "}",
    "const source = '{\"current\":{},\"historical\":null}';",
    "const envelope = inventoryEnvelope(source);",
    "const current: Record<string, unknown> = envelope.value.current;",
    "const historical: unknown = envelope.value.historical;",
    "const boundary: string = envelope.before + envelope.after;",
    "const onlyCurrent: boolean = inventoryOnlyCurrent(source, source, source, source);",
    "const union: string = migrationRegistryUnion(MIGRATION_REGISTRIES[0], source, source, source, source);",
    "const path: string = INVENTORY_PATH;",
  ];
  // These are compiler inputs, never executed or used to start/remove resources.
  const invalid = [
    ...imports,
    "const run: string = currentRunId();",
    "disposableLabelArgs({ run: 123 });",
    "parseOwnerStart(123);",
    "ownerStart(123, { PATH: 123 });",
    "sweep({ mode: 'destroy' });",
    "const id: string = (await sweep())[0].id;",
    "const action: string = (await sweep())[0].action;",
    "inventoryEnvelope(123);",
    "inventoryOnlyCurrent('', '', '');",
    "migrationRegistryUnion(INVENTORY_PATH, '', '', '', 123);",
    "const flag: number = inventoryOnlyCurrent('', '', '', '');",
    "const profiles: { legacy: { objectInventorySha256: string } } = inventoryEnvelope('{}').value.current.profiles;",
    "const history: unknown[] = inventoryEnvelope('{}').value.historical;",
  ];
  const validPath = join(scratch, "valid.mts"), invalidPath = join(scratch, "invalid.mts");
  writeFileSync(validPath, valid.join("\n"));
  writeFileSync(invalidPath, invalid.join("\n"));
  try {
    const program = ts.createProgram([validPath, invalidPath], {
      strict: true, noEmit: true,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: ["node"], typeRoots: [join(root, "node_modules/@types")],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const format = (item: ts.Diagnostic) => ts.flattenDiagnosticMessageText(item.messageText, "\n");
    expect(diagnostics.filter(item => item.file?.fileName !== invalidPath).map(format)).toEqual([]);
    const rejectedLines = new Set(diagnostics.map(item => {
      if (!item.file || item.start === undefined) throw new Error("Compiler refusal needs a source position");
      return item.file.getLineAndCharacterOfPosition(item.start).line;
    }));
    expect(rejectedLines).toEqual(new Set(invalid.slice(imports.length).map((_, index) => index + imports.length)));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
