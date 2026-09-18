import { dirname, join, normalize } from "node:path"; import ts from "typescript";
import { buildLexicalBindings, resolveLexicalBinding, type LexicalBindings } from "./order-money-read-bindings.ts";
export type GuardConfig = {
  schemaVersion: number; table: string;
  canonicalModuleSuffixes: string[]; canonicalSelectSymbols: string[]; canonicalReaderSymbols: string[];
  restrictedColumns: string[];
};
type ImportBinding = { imported: string; modulePath: string; namespace?: boolean };
export type SourceUnit = { relPath: string; source: ts.SourceFile; constants: Map<string, ts.Expression>;
  imports: Map<string, ImportBinding>; exports: Map<string, string>; bindings: LexicalBindings };
export type Project = { config: GuardConfig; files: Map<string, SourceUnit> }; export function parseUnit(relPath: string, source: ts.SourceFile): SourceUnit {
  const constants = new Map<string, ts.Expression>(), imports = new Map<string, ImportBinding>();
  const exports = new Map<string, string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const modulePath = statement.moduleSpecifier.text;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          imports.set(specifier.name.text, {
            imported: specifier.propertyName?.text ?? specifier.name.text,
            modulePath,
          });
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        imports.set(bindings.name.text, { imported: "*", modulePath, namespace: true });
      }
    }
    if (ts.isVariableStatement(statement)) {
      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        constants.set(declaration.name.text, declaration.initializer);
        if (exported) exports.set(declaration.name.text, declaration.name.text);
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      exports.set(statement.name.text, statement.name.text);
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const specifier of statement.exportClause.elements) {
        const localName = specifier.propertyName?.text ?? specifier.name.text;
        exports.set(specifier.name.text, localName);
        if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          imports.set(localName, { imported: localName, modulePath: statement.moduleSpecifier.text });
        }
      }
    }
  }
  return { relPath: normalize(relPath), source, constants, imports, exports, bindings: buildLexicalBindings(source) };
}
export function staticText(expression: ts.Expression, unit: SourceUnit, project: Project, seen: Set<string>): string | null {
  expression = unwrap(expression);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isIdentifier(expression)) {
    const binding = resolveLexicalBinding(unit.bindings, expression);
    const key = binding?.key ?? `${unit.relPath}:${expression.text}`;
    if (seen.has(key)) return null;
    seen.add(key);
    if (binding) return binding.initializer ? staticText(binding.initializer, unit, project, seen) : null;
    const imported = resolveImportedSymbol(unit, expression.text, project);
    return imported?.expression ? staticText(imported.expression, imported.unit, project, seen) : null;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const imported = ts.isIdentifier(expression.expression) && unit.imports.get(expression.expression.text);
    if (imported?.namespace) {
      const target = resolveModule(unit, imported.modulePath, project);
      const resolved = target && exportedExpression(target, expression.name.text);
      return resolved ? staticText(resolved, target, project, seen) : null;
    }
    const value = objectPropertyValue(expression.expression, expression.name.text, unit, project, seen);
    return value ? staticText(value.expression, value.unit, project, seen) : null;
  }
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    const key = staticText(expression.argumentExpression, unit, project, new Set(seen));
    const value = key && objectPropertyValue(expression.expression, key, unit, project, seen);
    return value ? staticText(value.expression, value.unit, project, seen) : null;
  }
  if (ts.isTemplateExpression(expression)) {
    let text = expression.head.text;
    for (const span of expression.templateSpans) {
      const value = staticText(span.expression, unit, project, new Set(seen));
      if (value === null) return null;
      text += value + span.literal.text;
    }
    return text;
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(expression.left, unit, project, new Set(seen));
    const right = staticText(expression.right, unit, project, new Set(seen));
    return left === null || right === null ? null : left + right;
  }
  return null;
}
export function functionReturn(unit: SourceUnit, localName: string | ts.Identifier, project: Project): {
  unit: SourceUnit; expression: ts.Expression; parameters: string[] } | null {
  if (typeof localName !== "string") {
    const binding = resolveLexicalBinding(unit.bindings, localName);
    if (binding) return binding.returned ? { unit, expression: binding.returned, parameters: binding.parameterKeys } : null;
  }
  const name = typeof localName === "string" ? localName : localName.text;
  const localBinding = unit.bindings.get(name)?.find((binding) => binding.scope === unit.source && binding.returned);
  if (localBinding?.returned) return { unit, expression: localBinding.returned, parameters: localBinding.parameterKeys };
  const imported = resolveImportedSymbol(unit, name, project);
  if (!imported) return null;
  const targetName = imported.unit.exports.get(unit.imports.get(name)?.imported ?? "");
  const targetBinding = targetName && imported.unit.bindings.get(targetName)
    ?.find((binding) => binding.scope === imported.unit.source && binding.returned);
  return targetBinding?.returned ? { unit: imported.unit, expression: targetBinding.returned,
    parameters: targetBinding.parameterKeys } : null;
}
export function expressionIsCanonicalSymbol(expression: ts.Expression, unit: SourceUnit,
  project: Project, allowed: Set<string>, seen: Set<string>): boolean {
  if (ts.isIdentifier(expression)) {
    const local = resolveLexicalBinding(unit.bindings, expression);
    const key = local?.key ?? `${unit.relPath}:${expression.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (local) return Boolean(local.initializer
      && expressionIsCanonicalSymbol(local.initializer, unit, project, allowed, seen));
    const binding = unit.imports.get(expression.text);
    if (binding && bindingIsCanonical(unit, binding, project)
      && allowed.has(binding.imported)) return true;
    const imported = resolveImportedSymbol(unit, expression.text, project);
    return Boolean(imported?.expression
      && expressionIsCanonicalSymbol(imported.expression, imported.unit, project, allowed, seen));
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const binding = unit.imports.get(expression.expression.text);
    if (binding?.namespace && bindingIsCanonical(unit, binding, project)
      && allowed.has(expression.name.text)) return true;
  }
  if (ts.isTemplateExpression(expression)) {
    return expression.templateSpans.some((span) =>
      expressionIsCanonicalSymbol(span.expression, unit, project, allowed, new Set(seen)));
  }
  if (ts.isBinaryExpression(expression)) {
    return expressionIsCanonicalSymbol(expression.left, unit, project, allowed, new Set(seen))
      || expressionIsCanonicalSymbol(expression.right, unit, project, allowed, new Set(seen));
  }
  return false;
}
export function importedModules(unit: SourceUnit, project: Project): SourceUnit[] {
  const targets = new Set<SourceUnit>();
  const pending = [unit];
  while (pending.length) {
    const current = pending.pop();
    if (!current) continue;
    for (const binding of current.imports.values()) {
      if (bindingIsCanonical(current, binding, project)) continue;
      const target = resolveModule(current, binding.modulePath, project);
      if (!target || target === unit || targets.has(target)) continue;
      targets.add(target);
      pending.push(target);
    }
  }
  return [...targets];
}
export function nestedRelationBody(text: string, table: string): string | null {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[:,\\s])${escaped}\\s*\\(`).exec(text);
  if (!match) return null;
  const open = text.indexOf("(", match.index);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    if (text[index] === ")" && --depth === 0) return text.slice(open + 1, index);
  }
  return text.slice(open + 1);
}
export function expressionMayContain(
  expression: ts.Expression,
  needle: string,
  unit: SourceUnit,
  project: Project,
): true | null {
  return mayContain(expression, needle, unit, project, new Set()) ? true : null;
}
function mayContain(
  expression: ts.Expression,
  needle: string,
  unit: SourceUnit,
  project: Project,
  seen: Set<string>,
): boolean {
  if (ts.isStringLiteralLike(expression)) return expression.text.includes(needle);
  if (ts.isIdentifier(expression)) {
    const binding = resolveLexicalBinding(unit.bindings, expression);
    const key = binding?.key ?? `${unit.relPath}:${expression.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (binding) return Boolean(binding.initializer
      && mayContain(binding.initializer, needle, unit, project, seen));
    const imported = resolveImportedSymbol(unit, expression.text, project);
    return Boolean(imported?.expression
      && mayContain(imported.expression, needle, imported.unit, project, seen));
  }
  if (ts.isTemplateExpression(expression)) {
    return expression.head.text.includes(needle)
      || expression.templateSpans.some((span) => span.literal.text.includes(needle)
        || mayContain(span.expression, needle, unit, project, new Set(seen)));
  }
  if (ts.isBinaryExpression(expression)) {
    return mayContain(expression.left, needle, unit, project, new Set(seen))
      || mayContain(expression.right, needle, unit, project, new Set(seen));
  }
  let found = false;
  ts.forEachChild(expression, (child) => {
    if (ts.isExpression(child) && mayContain(child, needle, unit, project, new Set(seen))) found = true;
  });
  return found;
}
export function resolveModule(unit: SourceUnit, modulePath: string, project: Project): SourceUnit | null {
  if (!modulePath.startsWith(".")) return null;
  const base = normalize(join(dirname(unit.relPath), modulePath));
  const noJs = base.replace(/\.[cm]?jsx?$/, "");
  const candidates = [base, `${noJs}.ts`, `${noJs}.tsx`, `${noJs}.js`, `${noJs}.mjs`, join(noJs, "index.ts")];
  for (const candidate of candidates) {
    const found = project.files.get(normalize(candidate));
    if (found) return found;
  }
  return null;
}
function resolveImportedSymbol(
  unit: SourceUnit,
  localName: string,
  project: Project,
): { unit: SourceUnit; expression: ts.Expression | null } | null {
  const binding = unit.imports.get(localName);
  if (!binding || binding.namespace) return null;
  const target = resolveModule(unit, binding.modulePath, project);
  if (!target) return null;
  return { unit: target, expression: exportedExpression(target, binding.imported) };
}
function exportedExpression(unit: SourceUnit, exportedName: string): ts.Expression | null {
  const localName = unit.exports.get(exportedName);
  return localName ? unit.constants.get(localName) ?? null : null;
}
export function objectPropertyValue(
  expression: ts.Expression,
  key: string,
  unit: SourceUnit,
  project: Project,
  seen: Set<string>,
): { unit: SourceUnit; expression: ts.Expression } | null {
  expression = unwrap(expression);
  if (ts.isIdentifier(expression)) {
    const local = resolveLexicalBinding(unit.bindings, expression);
    if (local) return local.initializer ? objectPropertyValue(local.initializer, key, unit, project, seen) : null;
    const imported = resolveImportedSymbol(unit, expression.text, project);
    return imported?.expression ? objectPropertyValue(imported.expression, key, imported.unit, project, seen) : null;
  }
  if (!ts.isObjectLiteralExpression(expression)) return null;
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyName(property.name);
    if (name === key) return { unit, expression: property.initializer };
  }
  return null;
}
function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : null;
}
function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)) expression = expression.expression;
  return expression;
}
function bindingIsCanonical(unit: SourceUnit, binding: ImportBinding, project: Project): boolean {
  if (project.config.canonicalModuleSuffixes.some((suffix) => binding.modulePath.endsWith(suffix))) return true;
  const target = resolveModule(unit, binding.modulePath, project);
  if (!target) return false;
  const targetStem = target.relPath.replace(/\.[cm]?[jt]sx?$/, "");
  return project.config.canonicalModuleSuffixes.some((suffix) =>
    targetStem.endsWith(suffix.replace(/\.[cm]?[jt]sx?$/, "")));
}
function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}
export function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node); ts.forEachChild(node, (child) => visit(child, callback));
}
