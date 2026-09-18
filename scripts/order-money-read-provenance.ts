import ts from "typescript";

import { lexicalBindingKey, resolveLexicalBinding } from "./order-money-read-bindings.ts";
import { resolveCallableReturn } from "./order-money-read-calls.ts";
import { expressionIsCanonicalSymbol, functionReturn, visit, type Project, type SourceUnit } from "./order-money-read-ast.ts";

type QueryPredicate = (expression: ts.Expression, unit: SourceUnit, project: Project,
  aliases: Set<string>) => boolean;

export function collectItemProvenance(unit: SourceUnit, project: Project, queries: Set<string>,
  isCommerceQuery: QueryPredicate): {
    origins: Map<string, Set<string>>; importedCallbacks: string[];
  } {
  const origins = new Map<string, Set<string>>();
  const collections = new Set<string>();
  const rows = new Set<string>();
  const callbacks = new Map<string, Set<string>>();
  const functionQueryCache = new Map<string, Set<string>>();
  let changed = true;
  while (changed) {
    changed = false;
    visit(unit.source, (node) => {
      if (!ts.isVariableDeclaration(node) || !node.initializer) return;
      const tokens = expressionOrigins(node.initializer);
      if (ts.isIdentifier(node.name)) {
        const key = identifierKey(node.name);
        if (mergeOrigins(key, tokens)) changed = true;
        mark(key, node.initializer, "collection");
        mark(key, node.initializer, "row");
      } else if (ts.isObjectBindingPattern(node.name) && tokens.size > 0) {
        for (const element of node.name.elements) {
          if (bindingName(element) === "data" && ts.isIdentifier(element.name)) {
            const key = identifierKey(element.name);
            mergeOrigins(key, tokens);
            if (!collections.has(key)) { collections.add(key); changed = true; }
          }
        }
      } else if (ts.isArrayBindingPattern(node.name) && isItemCollection(node.initializer)) {
        for (const element of node.name.elements) {
          if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
            const key = identifierKey(element.name);
            mergeOrigins(key, tokens);
            if (!rows.has(key)) { rows.add(key); changed = true; }
          }
        }
      }
    });
  }
  visit(unit.source, (node) => {
    if (ts.isForOfStatement(node) && isItemCollection(node.expression)
      && ts.isVariableDeclarationList(node.initializer)) {
      for (const declaration of node.initializer.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          const key = identifierKey(declaration.name);
          mergeOrigins(key, expressionOrigins(node.expression)); rows.add(key);
        }
      }
    }
    if (!ts.isCallExpression(node)) return;
    if (ts.isPropertyAccessExpression(node.expression)
      && ["map", "flatMap", "filter", "find", "forEach", "reduce", "then"].includes(node.expression.name.text)
      && isItemCollection(node.expression.expression)) {
      const callback = node.arguments[0];
      const tokens = expressionOrigins(node.expression.expression);
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const parameter = callback.parameters[0]?.name;
        if (parameter) {
          if (node.expression.name.text === "then") bindQueryResult(parameter, tokens);
          else bindRow(parameter, tokens);
        }
      } else if (callback && ts.isIdentifier(callback)
        && !resolveLexicalBinding(unit.bindings, callback) && unit.imports.has(callback.text)) {
        callbacks.set(callback.text, mergeSets(callbacks.get(callback.text), tokens));
      } else if (callback) {
        const callable = resolveCallableReturn(callback, unit, project);
        const parameter = callable?.unit === unit ? callable.parameters[0] : null;
        if (parameter) { mergeOrigins(parameter, tokens); rows.add(parameter); }
      }
    }
    propagateCallArguments(node);
  });
  return { origins: new Map([...origins].filter(([name]) => rows.has(name))),
    importedCallbacks: [...callbacks.keys()] };

  function mark(name: string, expression: ts.Expression, kind: "collection" | "row"): void {
    const matches = kind === "collection" ? isItemCollection(expression) : isItemRow(expression);
    const targets = kind === "collection" ? collections : rows;
    if (matches && !targets.has(name)) { targets.add(name); changed = true; }
  }
  function isItemCollection(expression: ts.Expression): boolean {
    expression = unwrapAwait(expression);
    if (ts.isIdentifier(expression)) return collections.has(identifierKey(expression));
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === "data")
      return expressionOrigins(expression).size > 0;
    if (!ts.isCallExpression(expression)) return false;
    if (ts.isPropertyAccessExpression(expression.expression)
      && ["map", "flatMap", "filter"].includes(expression.expression.name.text))
      return expressionOrigins(expression.expression.expression).size > 0;
    return expressionOrigins(expression).size > 0;
  }
  function isItemRow(expression: ts.Expression): boolean {
    expression = unwrap(expression);
    return ts.isElementAccessExpression(expression) && isItemCollection(expression.expression);
  }
  function expressionOrigins(expression: ts.Expression): Set<string> {
    expression = unwrapAwait(expression);
    if (ts.isIdentifier(expression)) return new Set(origins.get(identifierKey(expression)) ?? []);
    if (ts.isCallExpression(expression) && expressionIsCanonicalSymbol(expression.expression,
      unit, project, new Set(project.config.canonicalReaderSymbols), new Set())) return new Set();
    if (isCommerceQuery(expression, unit, project, queries)) return new Set([queryToken(expression, unit)]);
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
      const functionOrigins = functionQueryOrigins(expression.expression);
      if (functionOrigins.size > 0) return functionOrigins;
    }
    const found = new Set<string>();
    ts.forEachChild(expression, (child) => {
      if (ts.isExpression(child)) addAll(found, expressionOrigins(child));
    });
    return found;
  }
  function queryToken(expression: ts.Expression, sourceUnit: SourceUnit): string {
    return `query:${sourceUnit.relPath}:${expression.getStart(sourceUnit.source)}`;
  }
  function functionQueryOrigins(identifier: ts.Identifier): Set<string> {
    const returned = functionReturn(unit, identifier, project);
    if (!returned) return new Set();
    const scope = enclosingFunction(returned.expression);
    if (!scope) return new Set();
    const token = `function:${returned.unit.relPath}:${scope.getStart(returned.unit.source)}`;
    const cached = functionQueryCache.get(token);
    if (cached) return new Set(cached);
    const found = new Set<string>();
    visit(scope, (node) => {
      if (!isMethodCall(node, "select") || enclosingFunction(node) !== scope) return;
      if (isCommerceQuery(node.expression.expression, returned.unit, project, queries))
        found.add(queryToken(node, returned.unit));
    });
    functionQueryCache.set(token, found);
    return new Set(found);
  }
  function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
    for (let parent: ts.Node | undefined = node; parent; parent = parent.parent) {
      if (ts.isFunctionDeclaration(parent) || ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)
        || ts.isMethodDeclaration(parent)) return parent;
    }
    return null;
  }
  function propagateCallArguments(call: ts.CallExpression): void {
    const callable = resolveCallableReturn(call.expression, unit, project);
    if (!callable || callable.unit !== unit) return;
    callable.parameters.forEach((parameter, index) => {
      const argument = call.arguments[index];
      if (!argument) return;
      const tokens = expressionOrigins(argument);
      if (tokens.size > 0) { mergeOrigins(parameter, tokens); rows.add(parameter); }
    });
  }
  function bindRow(name: ts.BindingName, tokens: Set<string>): void {
    for (const identifier of bindingIdentifiers(name)) {
      const key = identifierKey(identifier); mergeOrigins(key, tokens); rows.add(key);
    }
  }
  function bindQueryResult(name: ts.BindingName, tokens: Set<string>): void {
    if (ts.isIdentifier(name)) {
      mergeOrigins(identifierKey(name), tokens);
      return;
    }
    if (!ts.isObjectBindingPattern(name)) return;
    for (const element of name.elements) {
      if (bindingName(element) !== "data" || !ts.isIdentifier(element.name)) continue;
      const key = identifierKey(element.name); mergeOrigins(key, tokens); collections.add(key);
    }
  }
  function mergeOrigins(name: string, tokens: Set<string>): boolean {
    const current = origins.get(name) ?? new Set<string>();
    const before = current.size;
    addAll(current, tokens); origins.set(name, current);
    return current.size !== before;
  }
  function identifierKey(identifier: ts.Identifier): string {
    return lexicalBindingKey(unit.source, unit.bindings, identifier);
  }
}

