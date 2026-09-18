import { existsSync, readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CYCLE_RETRY_CADENCE,
  ladderTerminatedByClass,
  nextRetryAttemptAt,
} from "../packages/core/src/subscription/cycleHardening.ts";
import {
  PAYMENT_FAILURE_CLASSES,
  failureClassDecision,
} from "../packages/core/src/payment/paymentFailureTaxonomyContracts.ts";

// The retry ladder is decided in TWO places and always will be: the portable
// kernel decides it for the engine, and the canonical apply body decides it
// inside the transaction that writes the cycle. Neither can call the other. The
// set of classes that end the ladder early is the newest thing they must agree
// on, and a set that agrees today and drifts tomorrow is worse than no set at
// all -- it would schedule a charge one half of the system has already ruled out.
//
// The cheapest honest mechanism is to READ the SQL literal rather than restate
// it: the migration is the deployed truth, the constant is the shipped one, and
// this file fails the moment they differ. It resolves the DECLARING migration by
// scanning for the latest one that declares the constant, so the wave that fills
// the set needs no edit here -- it simply becomes the file this test reads.
const MIGRATIONS_DIR = "supabase/migrations";
const DECLARATION = /^\s*v_terminating_classes\s+constant\s+text\[\]\s*:=\s*'(\{[^']*\})'\s*;/m;

function declaringMigration(): { file: string; classes: string[] } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .reverse();
  for (const file of files) {
    const match = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8").match(DECLARATION);
    if (match) return { file, classes: parseArrayLiteral(match[1]) };
  }
  throw new Error(`no migration in ${MIGRATIONS_DIR} declares v_terminating_classes`);
}

function parseArrayLiteral(literal: string): string[] {
  const inner = literal.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((value) => value.trim().replace(/^"(.*)"$/, "$1"));
}

const sqlSide = declaringMigration();
const kernelSide = [...(DEFAULT_CYCLE_RETRY_CADENCE.terminatingFailureClasses ?? [])];

const REQUIRED_CLASS_AWARE_CALLS = [
  "packages/core/src/subscription/subscriptionEnginePayment.ts",
  "server/domains/subscription/automaticRenewalExecution.ts",
  "server/domains/subscription/propagateSubscriptionCycleChargeFailure.ts",
] as const;

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (/^(?:__tests__|coverage|dist|fixtures|node_modules|test|tests)$/u.test(entry.name)) return [];
      return productionTypeScriptFiles(path);
    }
    if (!entry.isFile() || !/\.tsx?$/u.test(entry.name) || /\.(?:test|spec)\.tsx?$/u.test(entry.name)) return [];
    return [path];
  });
}

