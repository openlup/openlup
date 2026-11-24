import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env as processEnv } from 'node:process';
import { catalogueUpgradeFixture } from './catalogue-upgrade-fixture.ts';

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
  const env = { ...processEnv, PATH: [app, dirname(process.execPath), '/usr/bin', '/bin', processEnv.PATH ?? ''].join(delimiter) };
  const observed = 'The rules file is absent for 1 adopter packs. é\n\r\t' + 'x'.repeat(500);
  const summary = { id: 'example:pack', version: 1, outcome: 'installed', types: [{ key: 'example:item', version: 2_147_483_647 }], taxClasses: ['example:standard'] };
  const accepted = { formatVersion: 1, configuration: 'coffee', exitCode: 0, state: 'satisfied', packs: [summary], findings: [] };
  try {
    for (const path of ['lifecycle', 'lifecycle.mjs', 'browser-groups.mjs', 'lifecycle-refusals.mjs',
      'host/healthcheck.ts', 'installation/refusals.ts', 'shared/refusals.ts', 'shared/config.ts']) {
      mkdirSync(join(app, path, '..'), { recursive: true });
      cpSync(join(root, path), join(app, path));
    }
    mkdirSync(join(app, 'owned'));
    writeFileSync(join(app, 'package.json'), '{"type":"module"}');
    const config = "export const selectConfiguration = (id = 'coffee') => ({ id });";
    const configFile = join(app, 'owned/store.config.ts');
    writeFileSync(configFile, config);
    writeFileSync(join(app, 'shared/config.ts'), "export const assertConfig = () => {}; export const isConfigurationId = id => typeof id === 'string';");
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
      if (args[1] !== 'run') {
        process.stdout.write('compose progress\\n');
        if (mode === 'missing-installer' && args.at(-1) === 'database') unlinkSync(process.argv[1]);
        if ((mode === 'before' && args[1] === 'build') || (mode === 'wait' && args.at(-1) === 'database')
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
    assert.deepEqual(refusal.calls[2], ['compose', 'run', '--rm', '--no-deps', '-T', 'installation',
      'node', 'lifecycle.mjs', 'install', '--configuration', 'coffee', '--json']);
    assert.match(refusal.run.stderr, /compose progress\n[\s\S]*installer progress\n/u);
    assert.equal(refusal.report.configuration, 'coffee');
    assert.deepEqual(refusal.report.packs, []);
    assert.equal(refusal.report.findings[0].observed, observed);
    assert.equal(refusal.report.findings[0].code, 'starter_catalogue_rules_required');
    assert.equal(refusal.calls.length, 3);
    const { command: _up, ...refusalEnvelope } = refusal.report;
    assert.equal(up('fake', undefined, JSON.stringify(refusalEnvelope) + '\n', 2).report.findings[0].observed, observed);
    for (const [code, path, fix] of [
      ['checkout_recovery_schedule_change_blocked_open_episodes', 'checkoutRecoveryReminders', 'Keep the current schedule in effect.'],
      ['fulfillment_stock_current_idempotency_conflict', 'owned/store.config.ts', 'Restore the original stock inputs for this SKU, then rerun the demo installer.'],
    ]) {
      const finding = { ...refusalEnvelope.findings[0], code, path, fix };
      const result = up('fake', undefined, JSON.stringify({ ...refusalEnvelope, findings: [finding] }) + '\n', 2);
      assert.deepEqual(result.report.findings, [finding]);
      assert.equal(result.calls.length, 3);
    }
    const text = up('refusal', ['--configuration', 'coffee']);
    assert.equal(text.run.status, 2);
    assert.match(text.run.stderr, /starter_catalogue_rules_required\nObserved: .*é\\n\\r\\t[^\n]+\nCause: /u);
    assert.equal(text.calls.length, 3);
    assert.deepEqual(up('success', ['--configuration', 'coffee', '--json']).report.packs, [summary]);
    for (const [mode, code, fix] of [
      ['legacy-conflict', 'starter_catalogue_build_conflict', /Restore the original declaration and rules.*new pack version/u],
      ['price-conflict', 'starter_price_seed_conflict', /Restore the original demonstration inputs/u],
      ['driver', 'starter_installation_failed', /Compose availability/u],
    ] as const) {
      const { report, calls } = up(mode);
      assert.equal(report.findings[0].code, code);
      assert.match(report.findings[0].fix, fix);
      assert.deepEqual(report.packs, []);
      assert.equal(calls.length, 3);
      const privateText = spawnSync(process.execPath, ['lifecycle.mjs', 'install', '--configuration', 'coffee'],
        { cwd: app, encoding: 'utf8', env: { ...env, ST1_CARRIER_CASE: mode } });
      assert.equal(privateText.status, 2);
      assert.equal(privateText.stderr, (mode === 'driver' ? 'starter_price_seed_conflict' : code) + '\n');
    }
    const large = up('large');
    assert.ok(Buffer.byteLength(large.run.stdout) > 1_048_576);
    assert.equal(large.report.packs.length, 9000);
    assert.equal(large.calls.at(-1)?.at(-1), 'application');

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
    assert.equal(noInstaller.calls.length, 2);
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
  } finally { rmSync(app, { recursive: true, force: true }); }
});

test('every_thrown_starter_code_is_in_the_refusal_table and discovery needs no configuration', () => {
  const invoke = (...args: string[]) => spawnSync('./lifecycle', ['refusals', ...args], { cwd: root, encoding: 'utf8', env: { PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) } });
  const json = invoke('--json'), text = invoke();
  assert.equal(json.status, 0);
  assert.equal(text.status, 0);
  const table = oneLine(json.stdout);
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
test('up_json_installed_starter_recipe', { skip: !recipeApp, timeout: 600_000 }, () => {
  const app = recipeApp!;
  const origin = JSON.parse(readFileSync(join(app, '.starter-origin.json'), 'utf8'));
  assert.ok(['candidate', 'local-candidate', 'released', 'reconstructed'].includes(origin.mode ?? origin.kind));
  const preserved = JSON.parse(processEnv.OPENLUP_STARTER_CATALOGUE_RECIPE_HASHES ?? '{}');
  const assertPreserved = () => assert.deepEqual(catalogueUpgradeFixture(app), preserved, 'Adopter pack differs from the pre-upgrade fixture');
  assertPreserved();
  const context = join(app, '.context');
  mkdirSync(context, { recursive: true });
  const scratch = mkdtempSync(join(context, 'st1-recipe-'));
  const project = 'st1-pr2-recipe-' + randomUUID().slice(0, 8);
  const env = { ...processEnv, COMPOSE_PROJECT_NAME: project, GIT_INDEX_FILE: join(scratch, 'index') };
  const run = (command: string, args: string[], exit = 0) => {
    const result = spawnSync(command, args, { cwd: app, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, exit, result.stdout || result.stderr);
    return result.stdout;
  };
  const up = (exit = 0) => oneLine(run('./lifecycle', ['up', '--configuration', 'coffee', '--json'], exit));
  const docker = (...args: string[]) => run('docker', ['compose', ...args]);
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
    writeFileSync(playwright, `export default {
      testDir: '../../browser', testMatch: 'native-operator.proof.ts', workers: 1,
      use: { baseURL: 'http://127.0.0.1:4319', composeProject: '${project}', trace: 'off', screenshot: 'off', video: 'off' }
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
