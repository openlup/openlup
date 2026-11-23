import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(packageRoot, "dist");
const gates = readJson("release-gates.json");
const update = process.argv.includes("--update");
const landing = process.argv.find((arg) => arg.startsWith("--landing="));
const derivedProof = process.argv.includes("--derived-proof");
if (landing && !update) throw new Error("--landing requires --update");
if (derivedProof && (!update || landing)) throw new Error("--derived-proof requires --update without --landing");

const manifest = readJson("package.json");
const { "./package.json": manifestExport, ...codeExports } = manifest.exports;
assert(manifestExport === "./package.json", "the manifest is exported as ./package.json for tooling");
assert(gates.kind === "rail", "outbox must remain a rail");
assert(JSON.stringify(Object.keys(codeExports).sort()) === JSON.stringify(Object.keys(gates.packageSurface).sort()), "every exact export needs a snapshot");
for (const [subpath, target] of Object.entries(codeExports)) {
  const contract = gates.packageSurface[subpath];
  assert(JSON.stringify(Object.keys(target)) === JSON.stringify(["types", "import", "default"]), "rail export condition order drift");
  assert(target.types === `./${contract.entrypoint}` && target.import === target.default && target.import === target.types.replace(/\.d\.ts$/, ".js"), "declarations and runtime exports differ");
}

const maturityRank = { testing: 0, experimental: 1, stable: 2 };
for (const [subpath, contract] of Object.entries(gates.packageSurface)) {
  assert(Object.hasOwn(maturityRank, contract.maturity), `unknown maturity ${contract.maturity} for ${subpath}`);
}
const entrypoints = new Map(Object.entries(gates.packageSurface).map(([subpath, contract]) => {
  const entrypoint = resolveInsidePackage(contract.entrypoint);
  assert(existsSync(entrypoint), `missing declaration entrypoint ${contract.entrypoint}; run npm run build`);
  return [subpath, entrypoint];
}));

const ownerByFile = new Map();
const sortedSubpaths = [...entrypoints.keys()].sort((left, right) => {
  const rankDiff = maturityRank[gates.packageSurface[right].maturity] - maturityRank[gates.packageSurface[left].maturity];
  return rankDiff !== 0 ? rankDiff : left.localeCompare(right);
});
for (const subpath of sortedSubpaths) {
  for (const file of collectReexportedFiles(entrypoints.get(subpath))) {
    if (!ownerByFile.has(file)) ownerByFile.set(file, subpath);
  }
}

const declarationsBySubpath = new Map([...entrypoints].map(([subpath, entrypoint]) => [subpath, collectDeclarationGraph(subpath, [entrypoint])]));
const scopedFiles = new Set([...declarationsBySubpath.values()].flat());
const missingFiles = collectDeclarationGraph(null, [...entrypoints.values()])
  .filter((file) => !scopedFiles.has(file)).map((file) => toPosix(relative(packageRoot, file)));
assert(missingFiles.length === 0, `API snapshots omit declarations: ${missingFiles.join(", ")}; make each missing declaration reachable from its owning subpath entrypoint`);

const reports = Object.entries(gates.packageSurface).map(([subpath, contract]) => {
  const snapshotPath = resolveInsidePackage(contract.snapshot);
  const snapshot = renderSnapshot(subpath, contract, declarationsBySubpath.get(subpath));
  const previous = existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf8") : undefined;
  return { subpath, contract, snapshotPath, snapshot, previous };
});

const changed = reports.some(({ snapshot, previous }) => snapshot !== previous);
if (landing) assertLandingChangelog(landing.slice("--landing=".length), changed);
for (const { subpath, contract, snapshotPath, snapshot, previous } of reports) {
  if (update) {
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, snapshot);
    console.log(`updated ${contract.snapshot}`);
    continue;
  }

  const label = `packages/outbox/${contract.snapshot}`;
  const remedy = "run npm run api:update --workspace=@openlup/outbox";
  assert(previous !== undefined, `missing API snapshot ${label}; ${remedy}`);
  assert(previous === snapshot, `${label}: ${contract.maturity} package surface drift for ${subpath}; ${remedy}`);
  console.log(`${contract.maturity} package surface ok ${subpath}`);
}

if (update && !landing && !derivedProof && changed) assertChangelogChanged();

