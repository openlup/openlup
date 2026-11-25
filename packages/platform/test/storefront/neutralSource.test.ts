import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

/**
 * The storefront source receives storage and serialization through host
 * bindings, so no file of the entry serializes a record or names a storage
 * entry. Parsing with the compiler, rather than matching text, leaves comments
 * out of the scan. Browser globals are refused separately by the entry's ESLint
 * rule.
 */
const STORAGE_NAME = /^[a-z0-9-]+(?::[a-z0-9-]+)+:v\d+$/i;
const directory = fileURLToPath(new URL("../../src/storefront/", import.meta.url));

function findings(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const at = (node: ts.Node) => `${fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "JSON") {
      found.push(`${at(node)} JSON.${node.name.text}`);
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "JSON") {
      found.push(`${at(node)} JSON[...]`);
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && STORAGE_NAME.test(node.text)) {
      found.push(`${at(node)} storage name ${JSON.stringify(node.text)}`);
    }
    if (ts.isTemplateExpression(node)) {
      // Each substitution stands for one name segment.
      const joined = node.head.text + node.templateSpans.map(span => `x${span.literal.text}`).join("");
      if (STORAGE_NAME.test(joined)) found.push(`${at(node)} storage name template ${JSON.stringify(joined)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

it("finds no serialization and no storage name in the storefront source", () => {
  const files = readdirSync(directory, { recursive: true, encoding: "utf8" }).filter(file => /\.(?:ts|tsx|js|mjs|cjs)$/.test(file)).sort();
  expect(files).toContain("index.ts");
  const found = files.flatMap(file => findings(file, readFileSync(join(directory, file), "utf8")));
  expect(found).toEqual([]);
});

it("reports each refused shape and ignores comments", () => {
  const probe = [
    "// JSON.stringify(record) under the name \"store:record:v1\" in a comment",
    "/** \"store:record:v1\" */",
    "const a = JSON.stringify({});",
    "const b = JSON[\"parse\"](\"{}\");",
    "const c = \"store:record:v1\";",
    "const d = `store:record:v12`;",
    "const e = `store:${a}:v1`;",
    "const f = \"data-openlup-action\";",
    "const g = \"store:record\";",
  ].join("\n");
  expect(findings("probe.ts", probe)).toEqual([
    "probe.ts:3 JSON.stringify",
    "probe.ts:4 JSON[...]",
    "probe.ts:5 storage name \"store:record:v1\"",
    "probe.ts:6 storage name \"store:record:v12\"",
    "probe.ts:7 storage name template \"store:x:v1\"",
  ]);
});