export function restrictedAccessOrigins(node: ts.Node, origins: Map<string, Set<string>>, unit: SourceUnit): Set<string> {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const root = rootIdentifier(node.expression);
    return new Set(root ? origins.get(lexicalBindingKey(unit.source, unit.bindings, root)) ?? [] : []);
  }
  if (!ts.isBindingElement(node)) return new Set();
  if (ts.isIdentifier(node.name))
    return new Set(origins.get(lexicalBindingKey(unit.source, unit.bindings, node.name)) ?? []);
  const declaration = node.parent.parent;
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return new Set();
  const root = rootIdentifier(declaration.initializer);
  return new Set(root ? origins.get(lexicalBindingKey(unit.source, unit.bindings, root)) ?? [] : []);
}

function rootIdentifier(expression: ts.Expression): ts.Identifier | null {
  expression = unwrap(expression);
  while (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
    expression = unwrap(expression.expression);
  return ts.isIdentifier(expression) ? expression : null;
}
function isMethodCall(node: ts.Node, name: string): node is ts.CallExpression & {
  expression: ts.PropertyAccessExpression;
} {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === name;
}
function bindingName(element: ts.BindingElement): string | null {
  const name = element.propertyName ?? element.name;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
}
function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name));
}
function unwrapAwait(expression: ts.Expression): ts.Expression {
  expression = unwrap(expression);
  return ts.isAwaitExpression(expression) ? unwrap(expression.expression) : expression;
}
function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)) expression = expression.expression;
  return expression;
}
function addAll(target: Set<string>, source: Set<string>): void {
  for (const value of source) target.add(value);
}
function mergeSets(left: Set<string> | undefined, right: Set<string>): Set<string> {
  const result = new Set(left ?? []); addAll(result, right); return result;
}
