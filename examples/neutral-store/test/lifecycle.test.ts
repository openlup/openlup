import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env as processEnv } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { catalogueUpgradeFixture } from './catalogue-upgrade-fixture.ts';
import { prepareRuntimeHandoff } from '../host/runtime-database.ts';
import { configurations, selectConfiguration } from '../owned/store.config.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const oneLine = (stdout: string) => {
  assert.match(stdout, /^[^\n]+\n$/u);
  return JSON.parse(stdout);
};
const findingKeys = ['cause', 'code', 'fix', 'observed', 'path', 'recheck'];
const reportKeys = ['command', 'configuration', 'exitCode', 'findings', 'formatVersion', 'packs', 'state'];

test('up_json_reports_four_fields_for_installer_refusal and verifies the real one-shot emitter', async () => {
  const scratch = join(root, '.context');
  mkdirSync(scratch, { recursive: true });
  const app = mkdtempSync(join(scratch, 'lifecycle-transport-'));
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'lifecycle-home-'));
  const env = { ...processEnv, HOME: home, PATH: [app, dirname(process.execPath), '/usr/bin', '/bin', processEnv.PATH ?? ''].join(delimiter) };
  const observed = 'The rules file is absent for 1 adopter packs. é\n\r\t' + 'x'.repeat(500);
  const summary = { id: 'example:pack', version: 1, outcome: 'installed', types: [{ key: 'example:item', version: 2_147_483_647 }], taxClasses: ['example:standard'] };
  const accepted = { formatVersion: 1, configuration: 'coffee', exitCode: 0, state: 'satisfied', packs: [summary], findings: [] };
  try {
    for (const path of ['lifecycle', 'lifecycle.mjs', 'browser-groups.mjs', 'lifecycle-refusals.mjs',
      'host/healthcheck.ts', 'host/runtime-database.ts', 'installation/refusals.ts', 'shared/refusals.ts', 'shared/seed-physical.ts', 'shared/config.ts']) {
      mkdirSync(join(app, path, '..'), { recursive: true });
      cpSync(join(root, path), join(app, path));
    }
    mkdirSync(join(app, 'owned'));
    writeFileSync(join(app, 'package.json'), '{"type":"module"}');
    const config = "export const selectConfiguration = (id = 'coffee') => ({ id });";
    const configFile = join(app, 'owned/store.config.ts');
    writeFileSync(configFile, config);
    writeFileSync(join(app, 'shared/config.ts'), "export const assertConfig = () => {}; export const isConfigurationId = id => typeof id === 'string'; export const parseStarterPort = () => 4319;");
    writeFileSync(join(app, 'installation/install.ts'), `
      import { refusal } from './refusals.ts';
      import { starterDiagnostic } from '../shared/refusals.ts';
      import { env } from 'node:process';
      export const bootstrapDemonstration = () => {};
      export function installDemonstration(config, bootstrap, progress) {
        progress.write('installer progress\\n');
        if (env.ST1_CARRIER_CASE === 'legacy-conflict') throw Object.assign(
          starterDiagnostic('starter_catalogue_build_conflict'), { code: 'EEXIST' });
        if (env.ST1_CARRIER_CASE === 'price-conflict') throw starterDiagnostic('starter_price_seed_conflict');
        if (env.ST1_CARRIER_CASE === 'driver') throw new Error('starter_price_seed_conflict');
        if (env.ST1_CARRIER_CASE === 'success') return [${JSON.stringify(summary)}];
        if (env.ST1_CARRIER_CASE === 'large') return Array.from({ length: 9000 }, (_, i) => ({
          ...${JSON.stringify(summary)}, id: 'example:' + i, types: [{ key: 'example:item-' + i, version: 1 }]
        }));
        throw refusal('starter_catalogue_rules_required', 'owned/catalogue-rules.cjs', ${JSON.stringify(observed)},
          'Installing an adopter pack requires a publication rules bundle.', 'Restore the tested bundle.', 'Recheck the demo.');
      }
    `);
    writeFileSync(join(app, 'docker'), `#!${process.execPath}
      import { spawn } from 'node:child_process';
      import { appendFileSync, readFileSync, unlinkSync } from 'node:fs';
      import { env } from 'node:process';
      const args = process.argv.slice(2), mode = env.ST1_CARRIER_CASE;
      appendFileSync('calls', JSON.stringify(args) + '\\n');
      const call = args[1] === '--project-name' ? args[3] : args[1];
      if (call === 'config') { process.stdout.write('{"name":"transport"}'); }
      else if (call !== 'run') {
        process.stdout.write('compose progress\\n');
        if (mode === 'missing-installer' && args.at(-1) === 'database') unlinkSync(process.argv[1]);
        if ((mode === 'before' && call === 'build') || (mode === 'wait' && args.at(-1) === 'database')
          || (mode === 'after' && args.at(-1) === 'application')) process.exitCode = 1;
      } else if (mode === 'signal') process.kill(process.pid, 'SIGTERM');
      else if (mode.startsWith('fake') || mode === 'after') {
        const bytes = readFileSync('child-report');
        const accent = bytes.indexOf(Buffer.from('é'));
        const split = accent < 0 ? 17 : accent + 1;
        process.stdout.write(bytes.subarray(0, split));
        setImmediate(() => process.stdout.write(bytes.subarray(split)));
        process.exitCode = Number(env.ST1_CARRIER_STATUS);
      } else {
        const child = spawn(process.execPath, args.slice(args.indexOf('node') + 1), { stdio: 'inherit' });
        child.on('close', code => { process.exitCode = code ?? 1; });
      }
    `, { mode: 0o755 });
    const up = (mode: string, args = ['--json', '--configuration', 'coffee'], bytes: string | Uint8Array = JSON.stringify(accepted) + '\n', status = 0) => {
      writeFileSync(join(app, 'child-report'), bytes);
      writeFileSync(join(app, 'calls'), '');
      const noInstaller = mode === 'missing-installer';
      const run = spawnSync(noInstaller ? process.execPath : './lifecycle', [...(noInstaller ? ['lifecycle.mjs'] : []), 'up', ...args],
        { cwd: app, encoding: 'utf8', maxBuffer: 4_194_304,
          env: { ...env, ...(noInstaller ? { PATH: app } : {}), ST1_CARRIER_CASE: mode, ST1_CARRIER_STATUS: String(status) } });
      assert.ifError(run.error);
      const calls: string[][] = readFileSync(join(app, 'calls'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      if (!args.includes('--json')) return { run, calls, report: undefined };
      const report = oneLine(run.stdout);
      assert.deepEqual(Object.keys(report).sort(), reportKeys);
      assert.equal(run.status, report.exitCode);
      assert.equal(report.command, 'up');
      if (report.state === 'violated') assert.deepEqual(Object.keys(report.findings[0]).sort(), findingKeys);
      return { run, calls, report };
    };
    const refusal = up('refusal');
    assert.deepEqual(refusal.calls[3], ['compose', '--project-name', 'transport', 'run', '--rm', '--no-deps', '-T', 'installation',
      'node', 'lifecycle.mjs', 'install', '--configuration', 'coffee', '--json']);
    assert.match(refusal.run.stderr, /compose progress/u);
    assert.doesNotMatch(refusal.run.stderr, /installer progress/u);
    assert.equal(refusal.report.configuration, 'coffee');
    assert.deepEqual(refusal.report.packs, []);
    assert.equal(refusal.report.findings[0].observed, observed);
    assert.equal(refusal.report.findings[0].code, 'starter_catalogue_rules_required');
    assert.equal(refusal.calls.length, 4);
    const { command: _up, ...refusalEnvelope } = refusal.report;
    assert.equal(up('fake', undefined, JSON.stringify(refusalEnvelope) + '\n', 2).report.findings[0].observed, observed);
    for (const [code, path, fix] of [
      ['checkout_recovery_schedule_change_blocked_open_episodes', 'checkoutRecoveryReminders', 'Keep the current schedule in effect.'],
      ['fulfillment_stock_current_idempotency_conflict', 'owned/store.config.ts', 'Restore the original stock inputs for this SKU, then rerun the demo installer.'],
    ]) {
      const finding = { ...refusalEnvelope.findings[0], code, path, fix };
      const result = up('fake', undefined, JSON.stringify({ ...refusalEnvelope, findings: [finding] }) + '\n', 2);
      assert.deepEqual(result.report.findings, [finding]);
      assert.equal(result.calls.length, 4);
    }
    const text = up('refusal', ['--configuration', 'coffee']);
    assert.equal(text.run.status, 2);
    assert.match(text.run.stderr, /starter_catalogue_rules_required\nObserved: .*é\\n\\r\\t[^\n]+\nCause: /u);
    assert.equal(text.calls.length, 4);
    assert.deepEqual(up('success', ['--configuration', 'coffee', '--json']).report.packs, [summary]);
    for (const [mode, code, fix] of [
      ['legacy-conflict', 'starter_catalogue_build_conflict', /Restore the original declaration and rules.*new pack version/u],
      ['price-conflict', 'starter_price_seed_conflict', /owned price, discount or rounding inputs after seeding, restore the originals.*reconcile divergent seed rows with the original demo inputs.*close other active or open explicit subscription rows or withdraw pending rows.*rebuild a disposable demo/u],
      ['driver', 'starter_installation_failed', /Compose availability/u],
    ] as const) {
      const { report, calls } = up(mode);
      assert.equal(report.findings[0].code, code);
      assert.match(report.findings[0].fix, fix);
      assert.deepEqual(report.packs, []);
      assert.equal(calls.length, 4);
      const privateText = spawnSync(process.execPath, ['lifecycle.mjs', 'install', '--configuration', 'coffee'],
        { cwd: app, encoding: 'utf8', env: { ...env, ST1_CARRIER_CASE: mode } });
      assert.equal(privateText.status, 2);
      assert.equal(privateText.stderr, (mode === 'driver' ? 'starter_price_seed_conflict' : code) + '\n');
    }
    const large = up('large');
    assert.ok(Buffer.byteLength(large.run.stdout) > 1_048_576);
    assert.equal(large.report.packs.length, 9000);
    assert.equal(large.calls.at(-1)?.at(-1), 'runtime-probe');

    for (const [args, code] of [
      [['--json', '--unknown'], 'starter_argument_unknown'],
      [['--json', '--json'], 'starter_argument_duplicate'],
      [['--configuration', '--json'], 'starter_argument_value_required'],
      [['--configuration', 'coffee', '--configuration', 'coffee', '--json'], 'starter_argument_duplicate'],
    ] as const) {
      const { report, calls } = up('unused', [...args]);
      assert.equal(report.configuration, '');
      assert.equal(report.findings[0].code, code);
      assert.deepEqual(calls, []);
    }
    writeFileSync(configFile, 'throw new Error("private-import-detail");');
    const importRefusal = up('unused');
    assert.equal(importRefusal.report.configuration, '');
    assert.equal(importRefusal.report.findings[0].code, 'starter_installation_failed');
    assert.ok(!JSON.stringify(importRefusal.report).includes('private-import-detail'));
    writeFileSync(configFile, config);

    const intact = JSON.stringify(accepted) + '\n';
    const values = [0, 2_147_483_648, 1.5, '1'];
    const invalid = [
      '', 'noise\n' + intact, intact + intact, '{\n', intact.trimEnd(), Buffer.from([0xc3, 0x0a]),
      ...[{ exitCode: 2 }, { state: 'violated' }, { configuration: 'supplements' }, { formatVersion: 2 }, { extra: true },
        ...values.flatMap(version => [{ packs: [{ ...summary, version }] },
          { packs: [{ ...summary, types: [{ ...summary.types[0], version }] }] }]),
      ].map(overrides => JSON.stringify({ ...accepted, ...overrides }) + '\n'),
    ];
    const unknown = { ...accepted, packs: [], exitCode: 2, state: 'violated',
      findings: [{ ...refusal.report.findings[0], code: 'starter_unknown_underscore_name' }] };
    for (const [mode, bytes, status] of [
      ...invalid.map(bytes => ['fake', bytes, 0] as const), ['fake', intact, 2] as const, ['signal', intact, 0] as const,
      ['fake', JSON.stringify(unknown) + '\n', 2] as const,
      ['before', intact, 0] as const, ['wait', intact, 0] as const, ['after', intact, 0] as const,
    ]) {
      const { report, calls } = up(mode, undefined, bytes, status);
      assert.equal(report.findings[0].code, 'starter_installation_failed');
      assert.equal(report.findings[0].path, '/installation');
      assert.deepEqual(report.packs, mode === 'after' ? [summary] : []);
      assert.equal(calls.some(args => args.at(-1) === 'application'), mode === 'after');
    }
    const noInstaller = up('missing-installer');
    assert.equal(noInstaller.report.findings[0].code, 'starter_installation_failed');
    assert.equal(noInstaller.calls.length, 3);
    const missing = spawnSync(process.execPath, ['lifecycle.mjs', 'up', '--json'], { cwd: app, encoding: 'utf8', env: { PATH: app } });
    assert.equal(missing.status, 2);
    assert.equal(oneLine(missing.stdout).findings[0].code, 'starter_installation_failed');
    // Keep the production configuration validator and change only the owned fixture.
    for (const directory of ['shared', 'owned']) cpSync(join(root, directory), join(app, directory), { recursive: true });
    const realConfig = readFileSync(configFile, 'utf8').replace('export function selectConfiguration', 'function fixtureConfiguration');
    const { defaultConfigurationId } = await import('../owned/store.config.ts');
    for (const route of ['up', 'install']) {
      const result = spawnSync(process.execPath, ['lifecycle.mjs', route, '--json', '--configuration', 'unknown-configuration'],
        { cwd: app, encoding: 'utf8', env });
      assert.equal(result.status, 2);
      const report = oneLine(result.stdout);
      assert.equal(report.configuration, '');
      assert.equal(report.findings[0].code, 'starter_configuration_unknown');
    }
    const presentation = 'renewal.subscriptionCare.retention.offerPresentation';
    for (const [overrides, expectedId, code, path, fix] of [
      ['id: 42', '', 'starter_configuration_invalid', '/configuration'],
      ['id: 123', '', 'starter_configuration_invalid', '/configuration'],
      ['recovery: {}', defaultConfigurationId, 'starter_recovery_configuration_invalid', '/configuration'],
      [`renewal: { ...config.renewal, subscriptionCare: {
        ...config.renewal.subscriptionCare, retention: { ...config.renewal.subscriptionCare.retention, offerPresentation: 'always' },
      } }`, defaultConfigurationId, 'starter_retention_configuration_invalid', presentation,
        `Set ${presentation} to ask_permission_first or off, or omit it for ask_permission_first.`],
    ]) {
      writeFileSync(configFile, realConfig + `\nexport function selectConfiguration() {
        const config = fixtureConfiguration();
        return { ...config, ${overrides} };
      }\n`);
      for (const route of ['up', 'install']) {
        const result = spawnSync(process.execPath, ['lifecycle.mjs', route, '--json'], { cwd: app, encoding: 'utf8', env });
        const report = oneLine(result.stdout);
        assert.equal(result.status, 2, result.stderr);
        assert.equal(report.configuration, expectedId);
        assert.equal(report.findings[0].code, code);
        assert.equal(report.findings[0].path, path);
        if (fix) assert.equal(report.findings[0].fix, fix);
        if (code === 'starter_recovery_configuration_invalid') assert.match(report.findings[0].fix, /required recovery states/u);
        assert.deepEqual(report.packs, []);
        assert.equal(result.stderr, '');
      }
    }
  } finally { rmSync(app, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

// Nested extraction checks reuse the checkout's dependencies. The packed consumer installs its own.
const extractionSharesDependencies = existsSync(join(root, '.starter-origin.json'))
  && !existsSync(join(root, 'node_modules/@openlup/platform/package.json'));
test('physical findings precede Docker, bootstrap, runtime connection and key preparation', {
  skip: extractionSharesDependencies && 'The packed starter suite runs the subprocess witness.',
}, () => {
  const scratch = join(root, '.context');
  mkdirSync(scratch, { recursive: true });
  const app = mkdtempSync(join(scratch, 'physical-findings-'));
  const env = { ...processEnv, PATH: [app, dirname(process.execPath), '/usr/bin', '/bin', processEnv.PATH ?? ''].join(delimiter) };
  try {
    for (const path of ['lifecycle', 'lifecycle.mjs', 'lifecycle-refusals.mjs', 'browser-groups.mjs', 'host', 'shared', 'owned', 'installation'])
      cpSync(join(root, path), join(app, path), { recursive: true });
    writeFileSync(join(app, 'package.json'), '{"type":"module"}');
    writeFileSync(join(app, 'docker'), '#!/bin/sh\nprintf "docker\\n" >> io\nexit 70\n', { mode: 0o755 });
    const install = join(app, 'installation/install.ts');
    const instrumented = readFileSync(install, 'utf8').replace(/^(export async function (prepareDemonstrationQuoteKey|bootstrapDemonstration)\(.*\)[: ].* \{)$/gmu,
      (_, declaration, name) => declaration + '\n  appendFileSync("io", ' + JSON.stringify(name + '\n') + ');');
    assert.equal([...instrumented.matchAll(/appendFileSync\("io"/gu)].length, 2);
    writeFileSync(install, "import { appendFileSync } from 'node:fs';\n" + instrumented);
    mkdirSync(join(app, 'node_modules/pg'), { recursive: true });
    writeFileSync(join(app, 'node_modules/pg/package.json'), '{"name":"pg","type":"module","exports":"./index.js"}');
    writeFileSync(join(app, 'node_modules/pg/index.js'), `
      import { appendFileSync } from 'node:fs';
      class Connection {
        async connect() { appendFileSync('io', 'connect\\n'); }
        async query() { appendFileSync('io', 'sql\\n'); throw new Error('unexpected SQL'); }
        async end() {}
      }
      export default { Client: Connection, Pool: Connection };
    `);
    writeFileSync(join(app, 'host/quote-secret.ts'), `
      import { appendFileSync } from 'node:fs';
      export async function readQuoteAcceptanceKeyring() { appendFileSync('io', 'runtime key\\n'); throw new Error('unexpected key'); }
    `);
    const owner = join(app, 'owned/store.config.ts'), original = readFileSync(owner, 'utf8');
    const config = selectConfiguration();
    const recheck = 'Restart the starter and recheck `/api/config`.';
    for (const [edit, finding] of [
      ["selectConfiguration().offer.products[0].physical.primaryUnitIdentifier.issuer = ' demo';", {
        code: 'OPENLUP_E_STARTER_PRODUCT_PHYSICAL_INVALID', path: 'offer.products[].physical', subject: config.offer.products[0]!.sku,
        observed: 'The configured product physical facts were refused.',
        cause: 'Seed products require positive whole grams in the signed 32-bit range, a valid primary gs1:gtin and an unchanged issuer.',
        fix: 'Apply the owned configuration migration where needed and correct the entry from verified facts. If correcting the issuer changes the retained seed digest, use “Reset an interrupted first install” for an owner-approved rebuild of the disposable demonstration in the same Compose project. That procedure removes all data in the demo volume.',
        recheck,
      }],
      ["selectConfiguration().subscriptionEditing.catalogue[1].physicalSize = 2147483648;", {
        code: 'OPENLUP_E_STARTER_SYNTHETIC_PHYSICAL_SIZE_INVALID', path: 'subscriptionEditing.catalogue[].physicalSize', subject: config.subscriptionEditing.catalogue[1]!.sku,
        observed: 'The configured editor catalogue size was refused.',
        cause: 'The size must be a number of whole grams from 1 through 2147483647.',
        fix: 'Correct the affected `physicalSize` in `owned/subscription-editing.ts` to the verified supported whole-gram size.',
        recheck,
      }],
    ] as const) {
      writeFileSync(owner, original + '\n' + edit + '\n');
      const invoke = (...args: string[]) => spawnSync(process.execPath, args, { cwd: app, env, encoding: 'utf8', timeout: 10_000 });
      const configured = ['--configuration', config.id];
      const runtime = ['--database-url', 'postgresql://starter_runtime@database/neutral_store'];
      const { code, path, subject, observed, cause, fix } = finding;
      const expectedText = [code, 'Observed: ' + observed, 'Cause: ' + cause, 'Fix: ' + fix,
        'Recheck: ' + recheck, 'Subject: ' + subject, ''].join('\n');
      for (const command of ['up', 'install', 'serve-demo']) {
        writeFileSync(join(app, 'io'), '');
        const text = invoke('lifecycle.mjs', command, ...configured, ...(command === 'serve-demo' ? runtime : []));
        assert.ifError(text.error);
        assert.deepEqual([text.status, text.stdout, text.stderr], [2, '', expectedText]);
        if (command !== 'serve-demo') {
          const json = invoke('lifecycle.mjs', command, ...configured, '--json');
          assert.ifError(json.error);
          assert.deepEqual([json.status, json.stderr], [2, '']);
          assert.deepEqual(oneLine(json.stdout), {
            ...(command === 'up' ? { command } : {}), formatVersion: 1, configuration: config.id,
            exitCode: 2, state: 'violated', packs: [], findings: [finding],
          });
        }
        assert.equal(readFileSync(join(app, 'io'), 'utf8'), '', command);
      }
      const host = invoke('--input-type=module', '--eval', `
        import assert from 'node:assert/strict';
        import { resolve } from 'node:path';
        import { readStarterDiagnostic } from './shared/refusals.ts';
        process.argv = [process.execPath, resolve('host/server.ts'), ...${JSON.stringify([...configured, ...runtime,
          '--quote-acceptance-key-file', 'never-read.json'])}];
        await assert.rejects(import('./host/server.ts'), error => {
          assert.equal(Object.getPrototypeOf(error), Error.prototype);
          assert.deepEqual(Reflect.ownKeys(error).filter(key => key !== 'stack'), ['message']);
          assert.equal(error.message, ${JSON.stringify(code)});
          assert.deepEqual(readStarterDiagnostic(error), ${JSON.stringify({ code, guidance: { path, fix, subject } })});
          return true;
        });
      `);
      assert.ifError(host.error);
      assert.deepEqual([host.status, host.stdout, host.stderr], [0, '', '']);
      assert.equal(readFileSync(join(app, 'io'), 'utf8'), '', 'host');
    }
  } finally { rmSync(app, { recursive: true, force: true }); }
});

test('every_thrown_starter_code_is_in_the_refusal_table and discovery needs no configuration', () => {
  const invoke = (...args: string[]) => spawnSync('./lifecycle', ['refusals', ...args], { cwd: root, encoding: 'utf8', env: { PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) } });
  const json = invoke('--json'), text = invoke();
  assert.equal(json.status, 0);
  assert.equal(text.status, 0);
  const table = oneLine(json.stdout);
  assert.match(table.starter_port_invalid.fix, /Direct host: .*--port.*Lifecycle commands: .*OPENLUP_STARTER_PORT.*unset it/u);
  const codes = Object.keys(table);
  assert.deepEqual(codes, [...codes].sort());
  const rows = text.stdout.trimEnd().split('\n').map(line => line.split('\t'));
  assert.deepEqual(rows, Object.entries(table).map(([code, entry]) => {
    const { cause, fix, recheck } = entry as { cause?: string; fix: string; recheck: string };
    assert.ok(fix && recheck, code);
    return [code, cause ?? '', fix, recheck];
  }));
  const source = ['lifecycle.mjs', 'installation/install.ts', 'installation/refusals.ts', 'shared/refusals.ts', 'installation/quote-seed.ts',
    'host/editor-catalogue.ts', 'owned/store.config.ts', 'shared/config.ts', 'shared/locales.ts',
    'shared/recovery-config.ts', 'shared/policy.ts', 'shared/quote-config.ts', 'shared/renewal-config.ts',
    'shared/subscription-edit.ts', 'shared/subscription-offer.ts', 'host/server.ts', 'host/native-composition.ts'];
  const mapped = /catalog_[a-z_]+: '(starter_[a-z_]+)'|definition_unknown_profile_ref: '(starter_[a-z_]+)'/gu;
  for (const path of source) {
    const body = readFileSync(join(root, path), 'utf8');
    const bytes = path === 'host/server.ts' ? body.slice(body.indexOf('const publicationPasswordFile ='))
      : path === 'host/native-composition.ts' ? body.slice(body.indexOf('export async function composeNativeBindings'), body.indexOf('const customer = resolved.binding'))
      : path === 'shared/renewal-config.ts' ? body.replace(/export function admitCareCommand[\s\S]+?(?=\nexport )/u, '') : body;
    const matches = [...bytes.matchAll(/(?:Error|refusal|buildRefusal|starterDiagnostic)\(['`"(](starter_[a-z_]+)|\bthrow (?:[a-zA-Z]+)\(['"](starter_[a-z_]+)/gu),
      ...bytes.matchAll(mapped),
      ...bytes.matchAll(/assertChoice\([^;]*, '(starter_[a-z_]+)'\);/gu)];
    for (const [, first, second] of matches) assert.ok(Object.hasOwn(table, (first ?? second)!), path + ' ' + (first ?? second));
  }
  const assertLocale = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { starterGuidance } from './lifecycle-refusals.mjs';
    for (const code of ['starter_locale_unsupported: ' + 'a'.repeat(32), 'starter_locale_copy_missing: ' + 'a'.repeat(120) + ' (pl)',
      'starter_predecessor_cancel_failed', 'saved_address_policy_invalid']) assert.ok(starterGuidance(code), code);
    for (const code of ['starter_locale_unsupported: ' + 'a'.repeat(33), 'starter_locale_copy_missing: ' + 'a'.repeat(121) + ' (pl)',
      'starter_locale_copy_missing: key (EN)', 'starter_locale_unsupported: de\\n', 'starter_predecessor_cancel_failed: detail',
      'starter_unknown_underscore_name', '__proto__']) assert.equal(starterGuidance(code), undefined, code);
  `], { cwd: root, encoding: 'utf8' });
  assert.equal(assertLocale.status, 0, assertLocale.stderr);
  const wrong = invoke('--json', '--configuration', 'coffee');
  assert.match(wrong.stderr, /^starter_argument_unknown\nFix: Use `\.\/lifecycle refusals`/u);
  assert.equal(wrong.status, 2);
});

const recipeApp = processEnv.OPENLUP_STARTER_CATALOGUE_RECIPE_APP;
const catalogueProofOwner = processEnv.OPENLUP_STARTER_CATALOGUE_TEST_OWNER_URL;

test('catalogue_apply_reports_and_bounds', async () => {
  const launch = (...args: string[]) => spawnSync(process.execPath, ['lifecycle.mjs', 'catalogue', 'apply', '--json', ...args],
    { cwd: root, encoding: 'utf8', input: 'approve\n' });
  for (const [args, code] of [[[], 'OPENLUP_E_CATALOGUE_PRODUCT_REQUIRED'], [['--approve'], 'starter_argument_unknown']] as const) {
    const result = launch(...args);
    assert.equal(result.status, 2);
    const report = oneLine(result.stdout);
    assert.deepEqual(Object.keys(report), ['formatVersion', 'command', 'state', 'exitCode', 'receipts', 'findings']);
    assert.deepEqual(report.receipts, []);
    assert.equal(report.findings[0].code, code);
    assert.equal(result.stderr, '');
  }
  // Exercise the real error surface and preserve an infrastructure cause out of JSON.
  const checked = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { catalogueApplyRefusal } from './lifecycle-refusals.mjs';
    const cause = new Error('private transport detail');
    const code = 'OPENLUP_E_CATALOGUE_APPLY_UNAVAILABLE';
    const refused = catalogueApplyRefusal({code, path: 'catalogue.demoTarget'}, cause);
    assert.equal(Object.getPrototypeOf(refused), Error.prototype);
    assert.equal(refused.message, code);
    assert.deepEqual(Reflect.ownKeys(refused).filter(key => key !== 'stack'), ['message','cause','finding']);
    assert.deepEqual(Object.getOwnPropertyDescriptor(refused, 'cause'),
      {value: cause, writable: true, configurable: true, enumerable: false});
    assert.doesNotMatch(JSON.stringify(refused), /private transport detail/);
  `], { cwd: root, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);

  const { composeOperatorCapabilities } = await import('../host/operator-composition.ts');
  const { demonstrationMarker, demonstrationMarkerQuery } = await import('../host/demonstration-marker.ts');
  const variantId = randomUUID(), priceListId = randomUUID(), revisionId = randomUUID(), actorId = randomUUID();
  const config = selectConfiguration();
  const policy = { revisionId, discountBps: 500, roundingQuantumMinor: 10, roundingRule: 'FLOOR_TO_QUANTUM' };
  const validTarget = { priceListId, currency: config.market.currency, basis: null, policies: [policy], valid: true };
  let target = validTarget, inGate = false, switchListOnPreview = false, successorStarts: string | undefined;
  const previewAt = '2026-11-25T10:00:00.000123Z';
  const pendingReadAt = '2026-11-25T10:00:02.000Z';
  const predecessor = { entryId: randomUUID(), unitPriceMinor: 11, validFrom: '2026-11-25T09:00:00.000Z' };
  const commands: unknown[][] = [];
  const previews: unknown[][] = [];
  const trace: string[] = [];
  const publication = {
    async run<T>(work: (db: { query: typeof query }) => Promise<T>) {
      trace.push('BEGIN');
      return work({ query });
    },
    async close() {},
  };
  async function query(sql: string, values?: unknown[]) {
    trace.push(sql.split('\n')[0]!);
    if (sql === demonstrationMarkerQuery) {
      assert.equal(values, undefined);
      return { rows: [{ marker: demonstrationMarker }] };
    }
    if (sql.startsWith('WITH list')) return { rows: [target] };
    return { rows: [] };
  }
  const operator = composeOperatorCapabilities({ executor: { query }, connectionString: 'postgresql://localhost/demo', publication,
    asOperator: async (principal, work) => {
      assert.equal(principal, actorId);
      trace.push('asActor');
      return work({ async query(sql, values) {
        if (sql === 'SELECT statement_timestamp()::text AS instant') {
          assert.deepEqual(trace.slice(-1), ['asActor']);
          trace.push('reference instant');
          return { rows: [{ instant: previewAt }] };
        }
        if (sql.includes('catalog_price_setup_preview')) {
          trace.push('preview');
          previews.push(values!);
          if (switchListOnPreview) target = { ...target, priceListId: randomUUID() };
          const readiness = { ready: true, reasons: [] };
          return { rows: [{ result: { outcome: 'preview', variantId, priceListId, inGate,
            current: successorStarts ? predecessor : null, currentCount: Number(!!successorStarts),
            subscription: { kind: 'derived', revisionId, discountBps: 500, roundingQuantumMinor: 10, derivedUnitPriceMinor: null },
            readiness, ...(values?.[2] !== null && { proposed: { unitPriceMinor: values?.[2], readiness } }) } }] };
        }
        if (sql === 'RESET ROLE') { trace.push('runtime read'); return { rows: [] }; }
        if (sql.includes('AS "hasPending"')) {
          assert.deepEqual(values, [variantId, priceListId, previewAt]);
          assert.deepEqual(trace.slice(-4), ['asActor', 'reference instant', 'preview', 'runtime read']);
          assert.match(sql, /valid_from > \$3::timestamptz/u);
          const hasPending = successorStarts !== undefined && Date.parse(successorStarts) > Date.parse(String(values?.[2]));
          return { rows: [{ listEffective: target.priceListId === priceListId, hasPending }] };
        }
        trace.push('apply');
        commands.push(values!);
        return { rows: [{ result: { outcome: 'validation_issue', reason: 'expected_state_mismatch' } }] };
      } });
    } });
  const context = { commandKey: randomUUID(), config,
    actor: { customerRef: null, operatorRef: actorId, sessionToken: 'verified fixture' } };
  try {
    assert.deepEqual(await operator.actions['catalogue.demoTarget']!({}, context),
      { ok: true, value: { marked: true, configurationId: config.id } });
    assert.deepEqual(trace, ['BEGIN', 'SET TRANSACTION READ ONLY', "SET LOCAL statement_timeout = '1s'", demonstrationMarkerQuery.split('\n')[0]]);
    const price = operator.actions['operator.catalogPublication']!;
    const input = { action: 'price-apply', variantId, priceListId, policyRevisionId: revisionId };
    const apply = { ...input, unitPriceMinor: 11 };
    const entryId = 'db7ccc53-9ab0-4111-89c8-57c9fd8c8543';
    const nullPair = { entryId: null, unitPriceMinor: null };
    const original = JSON.stringify({ amountKind: 'gross', commandKey: context.commandKey, expected: nullPair,
      minQty: 1, mode: 'one_time', priceListId, schemaVersion: 1, unitPriceMinor: 11, variantId });
    for (const [amount, code] of [[0, 'starter_input_invalid'], [10, 'starter_catalogue_derived_price_zero'],
      [2_147_483_648, 'starter_input_invalid'], [2_147_483_647, 'expected_state_mismatch']] as const) {
      trace.length = 0;
      assert.deepEqual(await price({ ...input, unitPriceMinor: amount }, context), { ok: false, code });
      assert.equal(trace.includes('apply'), amount === 2_147_483_647);
      if (trace.includes('apply')) assert.deepEqual(trace.slice(-3), ['asActor', 'preview', 'apply']);
    }
    for (const body of [apply, { ...apply, expected: nullPair }]) {
      assert.deepEqual(await price(body, context), { ok: false, code: 'expected_state_mismatch' });
      assert.deepEqual(commands.at(-1), [original, createHash('sha256').update(original).digest('hex')]);
      assert.deepEqual(trace.slice(-3), ['asActor', 'preview', 'apply']);
    }
    const expected = { entryId, unitPriceMinor: 22 };
    trace.length = 0;
    assert.deepEqual(await price({ ...apply, expected }, context), { ok: false, code: 'starter_catalogue_reprice_requires_active' });
    assert.deepEqual(trace.slice(-2), ['asActor', 'preview']);
    assert.equal(trace.includes('apply'), false);
    inGate = true;
    for (const unitPriceMinor of [0, 22, 2_147_483_647]) {
      const expectation = { entryId, unitPriceMinor };
      assert.deepEqual(await price({ ...apply, expected: expectation }, context), { ok: false, code: 'expected_state_mismatch' });
      assert.deepEqual(trace.slice(-3), ['asActor', 'preview', 'apply']);
      assert.deepEqual(JSON.parse(String(commands.at(-1)?.[0])).expected, expectation);
    }
    for (const invalid of [null, {}, { ...expected, extra: 0 }, { entryId }, { unitPriceMinor: 22 },
      { ...expected, entryId: entryId.toUpperCase() }, { ...expected, entryId: 'malformed' },
      ...[null, -1, 1.5, '22', 2_147_483_648].map(unitPriceMinor => ({ entryId, unitPriceMinor }))]) {
      trace.length = 0;
      assert.deepEqual(await price({ ...apply, expected: invalid }, context), { ok: false, code: 'starter_input_invalid' });
      assert.deepEqual(trace, []);
    }
    trace.length = 0;
    assert.deepEqual(await price({ ...apply, expected, unitPriceMinor: 10 }, context),
      { ok: false, code: 'starter_catalogue_derived_price_zero' });
    assert.deepEqual(trace.slice(-2), ['asActor', 'preview']);
    const previewInput = { action: 'price-preview', variantId, priceListId };
    assert.equal((await price({ ...previewInput, unitPriceMinor: 22 }, context)).ok, true);
    assert.deepEqual(previews.at(-1), [variantId, priceListId, 22]);
    assert.deepEqual(await price({ ...previewInput, unitPriceMinor: 0 }, context), { ok: false, code: 'starter_input_invalid' });
    trace.length = 0;
    assert.deepEqual(await price({ ...input, unitPriceMinor: 11, policyRevisionId: randomUUID() }, context),
      { ok: false, code: 'starter_catalogue_d2c_policy_required' });
    assert.deepEqual(trace.slice(-2), ['asActor', 'preview']);
    for (const [change, code] of [
      [{ currency: config.market.currency === 'XTS' ? 'XXX' : 'XTS' }, 'starter_catalogue_currency_mismatch'],
      [{ currency: config.market.currency, valid: false }, 'starter_catalogue_d2c_policy_required'],
    ] as const) {
      target = { ...validTarget, ...change };
      assert.deepEqual(await price({ action: 'price-target' }, context), { ok: false, code });
    }
    for (const change of [{ policies: [] }, { valid: false }]) {
      trace.length = 0;
      target = { ...validTarget, ...change };
      assert.deepEqual(await price(previewInput, context), { ok: false, code: 'starter_catalogue_d2c_policy_required' });
      assert.equal(trace.includes('asActor'), false);
    }
    target = validTarget;
    successorStarts = '2026-11-25T10:00:01.000Z';
    assert.ok(Date.parse(previewAt) < Date.parse(successorStarts) && Date.parse(successorStarts) <= Date.parse(pendingReadAt));
    const crossing = await price(previewInput, context);
    assert.ok(crossing.ok && 'value' in crossing);
    const { priceSetup } = crossing.value as { priceSetup: { current: unknown; hasPending: boolean } };
    assert.deepEqual(priceSetup.current, predecessor);
    assert.equal(priceSetup.hasPending, true);
    successorStarts = undefined;
    switchListOnPreview = true;
    const oldList = await price(previewInput, context);
    assert.ok(oldList.ok && 'value' in oldList);
    assert.deepEqual(previews.at(-1), [variantId, priceListId, null]);
    assert.equal((oldList.value as { listEffective: boolean }).listEffective, false);
  } finally { await operator.close(); }
});

test('installed_catalogue_operator_workflow', { skip: !recipeApp, timeout: 600_000 }, async context => {
  const app = recipeApp!;
  const existing = processEnv.OPENLUP_STARTER_CATALOGUE_OPERATOR_PROJECT;
  const project = existing ?? 'catalogue-operator-' + randomUUID().slice(0, 12);
  assert.match(project, /^[a-z0-9-]+$/u);
  const manifest = JSON.parse(readFileSync(join(app, '.starter-origin.json'), 'utf8'));
  assert.ok(['candidate', 'local-candidate', 'released', 'reconstructed'].includes(manifest.mode ?? manifest.kind));
  const run = (file: string, args: string[], input?: string) => execFileSync(file, args,
    { cwd: app, env: { ...processEnv, COMPOSE_PROJECT_NAME: project }, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  const compose = (...args: string[]) => run('docker', ['compose', '--project-name', project, ...args]);
  const sql = (statement: string) => compose('exec', '-T', 'database', 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
    '-U', 'starter_install', '-d', 'neutral_store', '-c', statement).trim();
  const port = Number(processEnv.OPENLUP_STARTER_PORT || 4319);
  const fixtureOrigin = processEnv.OPENLUP_STARTER_CATALOGUE_OPERATOR_ORIGIN;
  const base = fixtureOrigin ?? `http://127.0.0.1:${port}`;
  const headers = { Origin: base, 'X-Starter-Request': '1', 'Content-Type': 'application/json' };
  async function action(operation: string, body: unknown, key: string = randomUUID(), cookie?: string) {
    const response = await fetch(base + '/api/actions/' + operation, { method: 'POST',
      headers: { ...headers, 'Idempotency-Key': key, ...(cookie && { Cookie: cookie }) }, body: JSON.stringify(body) });
    return { data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const actor = randomUUID(), alternate = randomUUID(), email = `operator-${actor.slice(0, 8)}@example.test`;
  const alternateEmail = `alternate-${actor.slice(0, 8)}@example.test`;
  const snapshot = () => sql(`SELECT (SELECT count(*) FROM public.catalog_draft_revisions),
    (SELECT count(*) FROM public.catalog_publication_decisions), (SELECT count(*) FROM public.catalog_publications),
    (SELECT count(*) FROM public.catalog_publication_heads), (SELECT count(*) FROM public.price_entries),
    (SELECT count(*) FROM public.catalog_price_setup_receipts)`);
  function mailbox(address = email) {
    try {
      return compose('exec', '-T', '--user', 'node', 'application', 'cat', '/application/.context/captured-messages/identity.jsonl')
        .trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.email === address);
    } catch (error) {
      if (String((error as { stderr?: string }).stderr).includes('No such file or directory')) return [];
      throw error;
    }
  }
  let cookie: string | undefined;
  const operator = 'operator.catalogPublication', drafts = 'operator.catalogDrafts';
  async function send(operation: string, body: unknown, key?: string) {
    return (await action(operation, body, key, cookie)).data;
  }
  async function askChallenge() {
    assert.deepEqual((await action('auth.operator', { email })).data, { ok: true, value: { accepted: true } });
  }
  async function newestToken(count: number, address = email) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const rows = mailbox(address);
      if (rows.length === count) return rows.at(-1).token as string;
      await delay(50);
    }
    throw new Error('Expected operator challenge delivery');
  }
  try {
    if (!existing) assert.equal(oneLine(run('./lifecycle', ['up', '--configuration', 'coffee', '--json'])).exitCode, 0);
    if (!fixtureOrigin) {
      assert.equal(compose('port', 'application', String(port)).trim(), `127.0.0.1:${port}`);
      assert.equal((await fetch(`${base}/api/config`)).status, 200);
      if (port !== 4319) {
        const refused = spawnSync('curl', ['--silent', '--header', 'Host: 127.0.0.1:4319', `${base}/api/config`], { encoding: 'utf8' });
        assert.equal(refused.status, 0);
        assert.deepEqual(JSON.parse(refused.stdout), { ok: false, code: 'starter_local_host_required' });
      }
      context.diagnostic(`Compose project ${project} healthy on loopback port ${port}`);
    }
    assert.deepEqual((await action('catalogue.demoTarget', {})).data, { ok: true, value: { marked: true, configurationId: 'coffee' } });
    const registry = (await action('application.status', {})).data.value.bindings as { operation: string; bound: boolean }[];
    assert.deepEqual(registry.map(({ operation }) => operation), (await import('../shared/api.ts')).operations);
    assert.equal(registry.find(({ operation }) => operation === 'catalogue.demoTarget')?.bound, true);
    const readOnly = JSON.parse(compose('exec', '-T', '--user', 'node', 'application', 'node', '--input-type=module', '-e', `
      import { readFileSync } from 'node:fs';
      import { runtimeConnectionString, runtimeUrl } from './host/runtime-database.ts';
      import { createPostgresRoleFreeTransactionLane } from '@openlup/platform/data';
      import { composeOperatorCapabilities } from './host/operator-composition.ts';
      import { demonstrationMarkerQuery } from './host/demonstration-marker.ts';
      const url = new URL(runtimeUrl);
      url.username = 'openlup_catalog_publication';
      url.password = readFileSync('.context/catalogue-builds/.publication-password', 'utf8').trim();
      const lane = createPostgresRoleFreeTransactionLane({connectionString: url.href});
      let markerSettings;
      const publication = { run: work => lane.run(db => work({ async query(statement, values) {
        if (statement === demonstrationMarkerQuery) {
          markerSettings = (await db.query("SELECT current_setting('transaction_read_only') AS mode,current_setting('statement_timeout') AS deadline")).rows[0];
          if (values !== undefined) throw Error('Marker query must be parameterless');
        }
        return db.query(statement, values);
      } })), close: () => lane.close() };
      const composed = composeOperatorCapabilities({executor: {}, publication, connectionString: runtimeConnectionString()});
      try {
        const { ok } = await composed.actions['catalogue.demoTarget']({}, {config: {id:'coffee'}});
        console.log(JSON.stringify({ ok, ...markerSettings }));
      } finally { await Promise.all([composed.close(), lane.close()]); }
    `));
    assert.deepEqual(readOnly, { ok: true, mode: 'on', deadline: '1s' });
    const anonymous = await send(operator, { action: 'price-target' });
    assert.equal(anonymous.code, 'operator_required');
    sql(`INSERT INTO public.platform_human_principals(principal_id,email) VALUES
      ('${actor}','${email}'),('${alternate}','${alternateEmail}');
      INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at)
      VALUES ('${actor}','admin','active','legacy',now()),('${alternate}','admin','active','legacy',now())`);
    const challenges = () => Number(sql(`SELECT count(*) FROM public.operator_identity_challenges WHERE principal_id='${actor}'`));
    await askChallenge();
    const expired = await newestToken(1);
    await askChallenge();
    assert.equal(challenges(), 1);
    assert.equal(mailbox().length, 1);
    sql(`UPDATE public.operator_identity_challenges SET created_at=statement_timestamp()-interval '10 minutes',
      expires_at=statement_timestamp() WHERE principal_id='${actor}'`);
    const invalid = await action('auth.operator', { token: expired });
    assert.equal(invalid.data.code, 'starter_auth_invalid');
    assert.equal(invalid.cookie, undefined);
    assert.equal(sql(`SELECT count(*) FROM public.operator_identity_challenges WHERE principal_id='${actor}' AND used_at IS NOT NULL`), '0');
    sql(`INSERT INTO public.operator_identity_challenges(principal_id,email_fingerprint,token_hash,created_at,expires_at)
      SELECT principal_id,email_fingerprint,md5((principal_id||'fixture-hour-'||n)::text)||md5((principal_id||'fixture-hour-more-'||n)::text),
        statement_timestamp()-interval '20 minutes',statement_timestamp()-interval '10 minutes'
      FROM public.operator_identity_challenges CROSS JOIN generate_series(1,4) n WHERE principal_id='${actor}' AND used_at IS NULL`);
    await askChallenge();
    assert.equal(challenges(), 5);
    assert.equal(mailbox().length, 1);
    sql(`UPDATE public.operator_identity_challenges SET created_at=statement_timestamp()-interval '2 hours',
      expires_at=statement_timestamp()-interval '110 minutes' WHERE principal_id='${actor}'`);
    await askChallenge();
    const login = await action('auth.operator', { token: await newestToken(2) });
    assert.ok(login.cookie && login.data.ok && Number.isFinite(Date.parse(login.data.value.expiresAt)));
    cookie = login.cookie;
    const target = (await send(operator, { action: 'price-target' })).value;
    assert.equal(target.actorId, actor);
    assert.equal(target.currency, 'XTS');
    const { priceListId, policy } = target;
    const { buildCatalogReleaseDraftV3, catalogInternalGtin } = await import('@openlup/platform/catalog');
    const { canonicalCatalogPriceSetupCommand } = await import('@openlup/platform/pricing');
    const sequence = 100_000 + parseInt(actor.slice(0, 6), 16) % 800_000;
    const slug = 'proof-notebook-' + actor.slice(0, 8);
    const type = (await send(drafts, { action: 'example' })).value.product.type;
    const mass = { dimension: 'mass', unit: 'openlup:g', unscaled: '100', scale: 0 } as const;
    const { release, activation } = buildCatalogReleaseDraftV3({ namespace: 'starter', type, slug, name: 'Proof notebook',
      presentation: { title: 'Proof notebook' }, skus: [{ code: slug.toUpperCase(), title: 'Notebook', options: {}, netContent: mass,
        grossMass: { ...mass, unscaled: '120' }, identifiers: [{ scheme: 'gs1:gtin', issuer: 'starter:proof',
          value: catalogInternalGtin(sequence), packagingLevel: 'unit' }], sell: { oneTime: true, subscription: false },
        logisticsRef: 'starter:proof/' + slug }] });
    const draftId = randomUUID(), productId = release.payload.product.id, variantId = release.payload.skus[0]!.id;
    const prepare = async (expectedRevision: number, expectedHead: unknown) => {
      const { value } = await send(drafts, { action: 'prepare', draftId, expectedRevision, expectedHead });
      assert.ok(value?.preparation?.postStateDigest);
      assert.deepEqual(value.expectedHead, expectedHead);
      const candidate = { productId, candidateRef: value.candidateRef, candidateDigest: value.candidateDigest };
      return { approve: { action: 'approve', ...candidate, postStateDigest: value.preparation.postStateDigest },
        publish: { action: 'publish', ...candidate, expectedHead, changes: [] } };
    };
    const save = (payload: typeof release.payload, expectedRevision: number) => ({ action: expectedRevision ? 'revise' : 'create',
      draftId, expectedRevision, payload });
    const replay = (result: Record<string, unknown>, initial: Record<string, unknown>) => {
      assert.equal(result.outcome, 'replayed');
      assert.deepEqual(result.receipt ?? result.record, initial.receipt ?? initial.record);
    };
    const coffee = selectConfiguration('coffee');
    const cart = { schemaVersion: 1, configuration: 'coffee', mode: 'one_time',
      cadenceDays: null, lines: [{ sku: coffee.offer.products[0]!.sku, quantity: 1 }] };
    const quote = () => send('offer.validate', { cart });
    const legacy = await quote();
    assert.equal(legacy.value.totalMinor, 4200);
    const saveKey = randomUUID(), approvalKey = randomUUID(), releaseKey = randomUUID();
    const saved = (await send(drafts, save(release.payload, 0), saveKey)).value;
    assert.equal(saved.record.revision, 1);
    assert.equal((await send(drafts, { action: 'prepare', draftId, expectedRevision: 1 })).value.expectedHead, null);
    const first = await prepare(1, null);
    const approval = (await send(operator, first.approve, approvalKey)).value;
    const released = (await send(operator, first.publish, releaseKey)).value;
    const { head } = released.receipt;
    const prices = { variantId, priceListId };
    const planned = { action: 'price-apply', ...prices, policyRevisionId: policy.revisionId, unitPriceMinor: 11 };
    const control = await action(operator, planned);
    assert.equal(control.data.code, 'operator_required');
    const customer = `customer-${actor.slice(0, 8)}@example.test`;
    compose('exec', '-T', '--user', 'node', 'application', 'node', '--input-type=module', '-e', `
      import { randomUUID } from 'node:crypto';
      import { runtimeConnectionString } from './host/runtime-database.ts';
      import { createPostgresAccountLinkStore } from '@openlup/platform/identity';
      const accounts = createPostgresAccountLinkStore({ connectionString: runtimeConnectionString() });
      try { await accounts.createAccount({ principalId: randomUUID(), email: ${JSON.stringify(customer)},
        acquisitionSource: 'direct', lifecycleStage: 'customer' }); }
      finally { await accounts.close(); }
    `);
    assert.equal((await action('auth.request', { email: customer })).data.ok, true);
    const signedCustomer = await action('auth.verify', { token: await newestToken(1, customer) });
    assert.ok(signedCustomer.cookie);
    assert.equal((await action(operator, planned, undefined, signedCustomer.cookie)).data.code, 'operator_required');
    const { value: preview } = await send(operator, { action: 'price-preview', ...prices });
    assert.equal(preview.listEffective, true);
    assert.equal(preview.priceSetup.inGate, false);
    assert.equal(preview.priceSetup.current, null);
    assert.equal(preview.priceSetup.subscription.revisionId, policy.revisionId);
    const initial = snapshot();
    assert.equal((await send(operator, { ...planned, priceListId: randomUUID() })).code, 'price_list_not_active');
    assert.equal((await send(operator, { ...planned, unitPriceMinor: 10 })).code, 'starter_catalogue_derived_price_zero');
    assert.equal((await send(operator, { ...planned, policyRevisionId: randomUUID() })).code, 'starter_catalogue_d2c_policy_required');
    assert.equal(snapshot(), initial);
    const activationSave = await send(drafts, save(activation.payload, 1));
    assert.equal(activationSave.value.record.revision, 2);
    for (const badHead of [null, { ...head, documentDigest: 'f'.repeat(64) }]) {
      const stale = await send(drafts, { action: 'prepare', draftId, expectedRevision: 2, expectedHead: badHead });
      assert(!stale.ok || !stale.value?.preparation?.postStateDigest);
    }
    const next = await prepare(2, head), activationKey = randomUUID();
    assert.equal((await send(operator, next.approve)).value.outcome, 'committed');
    const before = snapshot();
    assert.equal((await send(operator, next.publish, activationKey)).code, 'publication_sku_price_not_ready');
    assert.equal(snapshot(), before);
    assert.equal((await send(operator, { action: 'receipt', productId, commandKey: activationKey })).value.outcome, 'absent');
    assert.equal(sql(`SELECT status FROM public.catalog_skus WHERE id='${variantId}'`), 'draft');
    const priceKey = randomUUID();
    const priced = (await send(operator, planned, priceKey)).value;
    assert.equal(priced.receipt.current.unitPriceMinor, 11);
    const { entryId, unitPriceMinor } = priced.receipt.current;
    const expectation = { entryId, unitPriceMinor };
    const replacement = { ...planned, unitPriceMinor: 22, expected: expectation };
    const beforeActivation = snapshot();
    assert.equal((await send(operator, replacement)).code, 'starter_catalogue_reprice_requires_active');
    assert.equal(snapshot(), beforeActivation);
    const activated = (await send(operator, next.publish, activationKey)).value;
    assert.deepEqual(activated.receipt.previousHead, head);
    const completed = snapshot();
    replay((await send(drafts, save(release.payload, 0), saveKey)).value, saved);
    replay((await send(operator, first.approve, approvalKey)).value, approval);
    replay((await send(operator, first.publish, releaseKey)).value, released);
    replay((await send(operator, next.publish, activationKey)).value, activated);
    replay((await send(operator, planned, priceKey)).value, priced);
    assert.equal(snapshot(), completed);
    await context.test('installed_catalogue_copy_preserves_history', async () => {
      const { record } = (await send(drafts, { action: 'get', draftId, revision: 2 })).value;
      const activeHead = activated.receipt.head;
      const exact = (expectedHead: unknown) => send(operator, { action: 'exact', head: expectedHead }).then(result => result.value);
      const original = await exact(activeHead);
      const payload = record.payload;
      const presentation = { title: 'Proof notebook revised' };
      Object.assign(payload.product.sharedContent, { catalogAction: 'revise', presentation });
      payload.publication.operations = [{ op: 'set_product_presentation', productSlug: slug, presentation }];
      assert.equal((await send(drafts, save(payload, 2))).value.record.revision, 3);
      const copy = await prepare(3, activeHead);
      assert.equal((await send(operator, copy.approve)).ok, true);
      const copied = (await send(operator, copy.publish)).value.receipt;
      assert.deepEqual(copied.previousHead, activeHead);
      const amended = await exact(copied.head);
      assert.equal(amended.product.id, original.product.id);
      assert.deepEqual(amended.product.document, original.product.document);
      assert.deepEqual(amended.product.presentation.title, presentation.title);
      assert.deepEqual(amended.items, original.items);
      assert.deepEqual(await exact(activeHead), original);
      assert.deepEqual(await quote(), legacy);
      assert.deepEqual((await send(operator, { action: 'price-preview', ...prices })).value.priceSetup.current, priced.receipt.current);
    });
    await context.test('installed_catalogue_reprice', async () => {
      assert.equal(sql(`SELECT status FROM public.catalog_skus WHERE id='${variantId}'`), 'active');
      const checkout = await action('checkout.create', { cart, locale: coffee.market.defaultLocale, configuration: 'coffee',
        email: customer, country: coffee.market.country, firstName: 'Example', lastName: 'Buyer', phone: '000000000',
        line1: '1 Example Lane', city: 'Example City', postalCode: '00000', termsAccepted: true, termsRevision: coffee.legal.revision,
        quoteAcceptance: legacy.value.quoteAcceptance, expectedTotal: legacy.value.expectedTotal }, undefined, signedCustomer.cookie);
      assert.equal(checkout.data.ok, true, checkout.data.code);
      const { orderRef } = checkout.data.value;
      const paid = await action('payment.simulate', { orderRef, outcome: 'captured' }, undefined, signedCustomer.cookie);
      assert.equal(paid.data.ok, true, paid.data.code);
      sql(`UPDATE public.commerce_orders SET created_at=statement_timestamp()-interval '25 hours' WHERE id='${orderRef}'`);
      const orderSnapshot = () => JSON.parse(sql(`SELECT jsonb_build_object('total',total_amount_minor,'currency',currency_code,
        'status',status,'quote',metadata->'quoteSnapshot') FROM public.commerce_orders WHERE id='${orderRef}'`));
      const order = orderSnapshot();
      assert.equal(order.status, 'paid');
      assert.equal(order.total, legacy.value.totalMinor);
      assert.equal(order.currency, target.currency);
      assert.ok(order.quote);
      assert.deepEqual(await quote(), legacy);

      assert.equal((await action('auth.operator', { email: alternateEmail })).data.ok, true);
      const signed = await action('auth.operator', { token: await newestToken(1, alternateEmail) });
      assert.ok(signed.data.ok && signed.cookie);
      const read = async (body: unknown, key?: string) => (await action(operator, body, key, signed.cookie)).data;
      for (const [commandKey, previous] of [[releaseKey, released.receipt], [activationKey, activated.receipt]]) {
        const historical = await read({ action: 'receipt', productId, commandKey });
        assert.deepEqual(historical.value, { outcome: 'found', receipt: previous });
      }
      const pre = await read({ action: 'price-preview', ...prices });
      assert.equal(pre.value.priceSetup.inGate, true);
      const beforePrice = snapshot();
      const key = randomUUID();
      const result = await read(replacement, key);
      assert.equal(result.ok, true, result.code);
      assert.equal(result.value.outcome, 'committed');
      const { receipt } = result.value;
      assert.equal(receipt.actorId, alternate);
      assert.equal(receipt.commandKey, key);
      assert.deepEqual(receipt.previous, priced.receipt.current);
      assert.equal(receipt.current.unitPriceMinor, 22);
      const { value: readback } = await read({ action: 'price-preview', ...prices });
      assert.equal(readback.listEffective, true);
      assert.equal(readback.priceSetup.currentCount, 1);
      assert.deepEqual(readback.priceSetup.current, receipt.current);
      assert.equal(readback.priceSetup.subscription.derivedUnitPriceMinor, 20);
      assert.equal(readback.priceSetup.subscription.revisionId, policy.revisionId);
      assert.deepEqual(readback.priceSetup.readiness, pre.value.priceSetup.readiness);
      assert.equal(sql(`SELECT old.unit_price_minor,old.active,old.valid_to=new.valid_from FROM public.price_entries old
        CROSS JOIN public.price_entries new WHERE old.id='${entryId}' AND new.id='${receipt.current.entryId}'`), '11|f|t');
      const afterPrice = snapshot();
      const counts = beforePrice.split('|').map(Number);
      assert.deepEqual(afterPrice.split('|').map(Number), counts.map((count, index) => count + Number(index >= 4)));
      assert.deepEqual(orderSnapshot(), order);
      assert.deepEqual(await quote(), legacy);

      for (const amount of [22, 33]) {
        assert.equal((await send(operator, { ...replacement, unitPriceMinor: amount })).code, 'expected_state_mismatch');
        assert.equal(snapshot(), afterPrice);
      }
      assert.equal((await read({ ...replacement, unitPriceMinor: 10 })).code, 'starter_catalogue_derived_price_zero');
      assert.equal((await send(operator, replacement, key)).code, 'operator_mismatch');
      replay((await read(replacement, key)).value, result.value);
      assert.equal(snapshot(), afterPrice);
      const rolledRevisionId = randomUUID();
      sql(`BEGIN;
        UPDATE public.subscription_price_policy_revisions SET effective_to=date_trunc('milliseconds',statement_timestamp())
        WHERE id='${policy.revisionId}';
        INSERT INTO public.subscription_price_policy_revisions (id, price_list_id, region_code, currency, channel, revision_no,
          effective_from, discount_bps, rounding_quantum_minor, rounding_rule, digest)
        SELECT '${rolledRevisionId}', price_list_id, region_code, currency, channel, revision_no+1,
          effective_to, discount_bps, rounding_quantum_minor, rounding_rule,
          public.catalog_price_setup_policy_digest('${rolledRevisionId}',revision_no+1,price_list_id,region_code,currency,channel,
            effective_to,NULL,discount_bps,rounding_quantum_minor,rounding_rule)
        FROM public.subscription_price_policy_revisions WHERE id='${policy.revisionId}'; COMMIT`);
      assert.equal((await read({ action: 'price-target' })).value.policy.revisionId, rolledRevisionId);
      const blocked = await read(replacement, key);
      assert.equal(blocked.code, 'starter_catalogue_d2c_policy_required');
      assert.equal(snapshot(), afterPrice);
      const verified = (await read({ action: 'price-preview', ...prices })).value;
      assert.equal(verified.listEffective, true);
      assert.deepEqual(verified.priceSetup.current, receipt.current);
      assert.equal(verified.priceSetup.subscription.derivedUnitPriceMinor, 20);
      assert.equal(verified.priceSetup.subscription.revisionId, rolledRevisionId);
      assert.equal(snapshot(), afterPrice);
    });
    const authorized = snapshot();
    async function denied() {
      for (const body of [next.approve, next.publish, { action: 'price-preview', ...prices }, planned, replacement])
        assert.equal((await send(operator, body)).code, 'operator_required');
      assert.equal(snapshot(), authorized);
    }
    sql(`INSERT INTO public.platform_control_operators(principal_id) VALUES ('${actor}')`);
    await denied();
    function directDenied() {
      for (const expected of [{ entryId: null, unitPriceMinor: null }, expectation]) {
        const sqlCommand = canonicalCatalogPriceSetupCommand({ schemaVersion: 1, commandKey: randomUUID(), ...prices,
          unitPriceMinor: expected.entryId === null ? 11 : 22,
          mode: 'one_time', minQty: 1, amountKind: 'gross', expected });
        const fingerprint = createHash('sha256').update(sqlCommand).digest('hex');
        assert.throws(() => sql(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='{"sub":"${actor}","role":"authenticated"}';
          SELECT public.catalog_price_setup_apply('${sqlCommand}','${fingerprint}')`),
        (error: unknown) => /42501:.*catalog_price_setup_operator_required/u.test(String((error as { stderr?: string }).stderr)));
      }
    }
    directDenied();
    sql(`DELETE FROM public.platform_control_operators WHERE principal_id='${actor}';
      SELECT principal_id FROM public.platform_revoke_human_membership('${alternate}','${actor}')`);
    await denied();
    directDenied();
  } finally {
    if (!existing) compose('down', '--volumes');
  }
});

test('catalogue job remedies admit owned IDs and omit ambiguous renewal populations', async () => {
  const { catalogueFailedJobFilter } = await import('../host/catalogue-readiness-jobs.ts');
  const example = 'store-' + 'x'.repeat(74), tooLong = example + 'x', duplicate = 'other-store';
  const template = selectConfiguration();
  const render = (id: string, population: string) => ({ ...template, id, renewal: { ...template.renewal, population } });
  const population = 'x'.repeat(100);
  try {
    configurations[example] = render(example, population);
    configurations[tooLong] = render(tooLong, 'too-long');
    configurations.mismatch = render('different', 'different');
    const names = [`subscription-renewal:${population}`, `starter-checkout:${example}`, `starter-checkout:${tooLong}`,
      'subscription-care:mismatch', null, `subscription-renewal:${population}`, 'platform-watchdog'];
    assert.deepEqual(catalogueFailedJobFilter()(names), ['platform-watchdog', `starter-checkout:${example}`, `subscription-renewal:${population}`]);
    configurations[duplicate] = render(duplicate, population);
    assert.deepEqual(catalogueFailedJobFilter()(names), ['platform-watchdog', `starter-checkout:${example}`]);
    configurations[duplicate] = render(duplicate, population + 'x');
    assert.deepEqual(catalogueFailedJobFilter()([...names, `subscription-renewal:${population}x`]),
      ['platform-watchdog', `starter-checkout:${example}`, `subscription-renewal:${population}`]);
  } finally {
    for (const id of [example, tooLong, duplicate, 'mismatch']) delete configurations[id];
  }
});

test('readiness job close discards late acquisitions at the five-second bound', async context => {
  const { startCatalogueReadinessJobs } = await import('../host/catalogue-readiness-jobs.ts');
  const { default: pg } = await import('pg');
  type PoolClient = import('pg').PoolClient;
  let resolve!: (client: PoolClient) => void;
  const promise = new Promise<PoolClient>(done => { resolve = done; });
  const connect = context.mock.method(pg.Pool.prototype, 'connect', () => promise);
  const late = { release: context.mock.fn(), query: context.mock.fn() };
  context.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'setInterval'] });
  const close = startCatalogueReadinessJobs('postgresql://starter_runtime@localhost/neutral_store', randomUUID());
  context.mock.timers.tick(1);
  assert.equal(connect.mock.callCount(), 1);
  context.mock.timers.tick(300_000);
  assert.equal(connect.mock.callCount(), 1, 'overlapping scheduled tick must not acquire another client');
  let closed = false;
  const closing = close().then(() => { closed = true; });
  context.mock.timers.tick(4999);
  await Promise.resolve();
  assert.equal(closed, false);
  context.mock.timers.tick(1);
  await closing;
  resolve(late as unknown as PoolClient);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(late.release.mock.calls.map(call => call.arguments), [[true]]);
  assert.equal(late.query.mock.callCount(), 0);
});

test('installed catalogue jobs isolate requests, fence heartbeat failures and drain on SIGTERM',
  { skip: !recipeApp || !catalogueProofOwner, timeout: 45_000 }, async () => {
    const app = recipeApp!;
    const { default: pg } = await import('pg');
    const { applyDemoSeed } = await import('../installation/install.ts');
    const { catalogueWatchdogPrincipalId } = await import('../host/catalogue-readiness-jobs.ts');
    const { readStarterCatalogueRules } = await import('../host/editor-catalogue.ts');
    const config = selectConfiguration('coffee'), principal = catalogueWatchdogPrincipalId(config);
    const owner = new pg.Pool({ connectionString: catalogueProofOwner });
    const url = new URL(catalogueProofOwner!);
    const password = decodeURIComponent(url.password);
    url.protocol = 'postgresql:';
    url.username = 'starter_runtime';
    url.search = '';
    const runtime = new pg.Pool({ connectionString: url.href });
    url.password = '';
    const hosts: (() => Promise<void>)[] = [];
    const durations: Record<string, number> = {};
    async function until<T>(read: () => T | Promise<T>) {
      const start = performance.now();
      while (performance.now() - start < 8000) {
        const value = await read();
        if (value) return value;
        await delay(25);
      }
      throw new Error('catalogue readiness proof timed out');
    }
    async function host(db = true) {
      const probe = createServer().listen(0, '127.0.0.1');
      await once(probe, 'listening');
      const address = probe.address();
      assert.ok(address && typeof address !== 'string');
      const { port } = address;
      await new Promise<void>(done => probe.close(() => done()));
      const base = `http://127.0.0.1:${port}`;
      const started = performance.now();
      const child = spawn(process.execPath, ['host/server.ts', '--configuration', config.id, '--port', String(port),
        ...(db ? ['--database-url', url.href] : [])],
      { cwd: app, env: { ...processEnv, PGPASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
      let diagnostics = '';
      child.stderr?.on('data', bytes => { diagnostics += String(bytes); });
      const exited = once(child, 'exit');
      const close = async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      };
      hosts.push(close);
      await until(async () => {
        assert.equal(child.exitCode, null, diagnostics);
        try { return (await fetch(base + '/api/config')).ok; } catch { return false; }
      });
      durations[db ? 'listenMs' : 'previewListenMs'] = Math.round(performance.now() - started);
      return { child, exited, diagnostics: () => diagnostics, async request() {
        const sent = performance.now();
        const response = await fetch(base + '/api/actions/offer.validate', { method: 'POST',
          headers: { Origin: base, 'Content-Type': 'application/json', 'X-Starter-Request': '1', 'Idempotency-Key': randomUUID() },
          body: JSON.stringify({ cart: { schemaVersion: 1, configuration: config.id, mode: 'one_time', cadenceDays: null,
            lines: [{ sku: config.offer.products[0]!.sku, quantity: 1 }] } }) });
        durations.requestMs = Math.round(performance.now() - sent);
        const body = await response.json();
        assert.equal(body.ok, true, body.code);
        assert.equal(body.value.totalMinor, 4200);
      }, async stop() {
        const began = performance.now();
        child.kill('SIGTERM');
        const exit = await Promise.race([exited, delay(5100, [], { ref: false })]);
        assert.deepEqual(exit, [0, null]);
        return Math.round(performance.now() - began);
      } };
    }
    const watchdog = () => owner.query(`SELECT c.last_status AS status,c.active_driver AS driver,c.metadata->'promotionReady' AS ready,
      r.driver AS run_driver,r.metadata->>'invocationSource' AS source,r.error
      FROM public.platform_job_controls c LEFT JOIN public.platform_job_runs r ON r.id=c.last_run_id
      WHERE c.job_name='platform-watchdog'`).then(({ rows }) => rows[0]);
    try {
      const db = await owner.connect();
      const catalogueRules = readStarterCatalogueRules();
      assert.ok(catalogueRules);
      try { await applyDemoSeed(config, { connection: db, installRole: 'postgres', runtimeRole: 'starter_runtime',
        catalogueRules, close: async () => {} }); }
      finally { db.release(); }
      const customer = randomUUID(), stale = randomUUID(), protectedOrder = randomUUID();
      await owner.query("INSERT INTO public.clients(id,email) VALUES($1,'catalogue-sweep@example.test')", [customer]);
      for (const order of [stale, protectedOrder]) {
        const session = await owner.connect();
        try {
          await session.query('BEGIN');
          await session.query(`INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor,created_at)
          VALUES($1,$2,'XTS',11400,now()-interval '1 hour')`, [order, customer]);
          await session.query(`INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
          VALUES($1,1,1,11400,11400)`, [order]);
          const adjustment = (await session.query(`INSERT INTO public.commerce_order_adjustments
          (order_id,kind,scope,amount_minor,promotion_id,definition_fingerprint)
          SELECT $1,'promotion_discount','order_total',600,promotion_id,definition_fingerprint
          FROM public.commerce_promotion_definitions WHERE promotion_id='demo-bundle:coffee' RETURNING id`, [order])).rows[0].id;
          await session.query(`INSERT INTO public.commerce_promotion_claims
          (promotion_id,definition_fingerprint,adjustment_id,order_id,client_id,amount_off_minor,reserved_at,expires_at)
          SELECT promotion_id,definition_fingerprint,$1,$2,$3,600,now()-interval '1 hour',now()-interval '45 minutes'
          FROM public.commerce_promotion_definitions WHERE promotion_id='demo-bundle:coffee'`, [adjustment, order, customer]);
          await session.query('COMMIT');
        } catch (error) { await session.query('ROLLBACK'); throw error; }
        finally { session.release(); }
      }
      await owner.query(`INSERT INTO public.commerce_settlement_intents(order_id,channel_key,amount_minor,currency_code,open_idempotency_key)
        VALUES($1,'sandbox',11400,'XTS','catalogue-sweep-protected')`, [protectedOrder]);
      await owner.query('DELETE FROM public.platform_control_operators WHERE principal_id=$1', [principal]);
      const missing = await host();
      await missing.request();
      await until(() => missing.diagnostics().includes('OPENLUP_E_STARTER_CATALOGUE_WATCHDOG_PRINCIPAL_MISSING'));
      assert.equal(await watchdog(), undefined);
      const { rows } = await owner.query('SELECT public.commerce_offer_policy_v2_readiness() AS verdict');
      assert.deepEqual(rows[0].verdict.reasons, ['promotion_watchdog_not_ready']);
      assert.deepEqual((await owner.query(`SELECT o.status,c.status AS claim FROM public.commerce_orders o
        JOIN public.commerce_promotion_claims c ON c.order_id=o.id WHERE o.id=ANY($1::uuid[]) ORDER BY o.status`,
        [[stale, protectedOrder]])).rows, [{ status: 'cancelled', claim: 'released' }, { status: 'pending_payment', claim: 'reserved' }]);
      await missing.stop();

      async function replaySeed() {
        const session = await owner.connect();
        try { await applyDemoSeed(config, { connection: session, installRole: 'postgres', runtimeRole: 'starter_runtime',
          catalogueRules: catalogueRules!, close: async () => {} }); }
        finally { session.release(); }
      }
      await owner.query('INSERT INTO public.platform_control_operators(principal_id,active) VALUES($1,false)', [principal]);
      await replaySeed();
      assert.equal((await owner.query('SELECT active FROM public.platform_control_operators WHERE principal_id=$1', [principal])).rows[0]?.active, false);
      const inactive = await host();
      await until(() => inactive.diagnostics().includes('OPENLUP_E_STARTER_CATALOGUE_WATCHDOG_PRINCIPAL_INACTIVE'));
      await inactive.stop();
      await owner.query('DELETE FROM public.platform_control_operators WHERE principal_id=$1', [principal]);
      await owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'fixture-conflict@example.test')", [principal]);
      await replaySeed();
      assert.deepEqual((await owner.query('SELECT active FROM public.platform_control_operators WHERE principal_id=$1', [principal])).rows, []);
      const collision = await host();
      await until(() => collision.diagnostics().includes('OPENLUP_E_STARTER_CATALOGUE_WATCHDOG_PRINCIPAL_CONFLICT'));
      await collision.stop();
      await owner.query('DELETE FROM public.platform_human_principals WHERE principal_id=$1', [principal]);

      const blocked = await owner.connect();
      try {
        await blocked.query('BEGIN');
        await blocked.query("SELECT 1 FROM public.platform_job_controls WHERE job_name='promotion-claim-sweep' FOR UPDATE");
        const stuck = await host();
        await until(async () => (await owner.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE usename='starter_runtime' AND wait_event_type='Lock' AND query LIKE '%platform_claim_job_run_v3%') AS waiting`)).rows[0]?.waiting);
        await stuck.request();
        durations.stuckClaimSigtermMs = await stuck.stop();
        assert.ok(durations.stuckClaimSigtermMs <= 5000);
      } finally { await blocked.query('ROLLBACK'); blocked.release(); }

      await owner.query('COMMENT ON DATABASE neutral_store IS NULL');
      const core = findPackageJSON('@openlup/core/catalog', import.meta.url);
      assert.ok(core);
      const guide = readFileSync(join(dirname(core), 'docs/guide/how-to/build/customize-the-starter.md'), 'utf8');
      const recipe = guide.split('## Make the store ready to publish')[1]?.match(/```sh\n([^]*?)\n```/u)?.[1];
      assert.ok(recipe);
      const installUrl = new URL(catalogueProofOwner!);
      const psql = spawnSync('bash', ['-s'], { cwd: app, input: recipe, encoding: 'utf8',
        env: { ...processEnv, PGHOST: installUrl.hostname, PGPORT: installUrl.port, PGUSER: installUrl.username,
          PGDATABASE: 'neutral_store', PGPASSWORD: decodeURIComponent(installUrl.password) } });
      assert.equal(psql.status, 0, psql.stderr);
      assert.deepEqual((await owner.query('SELECT principal_id,active FROM public.platform_control_operators')).rows, [{ principal_id: principal, active: true }]);

      await owner.query(`CREATE FUNCTION public.reject_test_heartbeat() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'fixture heartbeat failure'; END $$;
        CREATE TRIGGER reject_test_heartbeat BEFORE INSERT ON public.platform_control_operations
        FOR EACH ROW EXECUTE FUNCTION public.reject_test_heartbeat()`);
      const failed = await host();
      try {
        await until(async () => (await watchdog())?.status === 'failed');
        await until(() => failed.diagnostics().includes('OPENLUP_E_STARTER_CATALOGUE_WATCHDOG_UNAVAILABLE'));
        assert.deepEqual(await watchdog(), { status: 'failed', driver: 'scheduler', ready: null,
          run_driver: 'scheduler', source: 'starter-catalogue', error: 'starter_catalogue_job_failed' });
        assert.equal((await owner.query('SELECT count(*)::int AS count FROM public.platform_control_operations')).rows[0].count, 0);
        assert.equal(failed.diagnostics().includes('fixture heartbeat failure'), false);
      } finally {
        await failed.stop();
        await owner.query('DROP TRIGGER reject_test_heartbeat ON public.platform_control_operations; DROP FUNCTION public.reject_test_heartbeat()');
      }
      const began = performance.now();
      const restarted = await host();
      await until(async () => (await watchdog())?.ready === true);
      durations.firstPairMs = Math.round(performance.now() - began);
      assert.deepEqual(await watchdog(), { status: 'success', driver: 'scheduler', ready: true,
        run_driver: 'scheduler', source: 'starter-catalogue', error: null });
      await restarted.stop();
      const count = async () => (await owner.query('SELECT count(*)::int AS count FROM public.platform_job_runs')).rows[0].count;
      const before = await count();
      const preview = await host(false);
      await preview.stop();
      assert.equal(await count(), before);
      assert.deepEqual((await runtime.query('SELECT session_user,current_user')).rows, [{ session_user: 'starter_runtime', current_user: 'starter_runtime' }]);
      console.log(JSON.stringify({ scenario: 'installed catalogue job lifecycle', ...durations }));
    } finally {
      await Promise.all(hosts.map(close => close()));
      await Promise.all([owner.end(), runtime.end()]);
    }
  });

async function witnessFreshDatabase(app: string, scratch: string, project: string, env: NodeJS.ProcessEnv) {
  const hook = join(scratch, 'hold-init.sh'), override = join(scratch, 'hold-init.json');
  writeFileSync(hook, '#!/bin/sh\nset -eu\ntouch /tmp/starter-init-ready\nwhile [ ! -e /tmp/starter-init-release ]; do sleep 0.1; done\n', { mode: 0o755 });
  writeFileSync(override, JSON.stringify({ services: { database: { volumes: [
    { type: 'bind', source: hook, target: '/docker-entrypoint-initdb.d/10-starter-hold.sh', read_only: true },
  ] } } }));
  const handoff = prepareRuntimeHandoff(project, [app]);
  const compose = (args: string[]) => spawnSync('docker', ['compose', '--project-name', project, '-f', 'compose.yaml', '-f', override, ...args],
    { cwd: app, env: { ...env, ...handoff.environment, LC_ALL: 'C' }, encoding: 'utf8', timeout: 60_000 });
  const checked = (...args: string[]) => {
    const result = compose(args);
    assert.equal(result.status, 0, `Fresh PostgreSQL witness failed at ${args.slice(0, 3).join(' ')}`);
    return result.stdout.trim();
  };
  const owner = ['exec', '-T', 'database', 'psql', '-XAtw', '-U', 'postgres'];
  const sql = (text: string) => checked(...owner, '-d', 'postgres', '-c', text);
  const ready = ['exec', '-T', 'database', 'test', '-e', '/tmp/starter-init-ready'];
  try {
    checked('up', '-d', '--no-build', 'database');
    const deadline = Date.now() + 20_000;
    while (compose(ready).status !== 0 && Date.now() < deadline) await delay(100);
    checked(...ready);
    assert.equal(sql('show hba_file'), '/etc/postgresql/starter-pg-hba.conf');
    assert.equal(sql("select rolname from pg_roles where rolname='postgres'"), 'postgres');
    assert.equal(sql("select datallowconn from pg_database where datname='template1'"), 't');
    const rules = sql('select type, database, user_name, address, netmask, auth_method, options, error from pg_hba_file_rules order by line_number');
    assert.deepEqual(rules.split('\n'), [
      'local|{postgres}|{postgres}|||trust||',
      'local|{neutral_store}|{starter_install}|||trust||',
      'local|{all}|{all}|||reject||',
      'host|{neutral_store}|{openlup_catalog_publication}|all||scram-sha-256||',
      'host|{neutral_store}|{starter_runtime}|all||scram-sha-256||',
      'host|{all}|{all}|all||reject||',
    ]);
    const crossDenied = compose([...owner, '-d', 'template1', '-c', 'select 1']);
    assert.notEqual(crossDenied.status, 0);
    assert.match(crossDenied.stderr, /pg_hba.conf rejects connection/u);
    const tcpHold = compose(['exec', '-T', 'database', 'pg_isready', '-h', '127.0.0.1', '-t', '1']);
    assert.equal(tcpHold.status, 2);
    assert.match(tcpHold.stdout, /no response/u);
    checked('exec', '-T', '--user', 'postgres', 'database', 'touch', '/tmp/starter-init-release');
    checked('up', '--wait', '--wait-timeout', '45', '--no-build', 'database');
    checked('exec', '-T', 'database', 'pg_isready', '-h', '127.0.0.1');
    const fallback = checked('exec', '-T', 'database', 'sh', '-c', 'cat "$PGDATA/pg_hba.conf"')
      .split('\n').filter(line => line.trim() && !line.trimStart().startsWith('#'));
    assert.ok(fallback.length >= 2 && fallback.every(line => /\breject$/u.test(line)));
    console.log('Fresh PostgreSQL temporary socket, rules, TCP transition and deny-only fallback PASS');
  } finally { handoff.cleanup(); }
}

test('up_json_installed_starter_recipe', { skip: !recipeApp, timeout: 600_000 }, async () => {
  const app = recipeApp!;
  const origin = JSON.parse(readFileSync(join(app, '.starter-origin.json'), 'utf8'));
  assert.ok(['candidate', 'local-candidate', 'released', 'reconstructed'].includes(origin.mode ?? origin.kind));
  const preserved = JSON.parse(processEnv.OPENLUP_STARTER_CATALOGUE_RECIPE_HASHES ?? '{}');
  const assertPreserved = () => assert.deepEqual(catalogueUpgradeFixture(app), preserved, 'Adopter pack differs from the pre-upgrade fixture');
  assertPreserved();
  const context = join(app, '.context');
  mkdirSync(context, { recursive: true });
  const scratch = mkdtempSync(join(context, 'st1-recipe-'));
  const project = processEnv.OPENLUP_STARTER_CATALOGUE_RECIPE_PROJECT ?? 'st1-pr2-recipe-' + randomUUID().slice(0, 8);
  const port = processEnv.OPENLUP_STARTER_PORT || '4319';
  const env = { ...processEnv, OPENLUP_STARTER_PORT: port, COMPOSE_PROJECT_NAME: project, GIT_INDEX_FILE: join(scratch, 'index') };
  const run = (command: string, args: string[], exit = 0) => {
    const result = spawnSync(command, args, { cwd: app, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, exit, result.stdout || result.stderr);
    return result.stdout;
  };
  const up = (exit = 0) => oneLine(run('./lifecycle', ['up', '--configuration', 'coffee', '--json'], exit));
  const docker = (...args: string[]) => run('docker', ['compose', '--project-name', project, ...args]);
  const ledger = () => docker('exec', '-T', 'database', 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-U', 'starter_install',
    '-d', 'neutral_store', '-c', "SELECT pack_version FROM public.catalog_definition_installs WHERE pack_id='stationery' ORDER BY pack_version").trim();
  const packPath = join(app, 'owned/catalogue/pack.ts'), rules = join(app, 'owned/catalogue-rules.cjs');
  const initialPack = readFileSync(packPath), initialRules = readFileSync(rules);
  try {
    run('git', ['add', '-A']);
    run(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { starterCatalogue } from './host/editor-catalogue.ts';
      assert.throws(() => starterCatalogue().registry.resolve({ key: 'stationery:notebook', version: 1 }),
        { code: 'starter_catalogue_build_missing' });
    `]);
    run(process.execPath, ['--test', 'owned/catalogue-rules.test.cjs']);
    assert.equal(oneLine(run('npm', ['run', '--silent', 'catalogue:check:source'])).state, 'satisfied');
    run('npm', ['run', 'typecheck']);
    if (existsSync(join(app, 'host/runtime-database.ts'))) await witnessFreshDatabase(app, scratch, project, env);
    const heldRules = join(scratch, 'catalogue-rules.cjs');
    renameSync(rules, heldRules);
    let refused;
    try { refused = up(2); } finally { renameSync(heldRules, rules); }
    assert.equal(refused.findings[0].code, 'starter_catalogue_rules_required');
    assert.deepEqual(refused.packs, []);
    assert.equal(docker('ps', '--status', 'running', '--services').trim(), 'database');

    const readback = { id: 'stationery', version: 1, types: [{ key: 'stationery:notebook', version: 1 }], taxClasses: ['standard'] };
    const t0 = performance.now();
    assert.deepEqual(up().packs, [{ ...readback, outcome: 'installed' }]);
    const coldMs = Math.round(performance.now() - t0), warmStarted = performance.now();
    assert.deepEqual(up().packs, [{ ...readback, outcome: 'unchanged' }]);
    const warmMs = Math.round(performance.now() - warmStarted);
    assert.equal(ledger(), '1');
    const playwright = join(scratch, 'st1-recipe.playwright.mjs');
    const wsEndpoint = processEnv.OPENLUP_STARTER_CATALOGUE_RECIPE_WS_ENDPOINT;
    writeFileSync(playwright, `export default {
      testDir: '../../browser', testMatch: 'native-operator.proof.ts', workers: 1,
      use: ${JSON.stringify({ baseURL: 'http://127.0.0.1:' + port, composeProject: project, trace: 'off', screenshot: 'off', video: 'off',
        ...(wsEndpoint ? { connectOptions: { wsEndpoint } } : {}) })}
    };\n`);
    run('./node_modules/.bin/playwright', ['test', '--config', playwright, '--grep', 'installed adopter pack']);
    assertPreserved();

    writeFileSync(packPath, initialPack.toString('utf8').replaceAll('version: 1', 'version: 2'));
    writeFileSync(rules, readFileSync(rules, 'utf8') + '\n// Règles version 2\n');
    run(process.execPath, ['--test', 'owned/catalogue-rules.test.cjs']);
    assert.equal(oneLine(run('npm', ['run', '--silent', 'catalogue:check:source'])).state, 'satisfied');
    run('npm', ['run', 'typecheck']);
    assert.deepEqual(up().packs, [{ ...readback, version: 2, types: [{ key: 'stationery:notebook', version: 2 }], outcome: 'installed' }]);
    assert.equal(ledger(), '1\n2');
    const installed = JSON.parse(docker('exec', '-T', 'application', 'node', '--input-type=module', '-e', `
      import { createHash } from 'node:crypto';
      import { readStarterCatalogueRules, starterCatalogue } from './host/editor-catalogue.ts';
      const reader = starterCatalogue();
      const type = reader.registry.resolve({ key: 'stationery:notebook', version: 2 });
      console.log(JSON.stringify({ version: type.version, validator: type.validatorRef,
        rules: createHash('sha256').update(readStarterCatalogueRules()).digest('hex') }));
    `));
    const rulesDigest = createHash('sha256').update(readFileSync(rules)).digest('hex');
    assert.deepEqual(installed, { version: 2, rules: rulesDigest, validator: 'sha256:' + rulesDigest });
    const edits = run('git', ['diff', '--name-only']).trim().split('\n');
    assert.deepEqual(edits.sort(), ['owned/catalogue-rules.cjs', 'owned/catalogue/pack.ts']);
    assert.equal(run('git', ['ls-files', '--others', '--exclude-standard', 'owned/']), '');
    console.log(JSON.stringify({ scenario: 'installed Compose pack recipe', coldMs, warmMs, ledger: ledger().split('\n') }));
    run('./lifecycle', ['down']);
    docker('down', '--volumes');
    run('./lifecycle', ['up']);
    assert.equal(ledger(), '2');
  } finally {
    try { docker('down', '--volumes'); }
    finally {
      writeFileSync(packPath, initialPack);
      writeFileSync(rules, initialRules);
      rmSync(scratch, { recursive: true });
      assertPreserved();
    }
  }
});
