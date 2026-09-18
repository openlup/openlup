import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";

const CATALOG = "config/oss-core-readiness-blockers.json";
const SOURCE_IMPORTER_REASON = "Source-repository tests, operators and deployment composition that depend on withheld control-plane modules are not part of the standalone framework runtime.";
type JsonObject = Record<string, unknown>;
type WithholdGroup = { id: string; reason: string; paths: string[] };
export type OpaqueSourceDependencyEdges = Record<string, { sourceDigest: string; edges: readonly string[] }>;
export type Delta = { flattenPrefix: string; publishAs: string; withhold: string[]; withholdPrefixes: string[]; withholdPrefixOverlap: string[]; withholdReasons: Record<string, string>; sourceImporterWithholds: string[]; opaqueSourceDependencyEdges: OpaqueSourceDependencyEdges; signedResidue: { calls: number; hosts: number } };

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const sourceStrings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function sortedPaths(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) throw new Error(`${label}: expected a string array`);
  const paths = value as string[];
  if (new Set(paths).size !== paths.length || JSON.stringify(paths) !== JSON.stringify([...paths].sort())) throw new Error(`${label}: paths must be sorted and unique`);
  for (const path of paths) if (path.startsWith("/") || path.includes("\\") || path === "." || path.startsWith("../") || posix.normalize(path) !== path) throw new Error(`${label}: invalid repository-relative path ${path}`);
  return paths;
}

