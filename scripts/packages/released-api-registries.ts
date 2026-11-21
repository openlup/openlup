import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const tag = "appendOnly";
const registries = [{
  name: "@openlup/platform",
  subpath: "@openlup/platform/catalog",
  symbol: "CATALOG_MIGRATIONS",
  file: "dist/catalog/sql.d.ts",
}];

export function isAppendOnlyRegistry(subpath: string, symbol: string): boolean {
  return registries.some(entry => entry.subpath === subpath && entry.symbol === symbol);
}

function appendOnlyTags(node: ts.Node) {
  return ts.getJSDocTags(node).filter(item => item.tagName.text === tag);
}

export function assertClosedRegistryTags(directory: string, name: string, version: string): void {
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.d\.[cm]?ts$/u.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name), text = readFileSync(path, "utf8");
    if (!text.includes(`@${tag}`)) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const seen = new Set<ts.JSDocTag>();
    const visit = (node: ts.Node) => {
      for (const comment of appendOnlyTags(node)) {
        if (seen.has(comment)) continue;
        seen.add(comment);
        const owner = comment.parent.parent;
        const binding = ts.isVariableStatement(owner) && owner.declarationList.declarations.length === 1
          && owner.declarationList.declarations[0]?.name;
        if (!binding || !registries.some(registry => registry.name === name && join(directory, registry.file) === path && registry.symbol === binding.getText(source))) {
          const line = source.getLineAndCharacterOfPosition(comment.getStart(source)).line + 1;
          throw new Error(`Released API ${name}@${version} — ${path.slice(directory.length + 1)}:${line}: @${tag} is reserved for ${registries.map(registry => `${registry.subpath} → ${registry.symbol}`).join(", ")}. Remove the tag from this declaration.`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

function elements(declaration: ts.Declaration | undefined) {
  const type = declaration && ts.isVariableDeclaration(declaration) && declaration.type;
  if (type && ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword && ts.isTupleTypeNode(type.type)) return type.type.elements;
}

export function appendOnlyChange(
  checker: ts.TypeChecker, released: ts.Declaration | undefined, candidate: ts.Declaration | undefined,
  releasedVersion: string, candidateVersion: string, migrationNotes: () => string[],
): string | undefined {
  const before = elements(released), after = elements(candidate);
  if (!before?.length || !after || !candidate || !appendOnlyTags(candidate).length) {
    return "must keep its tagged readonly tuple declaration";
  }
  const printer = ts.createPrinter();
  const print = (node: ts.Node) => printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile());
  for (const [index, entry] of before.entries()) {
    const next = after[index];
    const releasedType = checker.getTypeAtLocation(entry), candidateType = next && checker.getTypeAtLocation(next);
    if (!next || !candidateType || print(entry) !== print(next)
      || !checker.isTypeAssignableTo(candidateType, releasedType) || !checker.isTypeAssignableTo(releasedType, candidateType)) {
      return `changed or removed released entry at index ${index}; restore the exact released prefix`;
    }
  }

  const added = after.slice(before.length);
  if (!added.length) return undefined;
  const [major, minor] = releasedVersion.split(".").map(Number);
  const [targetMajor, targetMinor, targetPatch] = candidateVersion.split(".").map(Number);
  // Source PRs retain the published version until release preparation. A
  // fragment must explicitly assign an append in that tree to the next minor.
  const preBump = candidateVersion === releasedVersion;
  if (!preBump && (targetMajor !== major || targetMinor! <= minor! || targetPatch !== 0)) {
    return `appended entries in ${candidateVersion}; move the append to a minor release`;
  }
  const nextMinor = `${major}.${minor! + 1}.0`;
  const notes = migrationNotes().flatMap(note => note.split(/\r?\n/u));
  const migrationLines = notes.flatMap(line => {
    const match = /^\s*(?:-\s+)?Migration:\s*(.+)$/u.exec(line);
    return match ? [match[1]!] : [];
  });
  const idOf = (entry: ts.TypeNode) => {
    const id = checker.getTypeAtLocation(entry).getProperty("id");
    const type = id && checker.getTypeOfSymbol(id);
    return type?.isStringLiteral() ? type.value : undefined;
  };
  const ids = new Set(before.map(idOf));
  const fields = checker.getPropertiesOfType(checker.getTypeAtLocation(before[0]!));
  for (const entry of added) {
    const id = idOf(entry);
    if (!id || ids.has(id)) return "appended an entry without a fresh literal id";
    ids.add(id);
    const type = checker.getTypeAtLocation(entry);
    for (const field of fields) {
      const actual = type.getProperty(field.name);
      const expected = checker.getBaseTypeOfLiteralType(checker.getTypeOfSymbol(field));
      if (!actual || !checker.isTypeAssignableTo(checker.getTypeOfSymbol(actual), expected)) {
        return `appended ${id} with an incompatible ${field.name} field; keep the released entry shape`;
      }
    }
    const target = `In ${nextMinor}, `;
    const named = migrationLines.some(line => {
      if (preBump && !line.startsWith(target)) return false;
      const description = preBump ? line.slice(target.length) : line;
      return description.match(/[\w-]+/gu)?.includes(id);
    });
    if (!named) return `appended ${id} without a Migration: line naming it${preBump ? ` and starting with In ${nextMinor}, to target the next minor before the version bump` : ""}`;
  }
}