function retryCallSites(): Array<{ file: string; line: number; failureClassArg: string | null }> {
  const calls: Array<{ file: string; line: number; failureClassArg: string | null }> = [];
  const roots = ["packages", "server", "src", "api", "vercel", "mcp"]
    .filter(existsSync);
  // Every direct, aliased-import, or property-access call site still spells the
  // exported name somewhere in its own source file. Restricting the semantic
  // program to those candidates preserves symbol resolution while avoiding a
  // full-repository typecheck inside an already large impacted-test process.
  const files = roots.flatMap(productionTypeScriptFiles)
    .filter((file) => /\bnextRetryAttemptAt\b/u.test(readFileSync(file, "utf8")));
  // Use the same `core-source` export condition as the application build. The
  // root solution config has no module-resolution settings of its own; against
  // a fresh checkout with no ignored packages/core/dist output that makes the
  // facade imports below unresolved and silently hides their server call sites.
  const configPath = ts.findConfigFile(".", ts.sys.fileExists, "tsconfig.app.json");
  if (!configPath) throw new Error("cannot find the repository TypeScript configuration");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, ".");
  const program = ts.createProgram(files, {
    ...config.options,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const resolvedSymbol = (expression: ts.Expression): ts.Symbol | undefined => {
    const location = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    let symbol = checker.getSymbolAtLocation(location);
    const visited = new Set<ts.Symbol>();
    while (symbol && symbol.flags & ts.SymbolFlags.Alias && !visited.has(symbol)) {
      visited.add(symbol);
      symbol = checker.getAliasedSymbol(symbol);
    }
    return symbol;
  };
  const isCanonicalRetrySymbol = (symbol: ts.Symbol | undefined): boolean =>
    symbol?.getName() === "nextRetryAttemptAt"
    && (symbol.declarations?.some((declaration) =>
      /packages\/core\/(?:src|dist)\/subscription\/cycleHardening\.(?:ts|d\.ts)$/u
        .test(declaration.getSourceFile().fileName.replaceAll("\\", "/")),
    ) ?? false);

  for (const file of files) {
    if (file === "packages/core/src/subscription/cycleHardening.ts") continue;
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) throw new Error(`cannot load production TypeScript source ${file}`);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isCanonicalRetrySymbol(resolvedSymbol(node.expression))) {
        calls.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          failureClassArg: node.arguments[3]?.getText(sourceFile) ?? null,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return calls;
}

describe("the terminating set is one set with two spellings", () => {
  it("names the same classes in the migration and in the kernel", () => {
    expect([...sqlSide.classes].sort()).toEqual([...kernelSide].sort());
  });

  it("names only classes the taxonomy recognises", () => {
    for (const failureClass of sqlSide.classes) {
      expect(PAYMENT_FAILURE_CLASSES).toContain(failureClass);
    }
  });

  it("names only classes the decision table already refuses to retry", () => {
    // The list may not be the place a retry is first forbidden. If a class is
    // listed here but `retryAllowed` for it is still true, the two disagree
    // about the same instrument and the schedule is the wrong place to settle it.
    for (const failureClass of sqlSide.classes) {
      expect(failureClassDecision(failureClass as never).retryAllowed).toBe(false);
    }
  });

  it("threads the refusal class through every production retry call", () => {
    const calls = retryCallSites();
    expect(calls.map(({ file }) => file)).toEqual(expect.arrayContaining(REQUIRED_CLASS_AWARE_CALLS));
    expect(calls.filter(({ failureClassArg }) =>
      failureClassArg === null || failureClassArg === "null" || failureClassArg === "undefined",
    )).toEqual([]);
  });
});

describe("the guard fails open", () => {
  const failedAt = "2026-08-26T00:00:00.000Z";

  it("terminates nothing for an absent, unknown or unlisted class", () => {
    for (const failureClass of [null, undefined, "", "not_a_class_at_all"]) {
      expect(ladderTerminatedByClass(failureClass)).toBe(false);
      expect(nextRetryAttemptAt(failedAt, 1, DEFAULT_CYCLE_RETRY_CADENCE, failureClass)).toBe(
        nextRetryAttemptAt(failedAt, 1),
      );
    }
    for (const failureClass of PAYMENT_FAILURE_CLASSES) {
      if (sqlSide.classes.includes(failureClass)) continue;
      expect(ladderTerminatedByClass(failureClass)).toBe(false);
      expect(nextRetryAttemptAt(failedAt, 1, DEFAULT_CYCLE_RETRY_CADENCE, failureClass)).toBe(
        nextRetryAttemptAt(failedAt, 1),
      );
    }
  });

  it("ignores a listed class the taxonomy does not know", () => {
    // A typo in a deployment's own cadence must not silently stop charging a
    // customer, so an unrecognised member is inert rather than terminating.
    const typo = { ...DEFAULT_CYCLE_RETRY_CADENCE, terminatingFailureClasses: ["hrad_do_not_retry"] };
    expect(ladderTerminatedByClass("hrad_do_not_retry", typo)).toBe(false);
    expect(nextRetryAttemptAt(failedAt, 1, typo, "hrad_do_not_retry")).toBe(
      nextRetryAttemptAt(failedAt, 1),
    );
  });

  it("ignores a listed class the decision table still permits retrying", () => {
    const incoherent = {
      ...DEFAULT_CYCLE_RETRY_CADENCE,
      terminatingFailureClasses: ["soft_retryable"],
    };
    expect(failureClassDecision("soft_retryable").retryAllowed).toBe(true);
    expect(ladderTerminatedByClass("soft_retryable", incoherent)).toBe(false);
  });

  it("terminates a listed class the decision table refuses", () => {
    // The positive direction, proven against a LOCAL cadence rather than the
    // shipped one, so this assertion holds both before and after the wave that
    // fills the shipped set.
    const listed = {
      ...DEFAULT_CYCLE_RETRY_CADENCE,
      terminatingFailureClasses: ["hard_do_not_retry"],
    };
    expect(ladderTerminatedByClass("hard_do_not_retry", listed)).toBe(true);
    expect(nextRetryAttemptAt(failedAt, 1, listed, "hard_do_not_retry")).toBeNull();
    expect(nextRetryAttemptAt(failedAt, 1, listed, "soft_retryable")).not.toBeNull();
  });
});