function readWithholdGroups(value: unknown): WithholdGroup[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${CATALOG}: publicationDelta.withholdGroups must be an array`);
  const groups = value.map((row, index): WithholdGroup => {
    if (!isObject(row) || typeof row.id !== "string" || row.id === "" || typeof row.reason !== "string" || row.reason.trim() === "") throw new Error(`${CATALOG}: publicationDelta.withholdGroups[${index}] is incomplete`);
    return { id: row.id, reason: row.reason, paths: sortedPaths(row.paths, `${CATALOG}: publicationDelta.withholdGroups[${index}].paths`) };
  });
  const ids = groups.map(({ id }) => id);
  if (new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify([...ids].sort())) throw new Error(`${CATALOG}: publicationDelta.withholdGroups ids must be sorted and unique`);
  return groups;
}

function readOpaqueSourceDependencyEdges(value: unknown): OpaqueSourceDependencyEdges {
  if (value === undefined) return {};
  const input = Array.isArray(value) ? value : isObject(value) ? Object.entries(value).map(([path, entry]) => ({ path, ...(isObject(entry) ? entry : {}) })) : null; if (!input) throw new Error(`${CATALOG}: publicationDelta.opaqueSourceDependencyEdges must be an array or parsed map`);
  const rows = input.map((item, index) => { if (!isObject(item) || typeof item.path !== "string" || item.path === "" || !/^sha256-[a-f0-9]{64}$/u.test(String(item.sourceDigest)) || !Array.isArray(item.edges) || item.edges.some((edge) => typeof edge !== "string" || edge === "")) throw new Error(`${CATALOG}: publicationDelta.opaqueSourceDependencyEdges[${index}] is invalid`); const edges = item.edges as string[]; if (new Set(edges).size !== edges.length || JSON.stringify(edges) !== JSON.stringify([...edges].sort())) throw new Error(`${CATALOG}: opaque dependency edges must be sorted and unique`); return { path: item.path, sourceDigest: String(item.sourceDigest), edges }; });
  const paths = rows.map(({ path }) => path); if (new Set(paths).size !== paths.length || JSON.stringify(paths) !== JSON.stringify([...paths].sort())) throw new Error(`${CATALOG}: opaque dependency paths must be sorted and unique`);
  return Object.fromEntries(rows.map(({ path, sourceDigest, edges }) => [path, { sourceDigest, edges }]));
}

export function readDelta(catalog: { publicationDelta?: unknown }): Delta {
  const raw = (catalog.publicationDelta ?? {}) as JsonObject; const residue = (raw.signedResidue ?? {}) as JsonObject; const groups = readWithholdGroups(raw.withholdGroups); const adopter = isObject(raw.adopterSurfaceWithholds) ? raw.adopterSurfaceWithholds : {}; const adopterReason = typeof adopter.reason === "string" && adopter.reason.trim() !== "" ? adopter.reason : ""; const runtimeTests = isObject(raw.adopterRuntimeTestWithholds) ? raw.adopterRuntimeTestWithholds : {}; const runtimeTestReason = typeof runtimeTests.reason === "string" && runtimeTests.reason.trim() !== "" ? runtimeTests.reason : "";
  const adopterPaths = sortedPaths(adopter.paths ?? [], `${CATALOG}: publicationDelta.adopterSurfaceWithholds.paths`); const runtimeTestPaths = sortedPaths(runtimeTests.paths ?? [], `${CATALOG}: publicationDelta.adopterRuntimeTestWithholds.paths`); const adopterPrefixes = sortedPaths(adopter.prefixes ?? [], `${CATALOG}: publicationDelta.adopterSurfaceWithholds.prefixes`); const sourceImporterWithholds = sortedPaths([...new Set([...sourceStrings(raw.sourceImporterWithholds), ...sourceStrings(adopter.importerPaths)])].sort(), `${CATALOG}: publicationDelta.sourceImporterWithholds`);
  if (((adopterPaths.length + adopterPrefixes.length > 0) && adopterReason === "") || (runtimeTestPaths.length > 0 && runtimeTestReason === "")) throw new Error(`${CATALOG}: publicationDelta adopter withhold reason is required`);
  const directWithhold = sourceStrings(raw.withhold); const groupedWithhold = [...groups.flatMap(({ paths }) => paths), ...adopterPaths, ...runtimeTestPaths, ...sourceImporterWithholds]; const withhold = [...directWithhold, ...groupedWithhold].sort(); const withholdPrefixes = [...sourceStrings(raw.withholdPrefixes), ...adopterPrefixes].sort(); const withholdPrefixOverlap = sortedPaths(raw.withholdPrefixOverlap ?? [], `${CATALOG}: publicationDelta.withholdPrefixOverlap`);
  if (new Set(withhold).size !== withhold.length) throw new Error(`${CATALOG}: exact withhold paths overlap across direct/group declarations`);
  const reasonMaps = [raw.withholdReason, raw.withholdPrefixReason, raw.withholdReasons].filter(isObject); const withholdReasons = Object.fromEntries([...reasonMaps.flatMap((map) => Object.entries(map)).filter((entry): entry is [string, string] => typeof entry[1] === "string"), ...groups.flatMap(({ paths, reason }) => paths.map((path) => [path, reason] as [string, string])), ...[...adopterPaths, ...adopterPrefixes].map((path) => [path, adopterReason] as [string, string]), ...runtimeTestPaths.map((path) => [path, runtimeTestReason] as [string, string]), ...sourceImporterWithholds.map((path) => [path, SOURCE_IMPORTER_REASON] as [string, string])]);
  const delta: Delta = {
    flattenPrefix: typeof raw.flattenPrefix === "string" ? raw.flattenPrefix : "",
    publishAs: typeof raw.publishAs === "string" ? raw.publishAs : "",
    withhold, withholdPrefixes, withholdPrefixOverlap, withholdReasons, sourceImporterWithholds, opaqueSourceDependencyEdges: readOpaqueSourceDependencyEdges(raw.opaqueSourceDependencyEdges),
    signedResidue: { calls: typeof residue.calls === "number" ? residue.calls : -1, hosts: typeof residue.hosts === "number" ? residue.hosts : -1 },
  };
  if (delta.flattenPrefix === "" || delta.publishAs === "") throw new Error(`${CATALOG}: publicationDelta names no flatten source or target`);
  if (!delta.publishAs.startsWith(delta.flattenPrefix)) throw new Error(`${CATALOG}: the flattened baseline must land inside ${delta.flattenPrefix}, so the same family selects it`);
  if (delta.signedResidue.calls < 0 || delta.signedResidue.hosts < 0) throw new Error(`${CATALOG}: publicationDelta.signedResidue is missing; an unsigned residue is not a manifest`);
  sortedPaths(delta.withholdPrefixes, `${CATALOG}: publicationDelta.withholdPrefixes`);
  const selectors = [...delta.withhold, ...delta.withholdPrefixes].sort();
  const reasonsDeclared = "withholdReasons" in raw || "withholdReason" in raw || "withholdPrefixReason" in raw || "withholdPrefixes" in raw || "withholdGroups" in raw || "sourceImporterWithholds" in raw || "adopterSurfaceWithholds" in raw || "adopterRuntimeTestWithholds" in raw;
  if (reasonsDeclared && JSON.stringify(Object.keys(withholdReasons).sort()) !== JSON.stringify(selectors)) throw new Error(`${CATALOG}: publicationDelta withhold reasons must explain every exact path and prefix exactly once`);
  if (Object.values(withholdReasons).some((reason) => reason.trim() === "")) throw new Error(`${CATALOG}: publicationDelta withhold reasons must be non-empty`);
  return delta;
}

function sourcePathCandidates(importer: string, value: string, moduleReference: boolean): string[] {
  if (moduleReference) value = value.split(/[?#]/u, 1)[0] ?? value;
  const bases: string[] = [];
  if (value.startsWith("@/")) bases.push(`src/${value.slice(2)}`);
  else if (moduleReference && value.startsWith(".")) bases.push(posix.join(posix.dirname(importer), value));
  else if (!moduleReference && !value.startsWith("/") && !value.includes("\\")) bases.push(value.replace(/^\.\//u, ""));
  if (!moduleReference) return [...new Set(bases.map((base) => posix.normalize(base)).filter((path) => path !== ".." && !path.startsWith("../")))];
  return [...new Set(bases.flatMap((base) => { const path = posix.normalize(base); if (path === ".." || path.startsWith("../")) return []; const extension = /\.(?:[cm]?js|jsx)$/u.exec(path)?.[0]; const stem = extension ? path.slice(0, -extension.length) : path; return extension === ".mjs" ? [path, `${stem}.mts`] : extension === ".cjs" ? [path, `${stem}.cts`] : extension === ".jsx" ? [path, `${stem}.tsx`] : extension === ".js" ? [path, `${stem}.ts`, `${stem}.tsx`] : posix.extname(path) === "" ? [path, ...["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].flatMap((suffix) => [`${path}.${suffix}`, `${path}/index.${suffix}`])] : [path]; }))];
}

type StaticPathValue = { values: string[]; members?: StaticPathValue[]; properties?: Map<string, StaticPathValue> };
const EMPTY_STATIC_PATH: StaticPathValue = { values: [] };
const FS_SYNC_READS = new Set(["readFileSync", "readFile", "openSync", "accessSync", "existsSync", "statSync", "lstatSync"]);
const FS_PROMISE_READS = new Set(["readFile", "access", "stat", "lstat"]);
const ITERATORS = new Set(["every", "filter", "find", "flatMap", "forEach", "map", "reduce", "some"]);

function mergeStaticPaths(values: StaticPathValue[]): StaticPathValue {
  const properties = new Map<string, StaticPathValue>();
  for (const value of values) for (const [key, child] of value.properties ?? []) properties.set(key, mergeStaticPaths([...(properties.has(key) ? [properties.get(key)!] : []), child]));
  return { values: [...new Set(values.flatMap((value) => value.values))], members: values, ...(properties.size > 0 ? { properties } : {}) };
}

function iteratedStaticPath(iterable: StaticPathValue): StaticPathValue {
  const elements = iterable.members ?? [iterable]; const value = mergeStaticPaths(elements); const width = Math.max(0, ...elements.map((element) => element.members?.length ?? 0));
  if (width > 0) value.members = Array.from({ length: width }, (_, index) => mergeStaticPaths(elements.flatMap((element) => element.members?.[index] ? [element.members[index]!] : [])));
  return value;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression;
  return expression;
}

function staticPathValue(expression: ts.Expression | undefined, bindings: Map<string, StaticPathValue>): StaticPathValue {
  if (!expression) return EMPTY_STATIC_PATH;
  expression = unwrapExpression(expression);
  if (ts.isStringLiteralLike(expression)) return { values: [expression.text] };
  if (ts.isIdentifier(expression)) return bindings.get(expression.text) ?? EMPTY_STATIC_PATH;
  if (ts.isArrayLiteralExpression(expression)) return mergeStaticPaths(expression.elements.filter(ts.isExpression).map((element) => staticPathValue(element, bindings)));
  if (ts.isObjectLiteralExpression(expression)) {
    const properties = new Map<string, StaticPathValue>();
    for (const property of expression.properties) if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) { const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name)) ? property.name.text : null; if (name !== null) properties.set(name, staticPathValue(ts.isPropertyAssignment(property) ? property.initializer : property.name, bindings)); }
    return { values: [...new Set([...properties.values()].flatMap((value) => value.values))], members: [...properties.values()], properties };
  }
  if (ts.isPropertyAccessExpression(expression)) return staticPathValue(expression.expression, bindings).properties?.get(expression.name.text) ?? EMPTY_STATIC_PATH;
  if (ts.isElementAccessExpression(expression)) { const keys = staticPathValue(expression.argumentExpression, bindings).values; const base = staticPathValue(expression.expression, bindings); return mergeStaticPaths(keys.map((key) => base.properties?.get(key) ?? (/^\d+$/u.test(key) ? base.members?.[Number(key)] : undefined) ?? EMPTY_STATIC_PATH)); }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) { const left = staticPathValue(expression.left, bindings).values; const right = staticPathValue(expression.right, bindings).values; return { values: left.flatMap((prefix) => right.map((suffix) => `${prefix}${suffix}`)) }; }
  if (ts.isTemplateExpression(expression)) { let values = [expression.head.text]; for (const span of expression.templateSpans) { const substitutions = staticPathValue(span.expression, bindings).values; if (substitutions.length === 0) return EMPTY_STATIC_PATH; values = values.flatMap((prefix) => substitutions.map((value) => `${prefix}${value}${span.literal.text}`)); } return { values }; }
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "join") {
    const base = staticPathValue(expression.expression.expression, bindings); const separator = expression.arguments.length === 0 ? [","] : staticPathValue(expression.arguments[0], bindings).values;
    if (base.members && base.members.length > 0 && separator.length > 0 && base.members.every((member) => member.values.length > 0)) return { values: separator.flatMap((glue) => base.members!.reduce<string[]>((joined, member, index) => index === 0 ? member.values : joined.flatMap((prefix) => member.values.map((value) => `${prefix}${glue}${value}`)), [])) };
  }
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.expression.getText() === "Object") { const value = staticPathValue(expression.arguments[0], bindings); const entries = [...(value.properties?.entries() ?? [])]; if (expression.expression.name.text === "values") return mergeStaticPaths(entries.map(([, child]) => child)); if (expression.expression.name.text === "keys") return mergeStaticPaths(entries.map(([key]) => ({ values: [key] }))); if (expression.expression.name.text === "entries") return mergeStaticPaths(entries.map(([key, child]) => ({ values: [key, ...child.values], members: [{ values: [key] }, child] }))); }
  if (ts.isCallExpression(expression)) {
    const name = ts.isIdentifier(expression.expression) ? expression.expression.text : ts.isPropertyAccessExpression(expression.expression) ? expression.expression.name.text : "";
    if (name === "join" || name === "resolve") { let parts = expression.arguments.map((argument) => staticPathValue(argument, bindings).values); if (parts[0]?.length === 0) parts = parts.slice(1); if (parts.length === 0 || parts.some((part) => part.length === 0)) return EMPTY_STATIC_PATH; return { values: parts.reduce<string[]>((paths, part) => paths.flatMap((path) => part.map((segment) => posix.join(path, segment))), [""]).map((path) => path.replace(/^\//u, "")) }; }
  }
  return EMPTY_STATIC_PATH;
}

function bindStaticPattern(pattern: ts.BindingName, value: StaticPathValue, bindings: Map<string, StaticPathValue>): void {
  if (ts.isIdentifier(pattern)) { bindings.set(pattern.text, value); return; }
  for (const [index, element] of pattern.elements.entries()) if (ts.isBindingElement(element) && !element.dotDotDotToken) { const key = ts.isObjectBindingPattern(pattern) ? element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName) || ts.isNumericLiteral(element.propertyName)) ? element.propertyName.text : ts.isIdentifier(element.name) ? element.name.text : null : String(index); bindStaticPattern(element.name, key === null ? EMPTY_STATIC_PATH : value.properties?.get(key) ?? value.members?.[index] ?? EMPTY_STATIC_PATH, bindings); }
}

function filesystemBindings(source: ts.SourceFile): { direct: Set<string>; namespaces: Set<string>; promiseNamespaces: Set<string>; moduleLoaders: Set<string> } {
  const direct = new Set<string>(); const namespaces = new Set<string>(); const promiseNamespaces = new Set<string>(); const moduleLoaders = new Set<string>(["require"]);
  const register = (name: ts.BindingName, module: string) => { const promise = module === "fs/promises" || module === "node:fs/promises"; if (ts.isIdentifier(name)) (promise ? promiseNamespaces : namespaces).add(name.text); else for (const element of name.elements) if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) { const imported = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text; if (!promise && imported === "promises") promiseNamespaces.add(element.name.text); else if ((promise ? FS_PROMISE_READS : FS_SYNC_READS).has(imported)) direct.add(element.name.text); } };
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && ["fs", "node:fs", "fs/promises", "node:fs/promises"].includes(node.moduleSpecifier.text) && node.importClause) { const module = node.moduleSpecifier.text; const promise = module.endsWith("/promises"); if (node.importClause.name) (promise ? promiseNamespaces : namespaces).add(node.importClause.name.text); const named = node.importClause.namedBindings; if (named) { if (ts.isNamespaceImport(named)) (promise ? promiseNamespaces : namespaces).add(named.name.text); else for (const element of named.elements) { const imported = element.propertyName?.text ?? element.name.text; if (!promise && imported === "promises") promiseNamespaces.add(element.name.text); else if ((promise ? FS_PROMISE_READS : FS_SYNC_READS).has(imported)) direct.add(element.name.text); } } }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression) && ["fs", "node:fs", "fs/promises", "node:fs/promises"].includes(node.moduleReference.expression.text)) register(node.name, node.moduleReference.expression.text);
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "require" && ts.isStringLiteralLike(node.initializer.arguments[0]!) && ["fs", "node:fs", "fs/promises", "node:fs/promises"].includes(node.initializer.arguments[0]!.text)) register(node.name, node.initializer.arguments[0]!.text);
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.initializer)) { if (namespaces.has(node.initializer.text)) register(node.name, "node:fs"); else if (promiseNamespaces.has(node.initializer.text)) register(node.name, "node:fs/promises"); else if (direct.has(node.initializer.text) && ts.isIdentifier(node.name)) direct.add(node.name.text); else if (moduleLoaders.has(node.initializer.text) && ts.isIdentifier(node.name)) moduleLoaders.add(node.name.text); }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isPropertyAccessExpression(node.initializer) && ts.isIdentifier(node.name)) { const owner = node.initializer.expression; const member = node.initializer.name.text; if (ts.isIdentifier(owner) && ((namespaces.has(owner.text) && FS_SYNC_READS.has(member)) || (promiseNamespaces.has(owner.text) && FS_PROMISE_READS.has(member)))) direct.add(node.name.text); else if (ts.isPropertyAccessExpression(owner) && owner.name.text === "promises" && ts.isIdentifier(owner.expression) && namespaces.has(owner.expression.text) && FS_PROMISE_READS.has(member)) direct.add(node.name.text); }
    ts.forEachChild(node, collect);
  };
  collect(source); return { direct, namespaces, promiseNamespaces, moduleLoaders };
}

/** Source-act closure: comments and unused strings are ignored; every module edge and repository filesystem read/probe must resolve statically and cannot land on a withheld source path. */
export function assertRetainedSourceWithholdClosure(root: string, retainedSourcePaths: string[], withheldSourcePaths: string[], finalOutputPaths: string[], permittedAbsentProbes: readonly string[] = [], projectedImporterRatchets: Readonly<Record<string, readonly string[]>> = {}, opaqueRegistry: OpaqueSourceDependencyEdges | null = {}): string[] {
  const withheld = new Set(withheldSourcePaths); const output = new Set(finalOutputPaths); const permitted = new Set(permittedAbsentProbes); const failures = new Set<string>(); const unresolved = new Set<string>(); const observed = new Map(Object.keys(projectedImporterRatchets).map((path) => [path, new Set<string>()]));
  const packageImports = existsSync(join(root, "package.json")) ? (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { imports?: Record<string, string | { default?: string }> }).imports ?? {} : {};
  const check = (importer: string, value: string, moduleReference: boolean) => { const alias = moduleReference && value.startsWith("#") ? packageImports[value] : undefined; const targetValue = typeof alias === "string" ? alias : alias?.default; const candidates = sourcePathCandidates(importer, targetValue ?? value, targetValue === undefined ? moduleReference : false); if (moduleReference) for (const target of candidates) if (output.has(target)) observed.get(target)?.add(importer); const target = candidates.find((path) => withheld.has(path) && !output.has(path)); const pair = target ? `${importer} -> ${target}` : ""; if (target && !permitted.has(pair)) failures.add(pair); };
  for (const importer of retainedSourcePaths.filter((path) => /\.[cm]?[jt]sx?$/u.test(path))) {
    const source = ts.createSourceFile(importer, readFileSync(join(root, importer), "utf8"), ts.ScriptTarget.Latest, true);
    if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length > 0) throw new Error(`${CATALOG}: retained source cannot be parsed for withhold closure: ${importer}`);
    const staticModuleEdge = (node: ts.ImportDeclaration | ts.ExportDeclaration | ts.ImportEqualsDeclaration): void => {
      const expression = ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) ? node.moduleReference.expression : ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier : undefined;
      if (expression && ts.isStringLiteralLike(expression)) check(importer, expression.text, true);
    };
    const fs = filesystemBindings(source);
    const isFilesystemCall = (call: ts.CallExpression): boolean => { const callee = call.expression; if (ts.isIdentifier(callee)) return fs.direct.has(callee.text); if (!ts.isPropertyAccessExpression(callee)) return false; const name = callee.name.text; if (ts.isIdentifier(callee.expression)) return (fs.namespaces.has(callee.expression.text) && FS_SYNC_READS.has(name)) || (fs.promiseNamespaces.has(callee.expression.text) && FS_PROMISE_READS.has(name)); return ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === "promises" && ts.isIdentifier(callee.expression.expression) && fs.namespaces.has(callee.expression.expression.text) && FS_PROMISE_READS.has(name); };
    const walkFilesystem = (node: ts.Node, bindings: Map<string, StaticPathValue>): void => {
      if (ts.isSourceFile(node) || ts.isBlock(node)) { const local = new Map(bindings); for (const child of node.statements) { if (ts.isVariableStatement(child)) for (const declaration of child.declarationList.declarations) { if (declaration.initializer) walkFilesystem(declaration.initializer, local); bindStaticPattern(declaration.name, staticPathValue(declaration.initializer, local), local); } else walkFilesystem(child, local); } return; }
      if (ts.isFunctionLike(node) && "body" in node) { const local = new Map(bindings); for (const parameter of node.parameters) bindStaticPattern(parameter.name, EMPTY_STATIC_PATH, local); const body = node.body as ts.ConciseBody | undefined; if (body) walkFilesystem(body, local); return; }
      if (ts.isForOfStatement(node)) { walkFilesystem(node.expression, bindings); const local = new Map(bindings); const value = iteratedStaticPath(staticPathValue(node.expression, bindings)); if (ts.isVariableDeclarationList(node.initializer)) for (const declaration of node.initializer.declarations) bindStaticPattern(declaration.name, value, local); walkFilesystem(node.statement, local); return; }
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) staticModuleEdge(node);
      if (ts.isCallExpression(node)) {
        const moduleCall = node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && fs.moduleLoaders.has(node.expression.text));
        if (moduleCall) { const values = staticPathValue(node.arguments[0], bindings).values; if (values.length === 0) unresolved.add(`${importer} -> unresolved module edge: ${node.arguments[0]?.getText(source) ?? "missing argument"}`); else for (const value of values) check(importer, value, true); }
        if (isFilesystemCall(node)) { const values = staticPathValue(node.arguments[0], bindings).values; if (values.length === 0) unresolved.add(`${importer} -> unresolved filesystem path: ${node.arguments[0]?.getText(source) ?? "missing argument"}`); else for (const value of values) check(importer, value, false); }
        if (ts.isPropertyAccessExpression(node.expression) && ITERATORS.has(node.expression.name.text)) { const value = iteratedStaticPath(staticPathValue(node.expression.expression, bindings)); for (const argument of node.arguments) { if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) { const local = new Map(bindings); const parameter = argument.parameters[node.expression.name.text === "reduce" ? 1 : 0]; if (parameter) bindStaticPattern(parameter.name, value, local); walkFilesystem(argument.body, local); } else walkFilesystem(argument, bindings); } walkFilesystem(node.expression.expression, bindings); return; }
      }
      ts.forEachChild(node, (child) => walkFilesystem(child, bindings));
    };
    walkFilesystem(source, new Map());
  }
  for (const [target, expected] of Object.entries(projectedImporterRatchets)) { const actual = [...(observed.get(target) ?? [])].sort(); if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new Error(`${CATALOG}: projected importer ratchet moved for ${target}: ${actual.join(", ") || "none"}`); }
  if (failures.size > 0) throw new Error(`${CATALOG}: retained source names withheld paths:\n${[...failures].sort().join("\n")}`);
  const opaque = [...unresolved].sort(); if (opaqueRegistry === null) return opaque;
  const expected = Object.entries(opaqueRegistry).flatMap(([path, entry]) => entry.edges.map((edge) => `${path} -> ${edge}`)).sort();
  for (const [path, entry] of Object.entries(opaqueRegistry)) { const actualDigest = `sha256-${createHash("sha256").update(readFileSync(join(root, path))).digest("hex")}`; if (actualDigest !== entry.sourceDigest) throw new Error(`${CATALOG}: opaque dependency source digest moved for ${path}`); }
  if (JSON.stringify(opaque) !== JSON.stringify(expected)) throw new Error(`${CATALOG}: opaque dependency registry drift:\n${opaque.length > 0 ? opaque.join("\n") : "none observed"}`);
  return opaque;
}

/** @deprecated Source-act callers must provide the complete resolved withhold and output inventories. */
export const assertSourceImporterWithholdClosure = (): never => { throw new Error(`${CATALOG}: legacy importer closure lacks the complete source partition; call assertRetainedSourceWithholdClosure`); };

export function resolvedPublicationWithholds(kept: string[], delta: Delta): string[] {
  const keptSet = new Set(kept);
  const resolved = new Set(delta.withhold);
  const permittedOverlap = new Set(delta.withholdPrefixOverlap); for (const path of permittedOverlap) if (!resolved.has(path)) throw new Error(`${CATALOG}: publicationDelta.withholdPrefixOverlap does not name an exact withhold: ${path}`);
  for (const path of delta.withhold) if (!keptSet.has(path)) throw new Error(`${CATALOG}: publicationDelta.withhold path selects no kept source: ${path}`);
  for (const prefix of delta.withholdPrefixes) {
    const matches = kept.filter((path) => path.startsWith(prefix));
    if (matches.length === 0) throw new Error(`${CATALOG}: publicationDelta.withholdPrefixes selector selects no kept source: ${prefix}`);
    for (const path of matches) {
      if (resolved.has(path) && !permittedOverlap.delete(path)) throw new Error(`${CATALOG}: publicationDelta exact/prefix withholding overlap: ${path}`);
      resolved.add(path);
    }
  }
  if (permittedOverlap.size > 0) throw new Error(`${CATALOG}: publicationDelta.withholdPrefixOverlap is not covered by a prefix: ${[...permittedOverlap].sort().join(", ")}`);
  return [...resolved].sort();
}
