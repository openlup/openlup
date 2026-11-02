import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, sep, extname } from 'node:path';
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
    if (path === resolve(root, 'installation') || path.startsWith(resolve(root, 'installation') + sep)
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

test('host and client transitive imports never reach installation or the owned demo seed', async () => {
  const files = new Map<string, string>();
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile()) files.set(path, await readFile(path, 'utf8'));
    }
  }
  for (const directory of ['host', 'client', 'owned', 'shared', 'installation']) await collect(resolve(root, directory));
  const entries = [...files.keys()].filter(path => path.startsWith(resolve(root, 'host') + sep)
    || path.startsWith(resolve(root, 'client') + sep));
  assertRuntimeBoundary(files, entries);
});

for (const planted of [
  "import '../installation/install.ts';",
  "const load = () => import('../installation/install.ts');",
  "export { installDemonstration } from '../installation/install.ts';",
  "export * from '../owned/demo-seed.ts';",
]) {
  test(`negative witness: transitive planted forbidden import is detected: ${planted}`, () => {
    const entry = resolve(root, 'host/entry.ts');
    const bridge = resolve(root, 'shared/bridge.ts');
    const files = new Map([[entry, "export * from '../shared/bridge.ts';"], [bridge, planted]]);
    assert.throws(() => assertRuntimeBoundary(files, [entry]), /starter_runtime_install_import_forbidden/);
  });
}

test('computed dynamic imports cannot conceal an installation edge', () => {
  assert.throws(() => imports('import(`../installation/${name}.ts`)'), /starter_import_dynamic_unresolved/);
  assert.throws(() => imports("import('../' + name)"), /starter_import_dynamic_unresolved/);
  assert.deepEqual(imports("// import('../installation/install.ts')\nconst text = \"export * from '../owned/demo-seed.ts'\";"), []);
});
