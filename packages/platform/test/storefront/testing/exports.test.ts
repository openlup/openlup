import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

/**
 * The one list of the storefront test-support entry's export names. A later
 * change that adds a name extends this constant; a released name is never
 * removed from it.
 */
const STOREFRONT_TESTING_EXPORTS = {
  StorefrontScenario: "type",
  StorefrontAdapter: "type",
  StorefrontObserver: "type",
  PageHandle: "type",
  createPageHandle: "value",
  serializeStorefrontVerdict: "value",
} as const satisfies Record<string, "type" | "value">;

const entryFile = fileURLToPath(new URL("../../../src/storefront/testing/index.ts", import.meta.url));
const names = (kind?: "type" | "value") =>
  (Object.keys(STOREFRONT_TESTING_EXPORTS) as Array<keyof typeof STOREFRONT_TESTING_EXPORTS>)
    .filter((name) => kind === undefined || STOREFRONT_TESTING_EXPORTS[name] === kind).sort();

function entryExports() {
  const program = ts.createProgram([entryFile], {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [],
  });
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(program.getSourceFile(entryFile)!);
  expect(module, "the testing entry is a module").toBeDefined();
  return { checker, exports: checker.getExportsOfModule(module!) };
}

it("exports exactly the six listed names (E1)", () => {
  expect(entryExports().exports.map((symbol) => symbol.getName()).sort()).toEqual(names());
});

it("tags every name experimental", () => {
  const { checker, exports } = entryExports();
  for (const symbol of exports) {
    const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const declarations = resolved.getDeclarations() ?? [];
    expect(declarations.some((declaration) => ts.getJSDocTags(declaration).some((tag) => tag.tagName.text === "experimental")), symbol.getName()).toBe(true);
  }
});

it("exposes runtime values only for the two functions", async () => {
  const entry = await import("../../../src/storefront/testing/index.js");
  expect(Object.keys(entry).sort()).toEqual(names("value"));
  for (const name of names("value")) expect(typeof entry[name]).toBe("function");
});
