import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import ts from "typescript";

describe("Vercel function root TypeScript contract", () => {
  it("exposes the ES2022 library APIs used by serverless functions", () => {
    const repositoryRoot = process.cwd();
    const configPath = join(repositoryRoot, "tsconfig.json");
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    expect(config.error).toBeUndefined();

    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repositoryRoot);
    const scratchParent = join(repositoryRoot, ".context", "scratch");
    mkdirSync(scratchParent, { recursive: true });
    const scratch = mkdtempSync(join(scratchParent, "vercel-function-tsconfig-"));
    const probePath = join(scratch, "probe.ts");
    writeFileSync(probePath, [
      'const tail = ["last"].at(-1);',
      'const owns = Object.hasOwn({ key: "value" }, "key");',
      "void tail;",
      "void owns;",
      "",
    ].join("\n"));

    try {
      const configured = probeDiagnostics(probePath, parsed.options);
      expect(configured).toEqual([]);

      const importedReceiverRoot = "server/infra/stripe/stripeApiClient.ts";
      const rehearsalRoots = [
        "server/adapters/postgres/checkoutRecoveryOperations.ts",
        importedReceiverRoot,
        "server/adapters/stripe/stripeFailureEvidence.ts",
        "api/_cron/unsubscribeFunctionsBaseUrl.ts",
        "server/domains/platform/invoicePositionSnapshot.ts",
        "server/adapters/supabase/adminPromotionCodes.ts",
      ].map((relativePath) => join(repositoryRoot, relativePath));
      const rehearsalDiagnostics = diagnosticsFor(
        rehearsalRoots,
        parsed.options,
      );
      expect(rehearsalDiagnostics.filter(({ code }) => code === 2550)).toEqual([]);

      const withoutExplicitLibrary = probeDiagnostics(probePath, {
        ...parsed.options,
        lib: undefined,
      });
      expect(withoutExplicitLibrary.some((message) => message.includes("Property 'at'"))).toBe(true);
      expect(withoutExplicitLibrary.some((message) => message.includes("Property 'hasOwn'"))).toBe(true);
      const negativeDiagnostics = diagnosticsFor(rehearsalRoots, {
        ...parsed.options,
        lib: undefined,
      }).filter(({ code }) => code === 2550);
      expect(negativeDiagnostics.map(({ file }) => file).sort()).toEqual(
        rehearsalRoots.filter((file) => file !== join(repositoryRoot, importedReceiverRoot)).sort(),
      );
      expect(parsed.options.lib?.map((file) => basename(file)).sort()).toEqual([
        "lib.dom.d.ts",
        "lib.es2022.d.ts",
      ]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

function probeDiagnostics(probePath: string, options: ts.CompilerOptions): string[] {
  return diagnosticsFor(probePath, options)
    .filter(({ file }) => file === probePath)
    .map(({ message }) => message);
}

function diagnosticsFor(
  rootName: string | string[],
  options: ts.CompilerOptions,
): Array<{ code: number; file: string | null; message: string }> {
  const program = ts.createProgram({
    rootNames: Array.isArray(rootName) ? rootName : [rootName],
    options: {
      ...options,
      composite: false,
      incremental: false,
      module: options.module ?? ts.ModuleKind.NodeNext,
      moduleResolution: options.moduleResolution ?? ts.ModuleResolutionKind.NodeNext,
      // The API typecheck owns dependency resolution. This test compiles only
      // the observed files so it remains cheap inside the full Vitest shards.
      // Imported receiver types belong to the real API typecheck. Here each
      // direct API user is named explicitly, and the probe covers both APIs.
      noResolve: true,
      noEmit: true,
      target: options.target ?? ts.ScriptTarget.ES2021,
      tsBuildInfoFile: undefined,
    },
  });
  return ts.getPreEmitDiagnostics(program)
    .map((diagnostic) => ({
      code: diagnostic.code,
      file: diagnostic.file?.fileName ?? null,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    }));
}
