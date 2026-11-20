import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

test('installed catalogue rules preserve the base pin and exact declared units for a second type', async () => {
  const { readStarterCatalogueRules, prepareStarterCatalogueRules } = await import('../host/editor-catalogue.ts');
  const plan = prepareStarterCatalogueRules(readStarterCatalogueRules())!;
  assert.equal(plan.builds[0]?.pack.types[0]?.version, 714101500);
  await probeCatalogue(async app => {
    await changeRegistry(app, `types.push({
      key: 'starter:item', version: 2, dimensions: [],
      units: [{code: 'example:ml', dimension: 'volume', integral: true,
        factor: {canonicalUnit: 'openlup:ml', unscaled: '1', scale: 0}}],
      netContentUnits: ['example:ml'], validateContent: () => [],
    });
    ${registration}`);
    const planned = invoke(app, ['--input-type=module', '-e', `
      import {prepareStarterCatalogueRules, readStarterCatalogueRules} from './host/editor-catalogue.ts';
      const result = prepareStarterCatalogueRules(readStarterCatalogueRules());
      console.log(JSON.stringify(result.builds.map(({ authoring, pack }) =>
        ({ authoring, pin: pack.types[0].version, units: pack.types[0].netContentUnits }))));
    `]);
    assert.equal(planned.status, 0, planned.stderr);
    const [base, second] = JSON.parse(planned.stdout);
    assert.equal(base.pin, 714101500);
    assert.equal(second.authoring.version, 2);
    assert.notEqual(second.pin, base.pin);
    assert.deepEqual(second.units, ['example:ml']);
  });
});

const registration = 'export const catalogDraftRegistry = createCatalogProductTypeRegistry(types);';
const exampleRoot = fileURLToPath(new URL('../', import.meta.url));
async function changeRegistry(app: string, replacement: string) {
  const file = join(app, 'owned/catalogue.ts');
  const template = await readFile(join(exampleRoot, 'owned/catalogue.ts'), 'utf8');
  assert.ok(template.includes(registration));
  await writeFile(file, template.replace(registration, replacement));
}
async function probeCatalogue(work: (app: string) => Promise<void>) {
  const parent = join(exampleRoot, '.context');
  await mkdir(parent, { recursive: true });
  const app = await mkdtemp(join(parent, 'pinned-catalogue-'));
  try {
    for (const name of ['host', 'owned', 'shared', 'installation', 'lifecycle.mjs', 'browser-groups.mjs']) {
      await cp(join(exampleRoot, name), join(app, name), { recursive: true });
    }
    await writeFile(join(app, 'package.json'), '{"type":"module"}');
    await writeFile(join(app, 'docker'), '#!/bin/sh\necho called >> durable-effect\nexit 1\n', { mode: 0o700 });
    await writeFile(join(app, 'probe.mjs'), `
      import { registerHooks } from 'node:module';
      import { appendFileSync } from 'node:fs';
      registerHooks({ resolve(name, context, next) {
        if (name === 'pg') appendFileSync('durable-effect', 'database');
        return next(name, context);
      } });
    `);
    return await work(app);
  } finally { await rm(app, { recursive: true, force: true }); }
}
const invoke = (app: string, args: string[]) => spawnSync(process.execPath, args, {
  cwd: app, env: { PATH: app }, encoding: 'utf8', timeout: 15_000,
});

