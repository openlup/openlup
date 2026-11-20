import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

test('starter editor host and browser consumers fit the selected public package contracts', () => {
  const root = fileURLToPath(new URL('../',import.meta.url));
  const configuration = ts.readConfigFile(root+'tsconfig.json',ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configuration.config,ts.sys,root);
  const files = ['host/subscription-editors.ts','host/editor-ports.ts','host/editor-mail.ts','installation/install.ts','owned/store.config.ts',
    'client/pages/classic-editor.ts','client/pages/sized-editor.ts','client/editors/entries.ts',
    'browser/editor-components.spec.ts','browser/subscription-journeys.spec.ts','browser/subscription-api.spec.ts',
    'playwright.editors.config.ts','playwright.database.config.ts'].map(path => root+path);
  const program = ts.createProgram(files,parsed.options);
  const errors = ts.getPreEmitDiagnostics(program);
  assert.equal(errors.length,0,ts.formatDiagnosticsWithColorAndContext(errors,{ getCurrentDirectory: () => root,getCanonicalFileName: path => path,getNewLine: () => '\n' }));
});

test('starter editor cadence configuration uses number representation bounds instead of a business cap', async () => {
  const { configurations } = await import('../owned/store.config.ts');
  const { assertEditorConfig } = await import('../shared/subscription-edit.ts');
  const config = structuredClone(Object.values(configurations)[0]!.subscriptionEditing);
  config.planDays = [180]; config.sized.allowedCadences = [180];
  assert.doesNotThrow(() => assertEditorConfig(config));
  for (const days of [0, 1.5, 2_147_483_648]) {
    config.planDays = [days]; assert.throws(() => assertEditorConfig(config), /starter_subscription_configuration_invalid/u);
  }
});

const starterRoot = fileURLToPath(new URL('../', import.meta.url));
const registration = 'export const catalogDraftRegistry = createCatalogProductTypeRegistry(types);';
const resolveOnlyRegistry = `const registry = createCatalogProductTypeRegistry(types);
export const catalogDraftRegistry = { resolve: registry.resolve };`;

test('the starter typechecks with an inferred resolve-only catalogue registry', () => {
  const configuration = ts.readConfigFile(resolve(starterRoot, 'tsconfig.json'), ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(configuration.config, ts.sys, starterRoot);
  const owned = resolve(starterRoot, 'owned/catalogue.ts');
  const host = ts.createCompilerHost(options);
  const read = host.readFile;
  host.readFile = file => {
    const source = read(file);
    if (resolve(file) !== owned || source === undefined) return source;
    assert.ok(source.includes(registration));
    return source.replace(registration, resolveOnlyRegistry);
  };
  const files = ['host/operator-composition.ts', 'installation/install.ts'].map(file => resolve(starterRoot, file));
  const errors = ts.getPreEmitDiagnostics(ts.createProgram(files, options, host));
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors,
    { getCurrentDirectory: () => starterRoot, getCanonicalFileName: file => file, getNewLine: () => '\n' }));
});

const bootstrapProbe = String.raw`
import { registerHooks } from 'node:module';
registerHooks({
  resolve(name, context, next) {
    if (name === 'pg' || name === '@openlup/platform/migrations')
      return { url: new URL(name === 'pg' ? './pg-probe.mjs' : './migrations-probe.mjs', import.meta.url).href, shortCircuit: true };
    return next(name, context);
  },
});
`;
const postgresProbe = String.raw`
import { appendFileSync } from 'node:fs';
export default { Client: class {
  async connect() {}
  async end() {}
  async query(sql) {
    if (/^CREATE |^COMMENT /u.test(sql)) appendFileSync('durable-effects', sql.split(' ').slice(0, 2).join(' ') + '\n');
    if (sql.includes('session_user AS login'))
      return { rows: [{ login: 'starter_install', role: 'starter_install', marker: 'openlup-neutral-store-demo-v1' }] };
    return { rows: [] };
  }
} };
`;
const migrationsProbe = String.raw`
import { appendFileSync } from 'node:fs';
export function createPlatformPostgresMigrationRunner() {
  return {
    async apply() { appendFileSync('durable-effects', 'MIGRATIONS\n'); return { applied: [] }; },
    async status() { return { applied: [], pending: [] }; },
  };
}
`;

