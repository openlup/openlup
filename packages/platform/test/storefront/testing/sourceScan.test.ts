import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

/**
 * The test-support source reaches the rest of the package only through the
 * storefront entry and the lifecycle entry; any other module, package or Node
 * built-in is refused (N1). Lint enforces the module graph, but it would admit
 * `../anchor.js`; this scan narrows the parent to its entry.
 */
const directory = fileURLToPath(new URL("../../../src/storefront/testing/", import.meta.url));
const ADMITTED = /^(?:\.\.\/index\.js|\.\.\/\.\.\/lifecycle\/index\.js|\.\/[A-Za-z0-9]+\.js)$/;

function specifiers(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const [argument] = node.arguments;
      found.push(argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) ? argument.text : "<computed>");
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) found.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

it("imports only the storefront entry, the lifecycle entry and its own directory (N1)", () => {
  const files = readdirSync(directory, { withFileTypes: true }).map((entry) => {
    expect(entry.isFile(), `${entry.name} is a file, not a subdirectory`).toBe(true);
    return entry.name;
  }).sort();
  expect(files).toContain("index.ts");
  const refused = files.flatMap((file) => specifiers(file, readFileSync(join(directory, file), "utf8"))
    .filter((specifier) => !ADMITTED.test(specifier)).map((specifier) => `${file}: ${specifier}`));
  expect(refused).toEqual([]);
});

it("refuses every other specifier form", () => {
  const probe = [
    "import { a } from \"../anchor.js\";",
    "import type { B } from \"../../kernel/index.js\";",
    "import { readFileSync } from \"node:fs\";",
    "import { z } from \"zod\";",
    "export * from \"../../lifecycle/storefrontVerdict.js\";",
    "const c = await import(\"./x.js\");",
    "const d = await import(name);",
    "type E = import(\"../bindings.js\").X;",
    "import { f } from \"../index.js\";",
    "import { g } from \"../../lifecycle/index.js\";",
    "import { h } from \"./contracts.js\";",
  ].join("\n");
  expect(specifiers("probe.ts", probe).filter((specifier) => !ADMITTED.test(specifier))).toEqual([
    "../anchor.js", "../../kernel/index.js", "node:fs", "zod", "../../lifecycle/storefrontVerdict.js", "<computed>", "../bindings.js",
  ]);
});
