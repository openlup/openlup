import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// A consumer's view of the built declarations, compiled with no DOM and no Node
// types. A kernel declaration that names a host global fails here with TS2304,
// where a consumer without those libraries would otherwise fail or read `any`.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gates = JSON.parse(readFileSync(join(packageRoot, "release-gates.json"), "utf8")) as {
  packageSurface: Record<string, { entrypoint: string }>;
};
const entrypoints = Object.values(gates.packageSurface).map(({ entrypoint }) => join(packageRoot, entrypoint));

const base: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: false,
};
const hostless: ts.CompilerOptions = { ...base, lib: ["lib.es2022.d.ts"], types: [] };
const browser: ts.CompilerOptions = { ...base, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], types: [] };
const node: ts.CompilerOptions = { ...base, lib: ["lib.es2022.d.ts"], types: ["node"] };

function diagnostics(options: ts.CompilerOptions, roots: string[], sources: Record<string, string> = {}): string[] {
  const virtual = new Map(Object.entries(sources).map(([name, text]) => [join(packageRoot, name), text]));
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (file) => virtual.has(file) || fileExists.call(host, file);
  host.readFile = (file) => virtual.get(file) ?? readFile.call(host, file);
  host.getSourceFile = (file, language, ...rest) => {
    const text = virtual.get(file);
    return text === undefined
      ? getSourceFile.call(host, file, language, ...rest)
      : ts.createSourceFile(file, text, language);
  };
  const program = ts.createProgram([...roots, ...virtual.keys()], options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) =>
    `TS${diagnostic.code} ${diagnostic.file?.fileName.slice(packageRoot.length + 1) ?? ""}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
}

const consumer = [
  'import type { OutboxAbortSignal, OutboxHandler } from "./dist/outbox/index.js";',
  "declare const signal: AbortSignal;",
  "export const accepted: OutboxAbortSignal = signal;",
  "// A handler that forwards the signal may declare it as the host's AbortSignal.",
  "export const handler: OutboxHandler = {",
  '  eventType: "example.item.created",',
  "  timeoutMs: 1000,",
  "  async handle(_row, forwarded: AbortSignal) {",
  '    return forwarded.aborted ? { kind: "snooze", reason: "aborted" } : { kind: "processed" };',
  "  },",
  "};",
].join("\n");

describe("host-neutral declarations", () => {
  it("compiles every entrypoint's declarations without DOM or Node types", () => {
    expect(entrypoints).toHaveLength(Object.keys(gates.packageSurface).length);
    expect(diagnostics(hostless, entrypoints)).toEqual([]);
  });

  it("refuses a host global under the same options, so the check is live", () => {
    expect(diagnostics(hostless, [], { "hostGlobalProbe.ts": "export declare const signal: AbortSignal;" })).toEqual([
      "TS2304 hostGlobalProbe.ts: Cannot find name 'AbortSignal'.",
    ]);
  });

  it("accepts the browser's and Node's AbortSignal as the handler's signal", () => {
    expect(diagnostics(browser, [], { "browserConsumer.ts": consumer })).toEqual([]);
    expect(diagnostics(node, [], { "nodeConsumer.ts": consumer })).toEqual([]);
  });
});
