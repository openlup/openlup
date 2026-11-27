import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));

// A small lexical scan keeps this boundary test dependency-free in materialized copies.
// Strings/comments are single tokens; computed dynamic imports fail closed.
function imports(source: string): string[] {
  const tokens = source.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|[^\s]/g)
    ?.filter(token => !token.startsWith('//') && !token.startsWith('/*')) ?? [];
  const result: string[] = [];
  const literal = (token: string | undefined): string => {
    if (!token || !['"', "'", '`'].includes(token[0]!) || token.includes('\\') || token.includes('${')) {
      throw new Error('starter_import_dynamic_unresolved');
    }
    return token.slice(1, -1);
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token !== 'import' && token !== 'export') continue;
    const next = tokens[index + 1];
    if (token === 'import' && next === '.') continue; // import.meta
    if (token === 'import' && next === '(') {
      const specifier = literal(tokens[index + 2]);
      if (![',', ')'].includes(tokens[index + 3] ?? '')) throw new Error('starter_import_dynamic_unresolved');
      result.push(specifier);
      continue;
    }
    if (token === 'import' && next && ['"', "'"].includes(next[0]!)) {
      result.push(literal(next));
      continue;
    }
    if (token === 'export' && !['{', '*'].includes(next ?? '')
      && !(next === 'type' && ['{', '*'].includes(tokens[index + 2] ?? ''))) continue;
    for (let cursor = index + 1; cursor < tokens.length && tokens[cursor] !== ';'; cursor++) {
      if (tokens[cursor] === 'from') { result.push(literal(tokens[cursor + 1])); break; }
    }
  }
  return result;
}

function assertRuntimeBoundary(files: ReadonlyMap<string, string>, entries: readonly string[]): void {
  const visited = new Set<string>();
  function visit(path: string): void {
    if (path === resolve(root, 'lifecycle.mjs')
      || path === resolve(root, 'installation') || path.startsWith(resolve(root, 'installation') + sep)
      || path === resolve(root, 'owned/demo-seed.ts')) throw new Error(`starter_runtime_install_import_forbidden: ${path}`);
    if (visited.has(path)) return;
    visited.add(path);
    if (!['.ts', '.tsx', '.js', '.mjs'].includes(extname(path))) return;
    const source = files.get(path);
    if (source === undefined) throw new Error(`starter_import_unresolved: ${path}`);
    for (const specifier of imports(source)) {
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(path), specifier);
      if (!target.startsWith(root + sep)) throw new Error('starter_import_outside_application');
      const resolved = [target, target + '.ts', target + '.js', resolve(target, 'index.ts'), resolve(target, 'index.js')]
        .find(candidate => files.has(candidate));
      visit(resolved ?? target);
    }
  }
  for (const entry of entries) visit(entry);
}

test('host and client transitive imports never reach lifecycle, installation or the owned demo seed', async () => {
  const files = new Map<string, string>();
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile()) files.set(path, await readFile(path, 'utf8'));
    }
  }
  for (const directory of ['host', 'client', 'owned', 'shared', 'installation']) await collect(resolve(root, directory));
  files.set(resolve(root, 'lifecycle.mjs'), await readFile(resolve(root, 'lifecycle.mjs'), 'utf8'));
  const entries = [...files.keys()].filter(path => path.startsWith(resolve(root, 'host') + sep)
    || path.startsWith(resolve(root, 'client') + sep));
  assertRuntimeBoundary(files, entries);
});

for (const planted of [
  "import '../lifecycle.mjs';",
  "const load = () => import('../lifecycle.mjs');",
  "export * from '../lifecycle.mjs';",
  "import '../installation/install.ts';",
  "const load = () => import('../installation/install.ts');",
  "export { installDemonstration } from '../installation/install.ts';",
  "export * from '../owned/demo-seed.ts';",
]) {
  test(`negative witness: transitive planted forbidden import is detected: ${planted}`, () => {
    const bridge = resolve(root, 'shared/bridge.ts');
    for (const runtime of ['host/server.ts', 'client/main.ts']) {
      const entry = resolve(root, runtime);
      const files = new Map([[entry, "export * from '../shared/bridge.ts';"], [bridge, planted]]);
      assert.throws(() => assertRuntimeBoundary(files, [entry]), /starter_runtime_install_import_forbidden/);
    }
  });
}

test('computed dynamic imports cannot conceal an installation edge', () => {
  assert.throws(() => imports('import(`../installation/${name}.ts`)'), /starter_import_dynamic_unresolved/);
  assert.throws(() => imports("import('../' + name)"), /starter_import_dynamic_unresolved/);
  assert.deepEqual(imports("// import('../installation/install.ts')\nconst text = \"export * from '../owned/demo-seed.ts'\";"), []);
});

