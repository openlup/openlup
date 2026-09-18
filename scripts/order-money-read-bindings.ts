import ts from "typescript";

export type LexicalBinding = {
  key: string;
  scope: ts.Node;
  declaration: ts.Node;
  initializer: ts.Expression | null;
  returned: ts.Expression | null;
  parameterKeys: string[];
};
export type LexicalBindings = Map<string, LexicalBinding[]>;

export function buildLexicalBindings(source: ts.SourceFile): LexicalBindings {
  const bindings: LexicalBindings = new Map();
  visit(source, (node) => {
    if (ts.isVariableDeclaration(node)) {
      for (const name of bindingIdentifiers(node.name)) {
        const initializer = ts.isIdentifier(node.name) ? node.initializer ?? null : null;
        add(name, node, initializer, functionBodyExpression(initializer), functionParameters(initializer));
      }
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      add(node.name, node, null, node.body ? firstReturnExpression(node.body) : null, node.parameters);
    }
    if (isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        for (const name of bindingIdentifiers(parameter.name)) add(name, parameter, parameter.initializer ?? null, null);
      }
    }
  });
  return bindings;

  function add(name: ts.Identifier, declaration: ts.Node, initializer: ts.Expression | null,
    returned: ts.Expression | null, parameters: ts.NodeArray<ts.ParameterDeclaration> = ts.factory.createNodeArray()): void {
    const binding: LexicalBinding = {
      key: lexicalKey(source, name),
      scope: bindingScope(declaration),
      declaration,
      initializer,
      returned,
      parameterKeys: parameters.flatMap((parameter) =>
        bindingIdentifiers(parameter.name).map((identifier) => lexicalKey(source, identifier))),
    };
    const existing = bindings.get(name.text) ?? [];
    existing.push(binding);
    bindings.set(name.text, existing);
  }
}

export function resolveLexicalBinding(bindings: LexicalBindings, identifier: ts.Identifier): LexicalBinding | null {
  const candidates = (bindings.get(identifier.text) ?? []).filter((binding) =>
    contains(binding.scope, identifier) || binding.declaration === identifier.parent);
  let winner: LexicalBinding | null = null;
  let winnerDepth = -1;
  for (const candidate of candidates) {
    const depth = nodeDepth(candidate.scope);
    if (depth > winnerDepth || (depth === winnerDepth && candidate.declaration.getStart() >
      (winner?.declaration.getStart() ?? -1))) {
      winner = candidate;
      winnerDepth = depth;
    }
  }
  return winner;
}

export function lexicalBindingKey(source: ts.SourceFile, bindings: LexicalBindings,
  identifier: ts.Identifier): string {
  return resolveLexicalBinding(bindings, identifier)?.key ?? lexicalKey(source, identifier);
}

function bindingScope(declaration: ts.Node): ts.Node {
  if (ts.isParameter(declaration) && declaration.parent) return declaration.parent;
  let current = declaration.parent;
  while (current && !isScope(current)) current = current.parent;
  return current ?? declaration.getSourceFile();
}
function isScope(node: ts.Node): boolean {
  return ts.isSourceFile(node) || ts.isBlock(node) || isFunctionLike(node) || ts.isCatchClause(node)
    || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node);
}
function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node);
}
function contains(ancestor: ts.Node, node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}
function nodeDepth(node: ts.Node): number {
  let depth = 0;
  for (let current: ts.Node | undefined = node; current; current = current.parent) depth += 1;
  return depth;
}
function lexicalKey(source: ts.SourceFile, identifier: ts.Identifier): string {
  return `${source.fileName}:${identifier.getStart(source)}`;
}
function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name));
}
function functionBodyExpression(expression: ts.Expression | null): ts.Expression | null {
  if (!expression) return null;
  expression = unwrap(expression);
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return null;
  return ts.isBlock(expression.body) ? firstReturnExpression(expression.body) : expression.body;
}
function functionParameters(expression: ts.Expression | null): ts.NodeArray<ts.ParameterDeclaration> {
  if (!expression) return ts.factory.createNodeArray();
  expression = unwrap(expression);
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)
    ? expression.parameters : ts.factory.createNodeArray();
}
function firstReturnExpression(block: ts.Block): ts.Expression | null {
  for (const statement of block.statements) {
    if (ts.isReturnStatement(statement) && statement.expression) return statement.expression;
  }
  return null;
}
function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)) expression = expression.expression;
  return expression;
}
function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}