function renderSnapshot(subpath, contract, declarations) {
  const sections = declarations.map((file) => {
    const path = toPosix(relative(packageRoot, file));
    const source = readFileSync(file, "utf8").replace(/^\/\/# sourceMappingURL=.*$/gm, "").trimEnd();
    return `## ${path}\n\n\`\`\`ts\n${source}\n\`\`\``;
  });

  return [
    `# ${subpath} API declaration snapshot`,
    "",
    `Maturity: **${contract.maturity}**.`,
    "",
    gates.compatibilityPolicies[contract.compatibilityPolicy],
    "",
    "Generated by `npm run api:update`. Every change requires explicit review.",
    "",
    ...sections,
    "",
  ].join("\n");
}

function collectReexportedFiles(entrypoint) {
  const found = new Set();
  const pending = [entrypoint];
  while (pending.length > 0) {
    const file = pending.pop();
    if (found.has(file)) continue;
    assert(file.startsWith(`${distRoot}${sep}`), `declaration escaped dist: ${file}`);
    assert(existsSync(file), `missing referenced declaration ${toPosix(relative(packageRoot, file))}`);
    found.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const localReexports = collectLocalReexportedNames(source);
    visit(source, localReexports, ({ specifier, reexport }) => {
      if (!reexport || !specifier.startsWith(".")) return;
      const target = resolveDeclaration(file, specifier);
      assert(target, `cannot resolve ${specifier} from ${toPosix(relative(packageRoot, file))}`);
      assert(target.startsWith(`${distRoot}${sep}`), `declaration escaped dist: ${target}`);
      pending.push(target);
    });
  }
  return found;
}

function collectDeclarationGraph(subpath, entrypointsList) {
  const found = new Set();
  const pending = [...entrypointsList];

  while (pending.length > 0) {
    const file = pending.pop();
    if (found.has(file)) continue;
    assert(file.startsWith(`${distRoot}${sep}`), `declaration escaped dist: ${file}`);
    assert(existsSync(file), `missing referenced declaration ${toPosix(relative(packageRoot, file))}`);
    found.add(file);

    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const localReexports = collectLocalReexportedNames(source);

    visit(source, localReexports, ({ specifier, reexport }) => {
      if (!specifier.startsWith(".")) return;
      const target = resolveDeclaration(file, specifier);
      assert(target, `cannot resolve ${specifier} from ${toPosix(relative(packageRoot, file))}`);
      assert(target.startsWith(`${distRoot}${sep}`), `declaration escaped dist: ${target}`);
      if (subpath === null || reexport) {
        pending.push(target);
        return;
      }
      const targetOwner = ownerByFile.get(target) ?? null;
      if (targetOwner === null || targetOwner === subpath ||
          maturityRank[gates.packageSurface[targetOwner].maturity] < maturityRank[gates.packageSurface[subpath].maturity]) {
        pending.push(target);
      }
    });
  }

  return [...found].sort((left, right) => left.localeCompare(right));
}

function collectLocalReexportedNames(source) {
  const names = new Set();
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        names.add((element.propertyName ?? element.name).text);
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
      names.add(statement.expression.text);
    }
  }
  return names;
}

function importReexportsLocalName(node, localReexports) {
  const clause = node.importClause;
  if (!clause || localReexports.size === 0) return false;
  if (clause.name && localReexports.has(clause.name.text)) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return localReexports.has(bindings.name.text);
  return bindings.elements.some((element) => localReexports.has(element.name.text));
}

function visit(node, localReexports, onModuleSpecifier) {
  if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    onModuleSpecifier({ specifier: node.moduleSpecifier.text, reexport: true });
  } else if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    onModuleSpecifier({ specifier: node.moduleSpecifier.text, reexport: importReexportsLocalName(node, localReexports) });
  } else if (ts.isImportTypeNode(node)) {
    const argument = node.argument;
    if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
      onModuleSpecifier({ specifier: argument.literal.text, reexport: false });
    }
  }
  ts.forEachChild(node, (child) => visit(child, localReexports, onModuleSpecifier));
}

function resolveDeclaration(fromFile, specifier) {
  const raw = resolve(dirname(fromFile), specifier);
  const candidates = specifier.endsWith(".js")
    ? [raw.slice(0, -3) + ".d.ts"]
    : [raw, `${raw}.d.ts`, resolve(raw, "index.d.ts")];
  return candidates.find((candidate) => existsSync(candidate));
}

function resolveInsidePackage(path) {
  const absolute = resolve(packageRoot, path);
  assert(
    absolute === packageRoot || absolute.startsWith(`${packageRoot}${sep}`),
    `path escapes package root: ${path}`,
  );
  return absolute;
}

function assertLandingChangelog(context, changed) {
  const git = (...args) => execFileSync("git", ["--no-replace-objects", ...args], { cwd: packageRoot, encoding: "utf8" });
  const [head, main, ...extra] = context.split(",");
  assert(extra.length === 0 && /^[a-f0-9]{40}$/.test(head) && /^[a-f0-9]{40}$/.test(main) &&
    git("rev-parse", "HEAD", "MERGE_HEAD").trim() === `${head}\n${main}`, "landing API update requires the exact HEAD and MERGE_HEAD");
  const conflicts = git("--literal-pathspecs", "ls-files", "--unmerged", "-z", "--", ...reports.map(({ contract }) => contract.snapshot));
  if (!changed && !conflicts) return;
  const base = git("merge-base", "--all", head, main).trim();
  assert(/^[a-f0-9]{40}$/.test(base), "landing API update requires a single merge base");
  const notes = [":(glob)changes/*.md", "CHANGELOG.md"];
  const firstParentNotes = new Set(git("diff", "--relative", "--no-renames", "--diff-filter=AM", "--name-only", "-z", base, head, "--", ...notes)
    .split("\0").filter(Boolean));
  const mergedNotes = git("ls-files", "--stage", "-z", "--", ...notes).split("\0");
  assert(mergedNotes.some(row => /^100(?:644|755) [a-f0-9]+ 0\t/.test(row) && firstParentNotes.has(row.slice(row.indexOf("\t") + 1))),
    "landing: @openlup/outbox API snapshots changed; add or modify packages/outbox/changes/*.md or packages/outbox/CHANGELOG.md on the first parent and retain it in the merge");
}

function assertChangelogChanged() {
  const status = execFileSync("git", ["status", "--porcelain=v1", "--", ":(glob)changes/*.md", "CHANGELOG.md"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert(
    status.split("\n").some((line) => /[AM?]/.test(line.slice(0, 2))),
    "API snapshots changed; add or modify changes/*.md (or update CHANGELOG.md) before completing npm run api:update",
  );
}

function readJson(path) {
  return JSON.parse(readFileSync(resolveInsidePackage(path), "utf8"));
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