// `./lifecycle` runs before `npm ci` (`./lifecycle candidate` writes the lock the install reads, and `ownership` and
// `refusals` answer in a fresh extraction), so everything lifecycle.mjs loads at start-up must load without packages.
// Subcommands that run after the install load packages through dynamic `import()`, which is not part of start-up.
const preInstallEntries = ['lifecycle.mjs'];

/** Static runtime imports of one module: `import … from`, `import '…'` and `export … from`, never `import type`. */
function startupImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found: string[] = [];
  for (const match of code.matchAll(/^[ \t]*(import|export)[ \t]+(type[ \t]+)?([^'";]*?\bfrom[ \t\n]+)?['"]([^'"]+)['"]/gm)) {
    if (match[2] !== undefined || (match[1] === 'export' && match[3] === undefined)) continue;
    found.push(match[4]!);
  }
  return found;
}

/** Every package a pre-install entry point loads at start-up, as `file: specifier`; `visited` receives every module. */
function startupPackages(read: (path: string) => string | undefined, entries: readonly string[], visited = new Set<string>()): string[] {
  const packages: string[] = [];
  const visit = (path: string) => {
    if (visited.has(path)) return;
    visited.add(path);
    const source = read(path);
    if (source === undefined) throw new Error(`starter_import_unresolved: ${path}`);
    for (const specifier of startupImports(source)) {
      if (specifier.startsWith('.')) visit(resolve(dirname(path), specifier));
      else if (!specifier.startsWith('node:')) packages.push(`${path.slice(root.length + 1)}: ${specifier}`);
    }
  };
  for (const entry of entries) visit(resolve(root, entry));
  return packages;
}
const readSource = (path: string) => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } };

test('lifecycle.mjs loads no package at start-up, so it runs before npm ci', () => {
  assert.deepEqual(startupPackages(readSource, preInstallEntries), []);
});

test('negative witness: a package reached through a shared module is detected', () => {
  const entry = resolve(root, 'lifecycle.mjs'), bridge = resolve(root, 'shared/bridge.ts');
  for (const planted of ["import { x } from '@openlup/core/subscription';", "export { y } from 'pg';", "import 'zod';"]) {
    const files = new Map([[entry, "import { a } from './shared/bridge.ts';\nimport type { B } from '@openlup/platform';"], [bridge, planted]]);
    assert.equal(startupPackages(path => files.get(path), [entry]).length, 1, planted);
  }
  const typeOnly = new Map([[entry, "import type { B } from '@openlup/platform';\n// import 'pg';\nconst load = () => import('pg');"]]);
  assert.deepEqual(startupPackages(path => typeOnly.get(path), [entry]), []);
});

test('an extracted application outside any node_modules runs ./lifecycle ownership and refusals before npm ci', async () => {
  const ownership = JSON.parse(readFileSync(resolve(root, 'ownership.json'), 'utf8')) as
    { owned: string[]; managed: string[]; sourceMappings?: Record<string, string> };
  const target = await mkdtemp(join(tmpdir(), 'starter-pre-install-'));
  try {
    for (const file of [...ownership.owned, ...ownership.managed]) {
      await mkdir(dirname(join(target, file)), { recursive: true });
      // A source checkout keeps some files under their template name; an extracted application has the file itself.
      const mapped = ownership.sourceMappings?.[file];
      const source = mapped !== undefined && readSource(resolve(root, file)) === undefined ? mapped : file;
      await copyFile(resolve(root, source), join(target, file));
    }
    for (const command of ['ownership', 'refusals']) {
      const result = spawnSync(process.execPath, ['lifecycle.mjs', command], { cwd: target, encoding: 'utf8' });
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    }
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('the lifecycle transport witness copies every module lifecycle.mjs loads at start-up', () => {
  const modules = new Set<string>();
  assert.deepEqual(startupPackages(readSource, preInstallEntries, modules), []);
  const source = readFileSync(resolve(root, 'test/lifecycle.test.ts'), 'utf8');
  const list = /for \(const path of \[('lifecycle', 'lifecycle\.mjs',[^\]]*)\]\)/.exec(source)?.[1];
  assert.ok(list, 'the copied module list of the lifecycle transport witness');
  const copied = new Set([...list.matchAll(/'([^']+)'/g)].map(match => match[1]!));
  const missing = [...modules].map(path => path.slice(root.length + 1)).filter(path => !copied.has(path));
  assert.deepEqual(missing, []);
  // In the source checkout, the upgrade proof's installation-hint witness copies the same start-up modules.
  const upgradeProof = readSource(resolve(root, '../../scripts/packages/distribution-cli-proof.test.ts'));
  if (upgradeProof !== undefined) {
    const written = new Set([...upgradeProof.matchAll(/write\((?:starterLifecycle|"([^"]+)")/g)].map(match => match[1] ?? 'lifecycle.mjs'));
    const absent = [...modules].map(path => path.slice(root.length + 1)).filter(path => !written.has(path));
    assert.deepEqual(absent, []);
  }
});
