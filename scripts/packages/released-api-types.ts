import { join } from "node:path";
import ts from "typescript";

export type Surface = { name: string; version: string; subpath: string; candidate: boolean };
export type Finding = Surface & { symbol: string; change: string; deprecated?: boolean };
type Check = (symbol: string, change: string, from: string, to?: string) => void;

const options: ts.CompilerOptions = {
  strict: true, noEmit: true, skipLibCheck: true, types: [],
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
};

function openKey(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  if (!type.isUnion()) return undefined;
  const literal = (item: ts.Type) => Boolean(item.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral));
  if (type.types.every(literal)) return "";
  return checker.getPropertiesOfType(type).find(({ name }) => {
    const values = type.types.map(arm => arm.getProperty(name)).map(member => member && checker.getTypeOfSymbol(member));
    return values.every(value => value && literal(value)) && new Set(values).size === values.length;
  })?.name;
}

function plainResult(type: ts.Type): ts.Type | undefined {
  const calls = type.getCallSignatures();
  return calls.length === 1 && !calls[0]?.typeParameters?.length ? calls[0]?.getReturnType() : undefined;
}

function openResult(checker: ts.TypeChecker, left: ts.Type, right: ts.Type) {
  const before = plainResult(left), after = plainResult(right);
  if (!before || !after) return undefined;
  if (openKey(checker, before) !== undefined) return { before, after, async: false };
  if (before.symbol?.name !== "Promise" || after.symbol?.name !== "Promise") return undefined;
  const oldValue = checker.getAwaitedType(before), newValue = checker.getAwaitedType(after);
  return oldValue && newValue && openKey(checker, oldValue) !== undefined
    ? { before: oldValue, after: newValue, async: true } : undefined;
}

function compareBinding(checker: ts.TypeChecker, left: ts.Type, right: ts.Type, oldType: string, newType: string, symbol: string, check: Check, shape = false, member = false) {
  const tupleLength = (type: ts.Type) => checker.isTupleType(type) ? checker.typeToString(checker.getTypeOfSymbol(type.getProperty("length")!)) : undefined;
  const leftLength = tupleLength(left), rightLength = tupleLength(right);
  if (leftLength && rightLength && leftLength !== rightLength) {
    check(symbol, `changed tuple length from ${leftLength} to ${rightLength}`, "false");
    return;
  }
  const key = openKey(checker, left);
  if (key !== undefined) {
    const field = JSON.stringify(key), variants = `Arms<${oldType}, ${field}>`;
    check(symbol, "lost one or more released variants", variants, `Extract<Arms<${newType}, ${field}>, ${variants}>`);
    check(symbol, "changed the shape of a released variant", `Keep<${newType}, ${field}, ${variants}>`, oldType);
    if (shape) check(symbol, "no longer accepts released shapes", oldType, newType);
    return;
  }

  const output = openResult(checker, left, right);
  if (plainResult(left) && plainResult(right)) {
    // Compare argument tuples independently, including for bivariant methods.
    check(symbol, "no longer accepts released call arguments", `Parameters<${oldType}>`, `Parameters<${newType}>`);
  }
  if (output) {
    const result = (type: string) => output.async ? `Awaited<ReturnType<${type}>>` : `ReturnType<${type}>`;
    compareBinding(checker, output.before, output.after, result(oldType), result(newType), symbol, check, shape, true);
    if (shape) check(symbol, "no longer accepts released implementations", `Call<${oldType}>`, `Call<${newType}>`);
    return;
  }

  const adjusted: string[] = [];
  if (shape && !member && !left.isUnion() && !leftLength && !left.getCallSignatures().length) {
    for (const property of checker.getPropertiesOfType(left)) {
      if (property.name.startsWith("__@")) continue;
      const other = right.getProperty(property.name), label = `${symbol}.${property.name}`;
      if (!other) {
        check(label, "removed the released member", "false");
        continue;
      }
      const optional = Boolean(property.flags & ts.SymbolFlags.Optional);
      if (!optional && other.flags & ts.SymbolFlags.Optional) {
        check(label, "became optional; released callers can use it directly", "false");
        continue;
      }
      const prior = checker.getTypeOfSymbol(property), next = checker.getTypeOfSymbol(other);
      const name = JSON.stringify(property.name);
      if (!optional && (openKey(checker, prior) !== undefined || openResult(checker, prior, next))) adjusted.push(name);
      else if (!prior.getCallSignatures().length) continue;
      compareBinding(checker, prior, next, `${oldType}[${name}]`, `${newType}[${name}]`, label, check, true, true);
    }
  }
  const compare = (type: string) => adjusted.length ? `Omit<${type}, ${adjusted.join(" | ")}>` : type;
  check(symbol, "changed its released call signature or readable type", compare(newType), compare(oldType));
  if (shape) check(symbol, "no longer accepts released implementations or shapes", compare(oldType), compare(newType));
}