test('first up and the real bootstrap refuse local catalogue errors before durable effects', async t => {
  const scratch = resolve(starterRoot, '.context');
  await mkdir(scratch, { recursive: true });
  const app = await mkdtemp(resolve(scratch, 'catalogue-bootstrap-'));
  try {
    for (const file of ['host', 'shared', 'owned', 'installation', 'browser-groups.mjs', 'lifecycle.mjs'])
      await cp(resolve(starterRoot, file), resolve(app, file), { recursive: true });
    await writeFile(resolve(app, 'package.json'), '{"type":"module"}');
    await writeFile(resolve(app, 'bootstrap-probe.mjs'), bootstrapProbe);
    await writeFile(resolve(app, 'pg-probe.mjs'), postgresProbe);
    await writeFile(resolve(app, 'migrations-probe.mjs'), migrationsProbe);
    await writeFile(resolve(app, 'docker'), `#!/bin/sh
echo DOCKER >> durable-effects
exit 1
`, { mode: 0o700 });
    const file = resolve(app, 'owned/catalogue.ts');
    const original = await readFile(file, 'utf8');
    assert.ok(original.includes(registration));
    const effects = resolve(app, 'durable-effects');
    async function refuseWithoutEffects(command: string, name: string, ...lines: string[]) {
      await writeFile(effects, '');
      const result = spawnSync(process.execPath, ['--import', './bootstrap-probe.mjs', 'lifecycle.mjs', command, '--configuration', 'supplements'], {
        cwd: app, env: { PATH: app }, encoding: 'utf8', timeout: 15_000,
      });
      assert.equal(await readFile(effects, 'utf8'), '', `${name}: ${command} must have zero durable effects`);
      assert.equal(result.status, 2, result.stderr);
      const printed = result.stderr.trimEnd().split('\n');
      assert.ok(printed.every(line => line.length <= 240), `${name}: every diagnostic line fits the installation hint bound`);
      assert.deepEqual(printed, lines, name);
    }
    const addType = (fields: string, key = 'example:accessory', version = 7) =>
      `types.push({ ...types[0]!, key: ${JSON.stringify(key)}, version: ${version}, ${fields} });\n${registration}`;
    const version = 2_147_483_647;
    const type = 'example:' + 'a'.repeat(108) + 'item';
    const profile = 'example:' + 'b'.repeat(108) + 'plan';
    const shortType = `example:${'a'.repeat(29)}…${'a'.repeat(33)}item@${version}`;
    const shortProfile = `example:${'b'.repeat(29)}…${'b'.repeat(33)}plan@${version}`;
    for (const [name, replacement, code, hint] of [
      ['resolve-only', resolveOnlyRegistry, 'starter_catalogue_rules_registry_required',
        'Export a registry from owned/catalogue.ts using createCatalogProductTypeRegistry, or provide its definitions list.'],
      ['tax class', addType("taxClass: 'example:standard'"), 'starter_catalogue_rules_reference_unsupported',
        'Remove taxClass from example:accessory@7 in owned/catalogue.ts (example:standard).'],
      ['subscription profile', addType("subscriptionProfileRef: { key: 'example:plan', version: 2 }"),
        'starter_catalogue_rules_reference_unsupported',
        'Remove subscriptionProfileRef from example:accessory@7 in owned/catalogue.ts (example:plan@2).'],
      ['long tax class', addType(`taxClass: '${'c'.repeat(120)}'`, type, version), 'starter_catalogue_rules_reference_unsupported',
        `Remove taxClass from ${shortType} in owned/catalogue.ts (${'c'.repeat(37)}…${'c'.repeat(37)}).`],
      ['long subscription profile', addType(`subscriptionProfileRef: { key: '${profile}', version: ${version} }`, type, version),
        'starter_catalogue_rules_reference_unsupported',
        `Remove subscriptionProfileRef from ${shortType} in owned/catalogue.ts (${shortProfile}).`],
    ] as const) await t.test(name, async () => {
      await writeFile(file, original.replace(registration, replacement));
      for (const command of ['up', 'install'])
        await refuseWithoutEffects(command, name, code, hint);
    });
    await t.test('missing rules hook', async () => {
      await writeFile(file, original);
      await writeFile(resolve(app, 'owned/catalogue-rules.cjs'), 'module.exports = {};');
      await refuseWithoutEffects('up', 'missing rules hook',
        'Export validateContent as a function. Product rule validateContent must be a function.');
      await refuseWithoutEffects('install', 'missing rules hook',
        'Product rule validateContent must be a function. Export it as a function.');
    });
  } finally { await rm(app, { recursive: true, force: true }); }
});