test('a resolve-only registry fits both catalogue imports and retains the base fallback', async () => {
  await probeCatalogue(async app => {
    await changeRegistry(app, `
      import type { CatalogProductTypeRegistry as ContractsRegistry } from '@openlup/platform/catalog/contracts';
      import type { CatalogProductTypeRegistry } from '@openlup/platform/catalog';
      const local = createCatalogProductTypeRegistry(types);
      export const catalogDraftRegistry = { resolve: local.resolve } satisfies CatalogProductTypeRegistry & ContractsRegistry;
    `);
    const root = fileURLToPath(new URL('../', import.meta.url));
    const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
    const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const program = ts.createProgram([join(app, 'host/editor-catalogue.ts')], options);
    const errors = ts.getPreEmitDiagnostics(program);
    assert.equal(errors.length, 0, errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
    const result = invoke(app, ['--input-type=module', '-e', `
      import {prepareStarterCatalogueRules, readStarterCatalogueRules} from './host/editor-catalogue.ts';
      const { builds } = prepareStarterCatalogueRules(readStarterCatalogueRules());
      console.log(JSON.stringify(builds.map(({ pack }) => pack.types[0].version)));
    `]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [714101500]);
  });
});

test('up and install report catalogue input paths before Docker or database effects', async () => {
  await probeCatalogue(async app => {
    const cases = [
      { replacement: `types.push({ ...types[0], key: 'example:article', version: 2, taxClass: 'example:standard' });\n${registration}`,
        diagnostic: /starter_catalogue_rules_reference_unsupported\nowned\/catalogue.ts \/types\/1\/taxClass/u },
      { replacement: `const local = createCatalogProductTypeRegistry(types.map(row => ({ ...row, version: 2 })));
        export const catalogDraftRegistry = { resolve: local.resolve };`,
        diagnostic: /starter_catalogue_rules_registry_required\nowned\/catalogue.ts \/definitions.*createCatalogProductTypeRegistry/u },
      { replacement: `types.push({ ...types[0], version: 0 });\n${registration}`,
        diagnostic: /owned\/catalogue.ts \/1\/version/u },
      { replacement: `types.push(types[0]);\n${registration}`,
        diagnostic: /owned\/catalogue.ts \/1\//u },
    ];
    for (const { replacement, diagnostic } of cases) {
      await changeRegistry(app, replacement);
      for (const command of ['up', 'install']) {
        const result = invoke(app, ['--import', './probe.mjs', 'lifecycle.mjs', command, '--configuration', 'supplements']);
        assert.equal(result.status, 2, result.stderr);
        assert.match(result.stderr, diagnostic);
        assert.ok(result.stderr.trim().split('\n').every(line => line.length <= 240));
        await assert.rejects(readFile(join(app, 'durable-effect')), { code: 'ENOENT' });
      }
    }
    await changeRegistry(app, registration);
    await writeFile(join(app, 'owned/catalogue-rules.cjs'), 'module.exports = {};');
    for (const command of ['up', 'install']) {
      const result = invoke(app, ['--import', './probe.mjs', 'lifecycle.mjs', command, '--configuration', 'supplements']);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /owned\/catalogue-rules.cjs.*validateContent.*Export/u);
      await assert.rejects(readFile(join(app, 'durable-effect')), { code: 'ENOENT' });
    }
  });
});

test('preflight reserves historical and retained pins before provisioning', async () => {
  await probeCatalogue(async app => {
    const directory = join(app, '.context/catalogue-builds');
    await mkdir(directory, { recursive: true });
    const retainedName = `${encodeURIComponent('example:article')}@42.json`;
    for (const [name, key, version, metadata] of [
      ['714101500.json', 'starter:item', 714101500, ''],
      ['714101500.json', 'starter:item', 714101500, ", units: [{code: 'openlup:ml', dimension: 'volume', integral: true}], netContentUnits: ['openlup:ml']"],
      [retainedName, 'example:article', 42, ''],
    ] as const) {
      await changeRegistry(app, `types.push({...types[0], key: '${key}', version: ${version}${metadata}});
${registration}`);
      await writeFile(join(app, 'owned/catalogue-rules.cjs'), await readFile(join(exampleRoot, 'owned/catalogue-rules.cjs'), 'utf8') + '\n// Changed rules');
      await writeFile(join(directory, name), 'Retained build marker');
      for (const command of ['up', 'install']) {
        const result = invoke(app, ['--import', './probe.mjs', 'lifecycle.mjs', command]);
        assert.equal(result.status, 2, result.stderr);
        assert.match(result.stderr, /starter_catalogue_rules_version_conflict\nowned\/catalogue.ts \/types\/1\/version/u);
        assert.ok(result.stderr.includes(`Choose a different version number for ${key}`));
        await assert.rejects(readFile(join(app, 'durable-effect')), { code: 'ENOENT' });
      }
      await rm(join(directory, name));
    }
    await cp(join(exampleRoot, 'Dockerfile'), join(app, 'Dockerfile'));
    await writeFile(join(app, 'docker'), `#!/bin/sh
case "$1 $2" in
  'compose config') echo '{"volumes":{"catalogue-builds":{"name":"fixture-builds"}}}' ;;
  'volume ls') echo fixture-builds ;;
  'run --rm') echo '${retainedName}' ;;
  *) : > durable-effect; exit 1 ;;
esac
`);
    const result = invoke(app, ['lifecycle.mjs', 'up']);
    assert.match(result.stderr, /Choose a different version number for example:article/u);
    await assert.rejects(readFile(join(app, 'durable-effect')), { code: 'ENOENT' });
  });
});
