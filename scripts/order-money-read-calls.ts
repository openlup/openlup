import ts from "typescript";

import { lexicalBindingKey, resolveLexicalBinding } from "./order-money-read-bindings.ts";
import { functionReturn, objectPropertyValue, resolveModule, staticText,
  type Project, type SourceUnit } from "./order-money-read-ast.ts";

export type ExpressionLocation = { expression: ts.Expression; unit: SourceUnit };
export type Substitutions = Map<string, ExpressionLocation>;
export type SelectInvocation = {
  argument: ts.Expression | null;
  node: ts.CallExpression;
  receiver: ts.Expression;
  substitutions: Substitutions;
  unit: SourceUnit;
};

export function resolveSelectInvocation(node: ts.CallExpression, unit: SourceUnit,
  project: Project): SelectInvocation | null {
  if (isMethodCall(node, "select")) {
    return { argument: node.arguments[0] ?? null, node, receiver: node.expression.expression,
      substitutions: new Map(), unit };
  }
  const returned = resolveCallReturn(node, unit, project);
  if (!returned) return null;
  const expression = unwrap(returned.expression);
  if (!ts.isCallExpression(expression) || !isMethodCall(expression, "select")) return null;
  const argument = expression.arguments[0] ?? null;
  const substitutions: Substitutions = new Map();
  returned.parameters.forEach((parameter, index) => {
    const supplied = node.arguments[index];
    if (supplied) substitutions.set(parameter, { expression: supplied, unit });
  });
  return { argument, node, receiver: expression.expression.expression,
    substitutions, unit: returned.unit };
}

export type CallableReturn = {
  expression: ts.Expression; parameters: string[]; unit: SourceUnit;
};

export function resolveCallReturn(call: ts.CallExpression, unit: SourceUnit,
  project: Project): CallableReturn | null {
  return resolveCallableReturn(call.expression, unit, project);
}

export function resolveCallableReturn(callable: ts.Expression, unit: SourceUnit,
  project: Project, seen = new Set<string>()): CallableReturn | null {
  callable = unwrap(callable);
  if (ts.isIdentifier(callable)) {
    const binding = resolveLexicalBinding(unit.bindings, callable);
    if (binding) {
      if (seen.has(binding.key)) return null;
      seen.add(binding.key);
      if (binding.returned) return { expression: binding.returned,
        parameters: binding.parameterKeys, unit };
      return binding.initializer
        ? resolveCallableReturn(binding.initializer, unit, project, seen) : null;
    }
    return functionReturn(unit, callable, project);
  }
  if (ts.isPropertyAccessExpression(callable) && ts.isIdentifier(callable.expression)) {
    const namespace = unit.imports.get(callable.expression.text);
    const target = namespace?.namespace && resolveModule(unit, namespace.modulePath, project);
    if (target) return functionReturn(target, target.exports.get(callable.name.text) ?? callable.name.text, project);
  }
  let value: ExpressionLocation | null = null;
  if (ts.isPropertyAccessExpression(callable)) {
    value = objectPropertyValue(callable.expression, callable.name.text, unit, project, new Set());
  } else if (ts.isElementAccessExpression(callable) && callable.argumentExpression) {
    const key = staticText(callable.argumentExpression, unit, project, new Set());
    if (key) value = objectPropertyValue(callable.expression, key, unit, project, new Set());
  }
  if (!value && ts.isPropertyAccessExpression(callable))
    return objectMethodReturn(callable.expression, callable.name.text, unit);
  if (!value) return null;
  const fn = unwrap(value.expression);
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))
    return resolveCallableReturn(fn, value.unit, project, seen);
  const returned = ts.isBlock(fn.body) ? firstReturn(fn.body) : fn.body;
  if (!returned) return null;
  return {
    expression: returned,
    parameters: fn.parameters.flatMap((parameter) => bindingIdentifiers(parameter.name)
      .map((identifier) => lexicalBindingKey(value.unit.source, value.unit.bindings, identifier))),
    unit: value.unit,
  };
}

function objectMethodReturn(receiver: ts.Expression, key: string, unit: SourceUnit): {
  expression: ts.Expression; parameters: string[]; unit: SourceUnit;
} | null {
  receiver = unwrap(receiver);
  if (ts.isIdentifier(receiver)) {
    const binding = resolveLexicalBinding(unit.bindings, receiver);
    if (!binding?.initializer) return null;
    receiver = unwrap(binding.initializer);
  }
  if (!ts.isObjectLiteralExpression(receiver)) return null;
  const method = receiver.properties.find((property): property is ts.MethodDeclaration =>
    ts.isMethodDeclaration(property) && propertyName(property.name) === key);
  const returned = method?.body && firstReturn(method.body);
  if (!method || !returned) return null;
  return {
    expression: returned,
    parameters: method.parameters.flatMap((parameter) => bindingIdentifiers(parameter.name)
      .map((identifier) => lexicalBindingKey(unit.source, unit.bindings, identifier))),
    unit,
  };
}

export function substitutedExpression(expression: ts.Expression, unit: SourceUnit,
  substitutions: Substitutions): ExpressionLocation {
  expression = unwrap(expression);
  if (!ts.isIdentifier(expression)) return { expression, unit };
  const key = lexicalBindingKey(unit.source, unit.bindings, expression);
  return substitutions.get(key) ?? { expression, unit };
}

function firstReturn(block: ts.Block): ts.Expression | null {
  for (const statement of block.statements) {
    if (ts.isReturnStatement(statement) && statement.expression) return statement.expression;
  }
  return null;
}
function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name));
}
function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : null;
}
function isMethodCall(node: ts.CallExpression, name: string): node is ts.CallExpression & {
  expression: ts.PropertyAccessExpression;
} {
  return ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === name;
}
function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)) expression = expression.expression;
  return expression;
}