const helpers = `
type Arms<T, K extends string> = K extends "" ? T : K extends keyof T ? T[K] : never;
type Keep<T, K extends string, V> = K extends "" ? Extract<T, V>
  : T extends Record<K, infer D> ? [Extract<D, V>] extends [never] ? never : T & Record<K, Extract<D, V>> : T;
type Call<F> = F extends (...args: infer A) => unknown ? (...args: A) => void : never;
declare function value<T>(): T;
declare function accepts<T>(value: T): void;
`;

/** A brand declared at the same package coordinate is the same public identity
 * across upgrades. Give it one compiler identity without merging either pack. */
function alignBrands(source: ts.SourceFile, coordinate: string, brands: Map<string, string>, module: string): string {
  const edits: { start: number; end: number; text: string }[] = [];
  const brand = (key: string) => {
    const alias = brands.get(key) ?? `Brand${brands.size}`;
    brands.set(key, alias);
    return `typeof import(${JSON.stringify(module)}).${alias}`;
  };
  const brandedClasses = new Set<ts.Node>();
  const visit = (node: ts.Node, path: string) => {
    const name = (node as ts.NamedDeclaration).name;
    const owner = name ? path + "/" + name.getText(source) : path;
    if (node.parent && ts.isClassDeclaration(node.parent) && !ts.isConstructorDeclaration(node)
      && ((name && ts.isPrivateIdentifier(name)) || (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword)))) {
      const text = brandedClasses.has(node.parent) ? "" : `readonly __releasedApiClassBrand: ${brand(coordinate + path)};`;
      brandedClasses.add(node.parent);
      edits.push({ start: node.getStart(source), end: node.end, text });
      return;
    }
    if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.UniqueKeyword) {
      edits.push({ start: node.getStart(source), end: node.end, text: brand(coordinate + owner) });
    }
    ts.forEachChild(node, child => visit(child, owner));
  };
  visit(source, "");
  let text = source.text;
  for (const edit of edits.reverse()) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}

function unchangedDeclarations(
  program: ts.Program, scratch: string, coordinates: (file: string) => string | undefined, imports: Map<string, readonly string[]>,
) {
  const root = join(scratch, "released", "node_modules") + "/";
  const printer = ts.createPrinter({ removeComments: true });
  const changed = new Set<string>(), parents = new Map<string, string[]>();
  for (const old of program.getSourceFiles()) {
    const key = coordinates(old.fileName);
    if (!key || !old.fileName.startsWith(root)) continue;
    const next = program.getSourceFile(join(scratch, "candidate", "node_modules", key));
    const dependencies = imports.get(old.fileName) ?? [];
    const nextDependencies = next ? imports.get(next.fileName) ?? [] : [];
    const sameEdges = dependencies.length === nextDependencies.length
      && dependencies.every((file, index) => (coordinates(file) ?? file) === (coordinates(nextDependencies[index]!) ?? nextDependencies[index]));
    if (!next || !sameEdges || (old.text !== next.text && printer.printFile(old) !== printer.printFile(next))) changed.add(key);
    for (const file of dependencies) {
      const dependency = coordinates(file);
      if (dependency) parents.set(dependency, [...(parents.get(dependency) ?? []), key]);
    }
  }
  // Changes propagate through re-exports and referenced declarations, including cycles.
  for (const key of changed) for (const parent of parents.get(key) ?? []) changed.add(parent);
  return (old: ts.Symbol, next: ts.Symbol) => {
    const before = old.declarations ?? [], after = next.declarations ?? [];
    return old.name === next.name && before.length === after.length && before.every((node, index) => {
      const key = coordinates(node.getSourceFile().fileName);
      return key !== undefined && !changed.has(key) && key === coordinates(after[index]!.getSourceFile().fileName);
    });
  };
}

export function compareTypes(scratch: string, surfaces: Surface[]): Finding[] {
  const files = new Map<string, string>();
  const host = ts.createCompilerHost(options, true);
  const brands = new Map<string, string>(), brandFile = join(scratch, "brands.mts");
  const getSourceFile = host.getSourceFile.bind(host), fileExists = host.fileExists.bind(host);
  host.fileExists = file => file === brandFile || files.has(file) || fileExists(file);
  const coordinates = (file: string) => file.slice(scratch.length).match(/^\/(?:released|candidate)\/node_modules\/(@openlup\/.+)$/u)?.[1];
  host.getSourceFile = (file, ...args) => {
    if (file === brandFile) {
      return ts.createSourceFile(file, [...brands.values()].map(name => `export declare const ${name}: unique symbol;`).join("\n"), args[0], true);
    }
    if (files.has(file)) return ts.createSourceFile(file, files.get(file)!, args[0], true);
    const source = getSourceFile(file, ...args);
    const coordinate = coordinates(file);
    if (!source?.isDeclarationFile || !coordinate || !/unique symbol|private/u.test(source.text)) return source;
    return ts.createSourceFile(file, alignBrands(source, coordinate, brands, join(scratch, "brands.mjs")), args[0], true);
  };
  const resolution = ts.createModuleResolutionCache(scratch, host.getCanonicalFileName, options);
  const dependencies = new Map<string, readonly string[]>();
  host.resolveModuleNameLiterals = (literals, file, redirected, opts, source) => {
    const resolutions = literals.map(literal => {
      const result = ts.resolveModuleName(literal.text, file, opts, host, resolution, redirected, ts.getModeForUsageLocation(source, literal, opts));
      // TypeScript otherwise redirects two installations of name@same-version
      // to a single declaration tree. Third-party dependencies stay shared.
      if (result.resolvedModule?.packageId?.name.startsWith("@openlup/")) {
        return { ...result, resolvedModule: { ...result.resolvedModule, packageId: undefined } };
      }
      return result;
    });
    dependencies.set(file, resolutions.map(({ resolvedModule }, index) => resolvedModule?.resolvedFileName ?? `unresolved:${literals[index]!.text}`));
    return resolutions;
  };
  const sides = ["released", "candidate"] as const;
  const probes = sides.map(side => join(scratch, side, "surface.mts"));
  const imports = sides.map(side => surfaces.map(({ subpath, candidate }, index) =>
    side === "released" || candidate ? `import * as M${index} from ${JSON.stringify(subpath)};` : "").filter(Boolean));
  probes.forEach((file, index) => files.set(file, imports[index]!.join("\n")));
  const program = ts.createProgram(probes, options, host);
  const checker = program.getTypeChecker();
  const modules = probes.map(file => new Map(program.getSourceFile(file)!.statements.map(statement => {
    const declaration = statement as ts.ImportDeclaration;
    const specifier = declaration.moduleSpecifier as ts.StringLiteral;
    const module = checker.getSymbolAtLocation(specifier);
    if (!module) throw new Error(`Released API: cannot resolve ${specifier.text} from the ${file === probes[0] ? "released" : "candidate"} pack exports`);
    return [specifier.text, {
      symbols: checker.getExportsOfModule(module),
      values: checker.getTypeOfSymbol(module),
    }];
  })));
  const unchanged = unchangedDeclarations(program, scratch, coordinates, dependencies);
  const target = (symbol: ts.Symbol) => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const tagged = (symbol: ts.Symbol, tag: string) => [symbol, target(symbol)].some(item => item.getJsDocTags(checker).some(doc => doc.name === tag));
  const findings: Finding[] = [];
  const proofFile = join(scratch, "compatibility.mts");
  const proof = helpers.trim().split("\n");
  const byLine = new Map<number, Finding>();
  const aliasLines = new Map<string, Finding>();
  let id = 0;

  for (const [index, surface] of surfaces.entries()) {
    const released = modules[0]!.get(surface.subpath)!;
    const candidate = modules[1]!.get(surface.subpath);
    for (const before of released.symbols) {
      const name = before.name;
      if (tagged(before, "experimental")) continue;
      const old = target(before);
      if (!old.declarations?.length) throw new Error(`Released API: cannot resolve ${surface.name}@${surface.version} ${surface.subpath} → ${name}`);
      const after = candidate?.symbols.find(symbol => symbol.name === name);
      const next = after && target(after);
      if (!next?.declarations?.length) {
        findings.push({ ...surface, symbol: name, change: candidate ? "removed the released export" : "removed its released subpath", deprecated: tagged(before, "deprecated") });
        continue;
      }
      const releasedValue = Boolean(released.values.getProperty(name));
      const candidateValue = Boolean(candidate?.values.getProperty(name));
      if (releasedValue === candidateValue && before.flags === after?.flags && old.flags === next.flags && unchanged(old, next)) continue;
      const check: Check = (symbol, change, from, to = "true") => {
        byLine.set(proof.length, { ...surface, symbol, change });
        proof.push(`accepts<${to}>(value<${from}>());`);
      };
      for (const meaning of [ts.SymbolFlags.Value, ts.SymbolFlags.Type]) {
        const shape = meaning === ts.SymbolFlags.Type;
        if (shape ? !(old.flags & meaning) : !releasedValue) continue;
        if (shape ? !(next.flags & meaning) : !candidateValue) {
          check(name, `no longer exports a ${shape ? "type" : "value"}`, "false");
          continue;
        }
        const declared = (symbol: ts.Symbol) => shape ? checker.getDeclaredTypeOfSymbol(symbol) : checker.getTypeOfSymbol(symbol);
        const left = declared(old), right = declared(next);
        const typeParams = old.declarations.flatMap(node => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node) ? [...(node.typeParameters ?? [])] : []);
        const args = shape && typeParams.length ? `<${typeParams.map(() => "any").join(", ")}>` : "";
        const alias = `T${id++}`;
        const isClass = Boolean(old.flags & ts.SymbolFlags.Class);
        const exported = /^[\w$]+$/u.test(name) ? name : JSON.stringify(name);
        imports.forEach((lines, side) => {
          const binding = shape ? `B${alias}` : `M${index}[${JSON.stringify(name)}]`;
          const location = { ...surface, symbol: name, change: "changed its exported type parameters or declaration" };
          const emit = (line: string) => {
            aliasLines.set(`${probes[side]}:${lines.length}`, location);
            lines.push(line);
          };
          if (shape) emit(`import type { ${exported} as ${binding} } from ${JSON.stringify(surface.subpath)};`);
          let type = shape ? `${binding}${args}` : `typeof ${binding}`;
          if (isClass) type = shape ? `Pick<${type}, keyof ${type}>` : `Omit<${type}, "prototype">`;
          emit(`export type ${alias} = ${type};`);
          proof.push(`type ${sides[side] === "released" ? "R" : "C"}${alias} = import("./${sides[side]}/surface.mjs").${alias};`);
        });
        if (isClass && !shape && left.getConstructSignatures().length) {
          for (const lines of imports) lines.push(`export type A${alias} = ConstructorParameters<typeof M${index}[${JSON.stringify(name)}]>;`);
          check(name, "no longer accepts released constructor arguments", `import("./released/surface.mjs").A${alias}`, `import("./candidate/surface.mjs").A${alias}`);
        }
        compareBinding(checker, left, right, `R${alias}`, `C${alias}`, name, check, shape);
      }
    }
  }
  probes.forEach((file, index) => files.set(file, imports[index]!.join("\n")));
  files.set(proofFile, proof.join("\n"));
  const checked = ts.createProgram([proofFile], options, host);
  const seen = new Set<string>();
  for (const diagnostic of ts.getPreEmitDiagnostics(checked)) {
    const line = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line;
    const finding = line === undefined ? undefined : diagnostic.file?.fileName === proofFile
      ? byLine.get(line) : aliasLines.get(`${diagnostic.file?.fileName}:${line}`);
    const detail = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    if (!finding) throw new Error(`Released API: could not compile the packed consumer: ${detail}`);
    const key = JSON.stringify(finding);
    if (!seen.has(key)) findings.push(finding);
    seen.add(key);
  }
  return findings;
}
