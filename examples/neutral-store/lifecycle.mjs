import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readStarterDiagnostic, starterDiagnostic } from './shared/refusals.ts';
import { seedPhysicalGuidance } from './shared/seed-physical.ts';
import { applicationHealthcheck } from './host/healthcheck.ts';
import { browserJourneyGroups } from './browser-groups.mjs';
import { catalogueApplyRefusal, operatorChallengeGuidance, starterGuidance, starterRefusals } from './lifecycle-refusals.mjs';
import { installationFailure, installationFinding, installationReport, refusal } from './installation/refusals.ts';

const root = dirname(fileURLToPath(import.meta.url));
const [command, ...args] = process.argv.slice(2);
const packageNames = ['core', 'outbox', 'platform'];
const installationHintLimit = 240;
const json = args.includes('--json');

function run(executable, argv, input, toStderr = false) {
  execFileSync(executable, argv, { cwd: root,
    stdio: [input === undefined ? 'inherit' : 'pipe', toStderr ? 2 : 'inherit', 'inherit'],
    ...(input === undefined ? {} : { input }) });
}

function delegate(executable, argv) {
  const result = spawnSync(executable, argv, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

function lifecycleOptions(argv, allowConfiguration = true) {
  let configuration;
  let jsonSeen = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--json') {
      if (jsonSeen) throw starterDiagnostic('starter_argument_duplicate');
      jsonSeen = true;
      continue;
    }
    if (!allowConfiguration || argv[index] !== '--configuration') throw starterDiagnostic('starter_argument_unknown');
    if (configuration !== undefined) throw starterDiagnostic('starter_argument_duplicate');
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw starterDiagnostic('starter_argument_value_required');
    configuration = value;
  }
  return configuration;
}

function ownedConfiguration(owner, selected) {
  const key = selected ?? owner.defaultConfigurationId;
  if (json && owner.configurations && !Object.hasOwn(owner.configurations, key))
    throw starterDiagnostic('starter_configuration_unknown');
  return owner.selectConfiguration(selected);
}

const argumentObserved = {
  starter_argument_unknown: 'The lifecycle command received an unsupported option.',
  starter_argument_duplicate: 'The lifecycle command received the same option more than once.',
  starter_argument_value_required: 'The configuration option has no value.',
};
function physicalFinding(error) {
  const diagnostic = readStarterDiagnostic(error);
  if (diagnostic?.guidance && Object.hasOwn(seedPhysicalGuidance, diagnostic.code))
    return { code: diagnostic.code, ...seedPhysicalGuidance[diagnostic.code], subject: diagnostic.guidance.subject };
}
function physicalReport({ code, path, observed, cause, fix, recheck, subject }) {
  const safeSubject = subject.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, char => `\\u{${char.codePointAt(0).toString(16)}}`);
  return installationReport(refusal(code, path, observed, cause, fix, recheck)) + `Subject: ${safeSubject}\n`;
}
function commandRefusal(error, stage, allowLegacy = false) {
  const known = installationFinding(error) ?? physicalFinding(error);
  if (known) return known;
  const diagnostic = json ? readStarterDiagnostic(error) : undefined;
  const code = json ? diagnostic?.code : (allowLegacy && error instanceof Error ? error.message : undefined);
  const guidance = code && starterGuidance(code);
  if (!guidance) return installationFinding(installationFailure(error, stage, 'launch'));
  const prerequisite = stage === '/installation' ? 'demonstration installation' : 'selected configuration';
  const { cause = `The ${prerequisite} failed a starter prerequisite.`, fix, recheck } = guidance;
  const observed = Object.hasOwn(argumentObserved, code) ? argumentObserved[code] : `The starter refused the ${prerequisite}.`;
  return installationFinding(refusal(code, diagnostic?.guidance?.path ?? stage, observed, cause,
    command === 'refusals' ? 'Use `./lifecycle refusals` with at most one `--json` option.' : diagnostic?.guidance?.fix ?? fix,
    command === 'refusals' ? 'Repeat the refusals command with the corrected options.' : recheck));
}

function installReport(configuration, packs, finding) {
  return { formatVersion: 1, state: finding ? 'violated' : 'satisfied', exitCode: finding ? 2 : 0,
    configuration, packs, findings: finding ? [finding] : [] };
}

function emit(report) {
  process.exitCode = report.exitCode;
  return new Promise((done, fail) => process.stdout.write(JSON.stringify(report) + '\n', error => error ? fail(error) : done()));
}

const fields = (row, keys) => row && typeof row === 'object' && !Array.isArray(row)
  && Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
async function readInstallReport(argv, configuration) {
  const child = spawn('docker', argv, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  const chunks = [];
  let failed = false;
  child.stdout.on('data', bytes => chunks.push(bytes));
  child.stdout.on('error', () => { failed = true; });
  child.on('error', () => { failed = true; });
  const [status, signal] = await new Promise(done => child.once('close', (...result) => done(result)));
  const line = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  if (failed || signal || !line.endsWith('\n') || line.indexOf('\n') !== line.length - 1 || line.includes('\r'))
    throw new Error('starter_installation_failed');
  const report = JSON.parse(line);
  const { catalogProductTypeRefSchema } = await import('@openlup/platform/catalog');
  const version = catalogProductTypeRefSchema.shape.version;
  if (!fields(report, ['formatVersion', 'state', 'exitCode', 'configuration', 'packs', 'findings'])
    || report.formatVersion !== 1 || report.exitCode !== status || report.configuration !== configuration
    || !Array.isArray(report.packs) || !Array.isArray(report.findings)) throw new Error('starter_installation_failed');
  if (report.state === 'satisfied' && status === 0 && report.findings.length === 0 && report.packs.every(pack =>
    fields(pack, ['id', 'version', 'outcome', 'types', 'taxClasses']) && typeof pack.id === 'string'
    && version.safeParse(pack.version).success && ['installed', 'unchanged'].includes(pack.outcome)
    && Array.isArray(pack.types) && pack.types.every(type => catalogProductTypeRefSchema.safeParse(type).success)
    && Array.isArray(pack.taxClasses) && pack.taxClasses.every(key => typeof key === 'string'))) return report;
  const findingFields = ['code', 'path', 'observed', 'cause', 'fix', 'recheck'];
  const finding = report.findings[0];
  if (Object.hasOwn(seedPhysicalGuidance, finding?.code)) findingFields.push('subject');
  if (report.state === 'violated' && status === 2 && report.packs.length === 0 && report.findings.length === 1
    && fields(finding, findingFields) && findingFields.every(key => typeof finding[key] === 'string')
    && starterGuidance(finding.code)) return report;
  throw new Error('starter_installation_failed');
}

if (command === 'refusals') {
  try {
    lifecycleOptions(args, false);
    process.stdout.write(json ? JSON.stringify(starterRefusals) + '\n' : Object.entries(starterRefusals)
      .map(([code, { cause, fix, recheck }]) => [code, cause ?? '', fix, recheck].join('\t')).join('\n') + '\n');
  } catch (error) {
    const { code, fix } = commandRefusal(error, '/arguments', true);
    process.stderr.write(`${code}\nFix: ${fix}\n`);
    process.exitCode = 2;
  }
} else if (command === 'candidate') {
  if (args.length !== 3) throw new Error('starter_candidate_requires_three_tarballs');
  const artifacts = [];
  for (let index = 0; index < packageNames.length; index++) {
    const path = resolve(args[index]);
    const archive = await readFile(path);
    // Read one known member without extracting arbitrary paths or executing package hooks.
    const manifest = JSON.parse(execFileSync('tar', ['-xOf', path, 'package/package.json'], {
      encoding: 'utf8', maxBuffer: 1024 * 1024,
    }));
    const name = packageNames[index];
    if (manifest.name !== `@openlup/${name}` || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)) {
      throw new Error('starter_candidate_identity_mismatch');
    }
    artifacts.push({ name: manifest.name, version: manifest.version,
      sha256: createHash('sha256').update(archive).digest('hex'), source: path, target: `artifacts/openlup-${name}.tgz` });
  }
  if (new Set(artifacts.map(artifact => artifact.version)).size !== 1) throw new Error('starter_candidate_set_mismatch');
  await mkdir(resolve(root, 'artifacts'), { recursive: true });
  for (const artifact of artifacts) await copyFile(artifact.source, resolve(root, artifact.target));
  await writeFile(resolve(root, 'artifacts/identity.json'), JSON.stringify({
    schemaVersion: 1, kind: 'local-candidate', artifacts: artifacts.map(({ source, ...artifact }) => artifact),
  }, null, 2) + '\n');
  run('npm', ['install', '--package-lock-only', '--ignore-scripts']);
  process.stdout.write('next: npm ci\n');
} else if (command === 'catalogue') {
  const report = await catalogueApply(args);
  if (json) await emit(report);
  else {
    process.exitCode = report.exitCode;
    for (const finding of report.findings)
      process.stderr.write(`${finding.code}\nObserved: ${safePrompt(finding.observed)}\nCause: ${finding.cause}\nFix: ${finding.fix}\nRecheck: ${finding.recheck}\n`);
    for (const receipt of report.receipts) process.stdout.write(JSON.stringify(receipt) + '\n');
  }
} else if (command === 'up') {
  let configuration = '', packs = [], stage = '/arguments';
  let final;
  try {
    const selected = lifecycleOptions(args);
    stage = '/configuration';
    const owner = await import('./owned/store.config.ts');
    const { assertConfig, isConfigurationId } = await import('./shared/config.ts');
    const config = ownedConfiguration(owner, selected);
    if (json && !isConfigurationId(config.id)) throw starterDiagnostic('starter_configuration_invalid');
    configuration = config.id;
    assertConfig(config);
    stage = '/installation';
    run('docker', ['compose', 'build'], undefined, json);
    run('docker', ['compose', 'up', '--wait', 'database'], undefined, json);
    const installerArgs = ['compose', 'run', '--rm', '--no-deps', ...(json ? ['-T'] : []), 'installation',
      'node', 'lifecycle.mjs', 'install', '--configuration', configuration, ...(json ? ['--json'] : [])];
    const report = json ? await readInstallReport(installerArgs, configuration) : undefined;
    if (report?.state === 'violated') final = report;
    else {
      if (report) packs = report.packs;
      else {
        const installer = spawnSync('docker', installerArgs, { cwd: root, stdio: 'inherit' });
        if (installer.error || installer.status === null) throw installer.error ?? new Error('starter_installation_failed');
        if (installer.status === 2) process.exit(installer.status);
        if (installer.status !== 0) throw new Error('starter_installation_failed');
      }
      // Install and runtime receive the same non-secret configuration through arguments.
      const override = { services: { application: { command: [
        'node', '--experimental-strip-types', 'lifecycle.mjs', 'serve-demo',
        '--configuration', config.id, '--port', '4319', '--listen', '0.0.0.0',
        '--database-url', 'postgresql://starter_runtime@database:5432/neutral_store',
        '--catalogue-publication-password-file', '/application/.context/catalogue-builds/.publication-password',
      ] } } };
      const healthcheck = applicationHealthcheck(config.publicOrigin);
      if (healthcheck) override.services.application.healthcheck = healthcheck;
      run('docker', ['compose', '-f', 'compose.yaml', '-f', '-', 'up', '--wait', 'application'], JSON.stringify(override), json);
      final = installReport(configuration, packs);
    }
  } catch (error) {
    const finding = commandRefusal(error, stage, stage !== '/installation');
    if (json) final = installReport(configuration, packs, finding);
    else {
      process.stderr.write(Object.hasOwn(finding, 'subject') ? physicalReport(finding) : `${finding.code}\nFix: ${finding.fix}\n`);
      process.exitCode = 2;
    }
  }
  if (json) await emit({ command: 'up', ...final });
} else if (command === 'serve-demo') {
  // Internal container entry: private runtime state never enters the image or Compose values.
  try {
    const { assertConfig, parseHostArguments } = await import('./shared/config.ts');
    const { selectConfiguration } = await import('./owned/store.config.ts');
    const options = parseHostArguments(args);
    assertConfig(selectConfiguration(options.configuration));
    const { prepareDemonstrationQuoteKey } = await import('./installation/install.ts');
    const { default: pg } = await import('pg');
    if (!options.databaseUrl) throw new Error('starter_runtime_connection_required');
    const connection = new pg.Client({ connectionString: options.databaseUrl });
    let keyFile;
    try {
      await connection.connect();
      keyFile = await prepareDemonstrationQuoteKey(connection, resolve(root, '.context'));
    } finally { await connection.end(); }
    process.argv = [process.execPath, resolve(root, 'host/server.ts'), ...args,
      '--quote-acceptance-key-file', keyFile];
    await import('./host/server.ts');
  } catch (error) {
    const code = error instanceof Error && starterGuidance(error.message)
      ? error.message : 'starter_demo_start_failed';
    const finding = physicalFinding(error);
    process.stderr.write(finding ? physicalReport(finding) : `${code}\n`);
    process.exitCode = 2;
  }
} else if (command === 'install') {
  // Internal one-shot Compose entry; no install connection reaches the HTTP host.
  const installEntry = Symbol.for('openlup.neutral-store.install-entry');
  // This one-shot process has its own catalogue admission before the host import.
  Reflect.set(globalThis, installEntry, true);
  let configuration = '', stage = '/arguments';
  let final;
  try {
    const selected = lifecycleOptions(args);
    stage = '/configuration';
    const [installation, owner] = await Promise.all([
      import('./installation/install.ts'), import('./owned/store.config.ts'),
    ]).catch(error => {
      if (json && readStarterDiagnostic(error)) throw error;
      throw installationFailure(error);
    });
    const config = ownedConfiguration(owner, selected);
    if (json) {
      const { assertConfig, isConfigurationId } = await import('./shared/config.ts');
      if (!isConfigurationId(config.id)) throw starterDiagnostic('starter_configuration_invalid');
      configuration = config.id;
      assertConfig(config);
    }
    stage = '/installation';
    const packs = await installation.installDemonstration(config, installation.bootstrapDemonstration, json ? process.stderr : process.stdout);
    if (json) final = installReport(configuration, packs);
  } catch (error) {
    if (json) final = installReport(configuration, [], commandRefusal(error, stage, stage !== '/installation'));
    else {
      const finding = physicalFinding(error);
      let report = finding ? physicalReport(finding) : installationReport(error);
      if (!report) {
        const code = error instanceof Error ? error.message : 'starter_installation_failed';
        const hint = [error?.hint, error?.cause?.hint].find(value => typeof value === 'string' && value.trim());
        report = `${code}\n${hint ? hint.trim().replace(/\s+/gu, ' ').slice(0, installationHintLimit) + '\n' : ''}`;
      }
      process.exitCode = 2;
      await new Promise((resolve, reject) => process.stderr.write(report, error => error ? reject(error) : resolve()));
    }
  } finally { Reflect.deleteProperty(globalThis, installEntry); }
  if (json) await emit(final);
  // The installed runner owns its pool; this one-shot process owns its lifetime.
  process.exit(process.exitCode ?? 0);
} else if (command === 'browser') {
  await databaseBrowserRecipe(args);
} else if (command === 'checkout-recovery') {
  const { selectConfiguration } = await import('./owned/store.config.ts');
  const { parseHostArguments, assertConfig } = await import('./shared/config.ts');
  const { runCheckoutRecovery } = await import('./host/paid-mail.ts');
  const { default: pg } = await import('pg');
  const options = parseHostArguments(args), config = selectConfiguration(options.configuration);
  assertConfig(config);
  if (!options.databaseUrl) throw new Error('starter_runtime_connection_required');
  const pool = new pg.Pool({ connectionString: options.databaseUrl });
  try { process.stdout.write(JSON.stringify(await runCheckoutRecovery({ executor: pool, config,
    publicOrigin: config.publicOrigin ?? `http://127.0.0.1:${options.port}` })) + '\n'); }
  finally { await pool.end(); }
} else if (command === 'care') {
  const { selectConfiguration } = await import('./owned/store.config.ts');
  const { parseHostArguments, assertConfig } = await import('./shared/config.ts');
  const { runScheduledCare } = await import('./host/scheduled-renewal.ts');
  const options = parseHostArguments(args);
  const config = selectConfiguration(options.configuration); assertConfig(config);
  if (!options.databaseUrl) throw new Error('starter_runtime_connection_required');
  process.stdout.write(JSON.stringify(await runScheduledCare(options.databaseUrl, config, { publicOrigin: `http://127.0.0.1:${options.port}` })) + '\n');
} else if (command === 'renewal') {
  const { selectConfiguration } = await import('./owned/store.config.ts');
  const { parseHostArguments, assertConfig } = await import('./shared/config.ts');
  const { runScheduledRenewal } = await import('./host/scheduled-renewal.ts');
  const options = parseHostArguments(args);
  const config = selectConfiguration(options.configuration);
  assertConfig(config);
  if (!options.databaseUrl) throw new Error('starter_runtime_connection_required');
  // Local invocation only. The existing scheduler may call this same entry.
  process.stdout.write(JSON.stringify(await runScheduledRenewal(options.databaseUrl, config)) + '\n');
} else if (command === 'down') {
  // Does not discard the database volume. Destruction is an explicit separate owner action.
  run('docker', ['compose', 'down']);
} else if (command === 'verify') {
  const binary = resolve(root, 'node_modules/.bin/openlup');
  try { await access(binary); }
  catch { throw new Error('starter_installed_verify_unavailable'); }
  delegate(binary, ['verify', ...args]);
} else if (command === 'upgrade') {
  const binary = resolve(root, 'node_modules/.bin/openlup');
  try { await access(binary); }
  catch { throw new Error('starter_installed_upgrade_unavailable'); }
  delegate(binary, ['upgrade', ...args]);
} else if (command === 'ownership') {
  process.stdout.write(await readFile(resolve(root, 'ownership.json'), 'utf8'));
} else {
  process.stderr.write('Usage: ./lifecycle candidate <core.tgz> <outbox.tgz> <platform.tgz> | up [--configuration <id>] [--json] | catalogue apply [--configuration <id>] [--prepare-only | --copy | --reprice] [--json] | refusals [--json] | browser [Playwright selection flags] | checkout-recovery --configuration <id> --database-url <runtime-url> | care --configuration <id> --database-url <runtime-url> | renewal --configuration <id> --database-url <runtime-url> | down | verify | upgrade <args> | ownership\n');
  process.exitCode = 2;
}

function safePrompt(value) {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
}

async function catalogueApply(argv) {
  const receipts = [];
  let terminal;
  let path = '/arguments';
  const unavailable = 'OPENLUP_E_CATALOGUE_APPLY_UNAVAILABLE';
  const deny = (code, details = {}, cause, hostCode) => {
    throw Object.assign(catalogueApplyRefusal({ code, path, ...details }, cause), { hostCode });
  };
  const report = finding => ({ formatVersion: 1, command: 'catalogue apply', state: finding ? 'violated' : 'satisfied',
    exitCode: finding ? 2 : 0, receipts, findings: finding ? [finding] : [] });
  try {
    const [verb, ...options] = argv;
    const modes = options.filter(option => ['--prepare-only', '--copy', '--reprice'].includes(option));
    if (verb !== 'apply' || modes.length > 1) deny('starter_argument_unknown');
    const [mode] = modes;
    const config = ownedConfiguration(await import('./owned/store.config.ts'), lifecycleOptions(options.filter(option => option !== mode)));
    (await import('./shared/config.ts')).assertConfig(config);
    const [owned, { buildCatalogReleaseDraftV3 }, { canonicalCatalogDraftJson }, pricing, { mapStarterPresentation }, { digestStarterMedia }] = await Promise.all([
      import('./owned/catalogue.ts'), import('@openlup/platform/catalog'), import('@openlup/platform/catalog/contracts'),
      import('@openlup/platform/pricing'), import('./shared/catalogue-presentation.ts'), import('./host/catalogue-media.ts'),
    ]);
    const hash = value => createHash('sha256').update(canonicalCatalogDraftJson(value)).digest('hex');
    const same = (left, right) => canonicalCatalogDraftJson(left) === canonicalCatalogDraftJson(right);
    const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
    path = 'catalogueProduct';
    if (!Object.hasOwn(owned, 'catalogueProduct')) deny('OPENLUP_E_CATALOGUE_PRODUCT_REQUIRED');
    const { draftId, product, basePrices, copyPresentation } = JSON.parse(canonicalCatalogDraftJson(owned.catalogueProduct));
    if (typeof draftId !== 'string' || !uuid.test(draftId)) deny('starter_input_invalid', { path: 'draftId' });
    const { release, activation } = buildCatalogReleaseDraftV3(product);
    const skus = release.payload.skus;
    const productId = release.payload.product.id;
    const presentation = mapStarterPresentation(release.payload.product.sharedContent.presentation);
    const copy = mode === '--copy' ? mapStarterPresentation(copyPresentation) : undefined;
    if (!presentation || (mode === '--copy' && !copy))
      deny('starter_catalogue_presentation_invalid', { path: mode === '--copy' ? 'copyPresentation' : 'product.presentation' });
    async function bindMedia(payload, mediaRef, path) {
      if (!mediaRef) { delete payload.publication.evidence.media; return; }
      const revisionDigest = await digestStarterMedia(mediaRef);
      if (!revisionDigest) deny(revisionDigest === null ? 'catalog_publication_media_validation_unavailable' : 'starter_catalogue_media_invalid', { path });
      payload.publication.evidence.media = payload.skus.map(({ code, assetRefs }) => ({
        skuCode: code, mediaRef, assetRefs: assetRefs ?? [], revisionDigest,
      }));
    }
    if (presentation.media) {
      await bindMedia(activation.payload, presentation.media, 'product.presentation.mediaRef');
      activation.digest = hash(activation.payload);
    }
    path = 'basePrices';
    if (!basePrices || typeof basePrices !== 'object' || Array.isArray(basePrices)
      || Object.keys(basePrices).length !== skus.length || !skus.every(({ code }) => Object.hasOwn(basePrices, code)))
      deny('OPENLUP_E_CATALOGUE_BASE_PRICES_MISMATCH');
    for (const { code } of skus) {
      const amount = basePrices[code];
      if (!Number.isInteger(amount) || amount < 1 || amount > pricing.CATALOG_PRICE_SETUP_MAX_MINOR)
        deny('starter_catalogue_price_invalid', { subject: code });
    }
    const stages = ['release', 'activation', 'copy'];
    function makeStage(stage, artifact, head) {
      const index = stages.indexOf(stage);
      const save = { action: index === 0 ? 'create' : 'revise', draftId, expectedRevision: index, payload: artifact.payload };
      if (Buffer.byteLength(JSON.stringify(save)) > 65_536) deny('starter_catalogue_save_too_large', { path: `${stage}.save` });
      return { stage, revision: index + 1, save, head, saveKey: hash([stage, 'save', draftId, index, artifact.digest]),
        key: action => hash([stage, action, draftId, artifact.digest, head]) };
    }
    const first = makeStage('release', release, null);
    makeStage('activation', activation, null);
    if (!process.stdin.isTTY || !process.stderr.isTTY) deny('OPENLUP_E_CATALOGUE_TERMINAL_REQUIRED', { path: '/terminal' });
    const origin = config.publicOrigin ?? 'http://127.0.0.1:4319';
    let cookie, expiresAt, operator, writeRevisionId;
    async function request(operation, body, key = hash([operation, body]), authenticated = false, sku) {
      const unavailableCodes = ['host_binding_required', 'starter_dependency_unavailable', 'starter_operation_unknown',
        'price_setup_dependency_unavailable', 'store_unavailable'];
      let response, result;
      try {
        response = await fetch(new URL(`/api/actions/${operation}`, origin), { method: 'POST', redirect: 'error',
          headers: { Origin: origin, 'X-Starter-Request': '1', 'Content-Type': 'application/json', 'Idempotency-Key': key,
            ...(authenticated && cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
        result = await response.json();
      } catch (error) { deny(unavailable, { subject: sku }, error); }
      if (result?.ok === true && response.ok) return { value: result.value, cookie: response.headers.get('set-cookie') };
      const code = result?.code;
      const guidance = ['observed', 'cause', 'fix', 'recheck'].every(field => typeof result?.[field] === 'string') ? result : undefined;
      const details = { ...(result?.path && { path: result.path }), subject: sku ?? result?.subject, reason: result?.reason ?? (sku && code),
        issues: result?.issues, message: result?.message, guidance };
      deny(typeof code === 'string' && !unavailableCodes.includes(code) ? code : unavailable, details,
        undefined, typeof code === 'string' ? code : undefined);
    }
    path = 'catalogue.demoTarget';
    const { value: demo } = await request('catalogue.demoTarget', {});
    if (!demo?.marked || demo.configurationId !== config.id) deny('starter_seed_demonstration_database_required');
    const [{ createInterface }, { Writable }] = await Promise.all([import('node:readline/promises'), import('node:stream')]);
    let privateInput = false;
    const output = new Writable({ write(chunk, _encoding, done) {
      if (privateInput) done();
      else process.stderr.write(chunk, done);
    } });
    terminal = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
    const stopped = new AbortController();
    terminal.on('close', () => stopped.abort());
    async function ask(prompt, hidden = false) {
      privateInput = hidden;
      if (hidden) process.stderr.write(prompt);
      try { return await terminal.question(hidden ? '' : prompt, { signal: stopped.signal }); }
      catch { deny(path === 'auth.operator' ? 'starter_catalogue_sign_in_incomplete' : 'OPENLUP_E_CATALOGUE_CONFIRMATION_INVALID'); }
      finally {
        privateInput = false;
        if (hidden) process.stderr.write('\n');
      }
    }
    async function signIn() {
      const priorPath = path;
      path = 'auth.operator';
      cookie = undefined;
      const email = await ask(`Invited operator email (configured currency ${config.market.currency}): `);
      await request('auth.operator', { email }, hash(['challenge', Date.now()]));
      process.stderr.write(`${operatorChallengeGuidance}\nRead the matching message in the private demo mailbox.\n`);
      const token = await ask('Operator token (hidden): ', true);
      const login = await request('auth.operator', { token }, hash(['redeem', Date.now()]));
      cookie = login.cookie?.split(';', 1)[0];
      expiresAt = Date.parse(login.value?.expiresAt);
      if (!/^starter_session=[A-Za-z0-9_-]{43}$/u.test(cookie ?? '') || !Number.isFinite(expiresAt)) deny(unavailable);
      path = 'price-target';
      const { value } = await request('operator.catalogPublication', { action: 'price-target' }, undefined, true);
      if (operator && mode === '--reprice' && (operator.actorId !== value.actorId || operator.priceListId !== value.priceListId))
        deny('starter_catalogue_reprice_review_required');
      if (operator && operator.actorId !== value.actorId) deny('publisher_not_authorized');
      if (operator && mode !== '--reprice' && !same(operator, value)) deny('starter_catalogue_d2c_policy_required');
      operator ??= value;
      writeRevisionId = value.policy.revisionId;
      path = priorPath;
    }
    async function action(operation, body, key, sku) {
      if (Date.now() >= expiresAt) await signIn();
      return (await request(operation, typeof body === 'function' ? body() : body, key, true, sku)).value;
    }
    const publish = (body, key, sku) => action('operator.catalogPublication', body, key, sku);
    const drafts = (body, key) => action('operator.catalogDrafts', body, key);
    await signIn();
    const { currency, priceListId, policy, actorId } = operator;
    path = 'basePrices';
    for (const { code } of skus)
      if (pricing.deriveSubscriptionUnitPrice(basePrices[code], policy) <= 0) deny('starter_catalogue_derived_price_zero', { subject: code });
    const prices = [];
    const record = (stage, outcome, draftRevision, head, items = prices) => receipts.push({ stage, outcome, productId, draftId,
      draftRevision, head, currency, prices: [...items] });
    function verifyDraft(saved, step) {
      if (!saved || saved.draftId !== draftId || saved.productId !== productId || saved.revision !== step.revision
        || saved.actorId !== actorId || saved.commandKey !== step.saveKey || !same(saved.payload, step.save.payload))
        deny('publication_draft_advanced');
    }
    function requireIssuer(receipt) {
      if (receipt.actorId !== actorId) deny('publisher_not_authorized');
    }
    async function issued(step, receipt, verifyIssuer = true) {
      if (verifyIssuer) requireIssuer(receipt);
      if (receipt.productId !== productId || receipt.commandKey !== step.key('publish')
        || !same(receipt.previousHead, step.head) || receipt.head.revision !== step.revision
        || receipt.head.documentDigest !== step.save.payload.product.documentRevision.digest) deny('catalog_publication_receipt_invalid');
      const exact = await publish({ action: 'exact', head: receipt.head });
      if (exact.product?.id !== productId || !same(exact.head, receipt.head)) deny('catalog_publication_receipt_invalid');
      return receipt.head;
    }
    async function lookup(step, verifyIssuer = true) {
      path = `${step.stage}.publish`;
      const result = await publish({ action: 'receipt', productId, commandKey: step.key('publish') });
      if (result.outcome !== 'found') return null;
      await issued(step, result.receipt, verifyIssuer);
      return result.receipt;
    }
    async function runStage(step, observed, prepareOnly = false) {
      const { stage, revision, head, save, saveKey, key } = step;
      const note = (name, outcome, next = head) => record(`${stage}.${name}`, outcome, revision, next);
      path = `${stage}.save`;
      if (prepareOnly && !observed) process.stderr.write('Save + Prepare writes a catalogue draft.\n');
      const result = await drafts(save, saveKey);
      verifyDraft(result.record, step);
      note('save', result.outcome);
      if (observed) { note('publish', 'observed', observed); return observed; }
      path = `${stage}.prepare`;
      const prepared = await drafts({ action: 'prepare', draftId, expectedRevision: revision, expectedHead: head });
      const { candidateRef, candidateDigest, preparation, impact } = prepared;
      if (!same(prepared.expectedHead, head)) deny('head_conflict');
      if (!preparation?.postStateDigest || impact?.productId !== productId) {
        const issues = preparation?.structural?.issues ?? prepared.issues;
        deny(issues?.[0]?.code ?? 'publication_preparation_unavailable', { ...issues?.[0], issues });
      }
      note('prepare', 'observed');
      if (prepareOnly) return null;
      path = `${stage}.approve`;
      const display = stage === 'copy' ? copy : presentation;
      const shownPrices = prices.length ? prices : skus.map(({ code, id: skuId }) => ({ code, skuId, unitPriceMinor: basePrices[code], currency }));
      const effect = { release: 'Release the product and its draft SKUs', activation: 'Activate the priced product and SKUs', copy: 'Publish presentation only' };
      const context = { product: display.title, productId, draftId, revision, expectedHead: head, currency,
        [prices.length ? 'confirmedPrices' : 'plannedPrices']: shownPrices };
      if (await ask(`${effect[stage]}.\n${safePrompt(JSON.stringify(context))}\nType approve: `) !== 'approve')
        deny('OPENLUP_E_CATALOGUE_CONFIRMATION_INVALID');
      const candidate = { productId: impact.productId, candidateRef, candidateDigest };
      const decision = await publish({ action: 'approve', ...candidate, postStateDigest: preparation.postStateDigest }, key('approve'));
      const decisionReceipt = decision.receipt;
      if (decisionReceipt?.actorId !== actorId || decisionReceipt.productId !== productId
        || decisionReceipt.candidateRef !== candidateRef || decisionReceipt.commandKey !== key('approve')
        || decisionReceipt.candidateDigest !== candidateDigest || decisionReceipt.postStateDigest !== preparation.postStateDigest)
        deny('catalog_publication_receipt_invalid');
      note('approve', decision.outcome);
      path = `${stage}.publish`;
      const body = { action: 'publish', ...candidate, expectedHead: head, changes: [] };
      const resultOfPublish = await publish(body, key('publish')).catch(async error => {
        if (error.finding?.code !== 'publication_price_readiness'
          || !['promotion_claim_sweep_not_ready', 'promotion_watchdog_not_ready'].includes(error.finding.reason)) throw error;
        // Give the first demo job pair one chance to finish, then surface any refusal from the unchanged request.
        await new Promise(resolve => setTimeout(resolve, 1000));
        return publish(body, key('publish'));
      });
      const next = await issued(step, resultOfPublish.receipt);
      note('publish', resultOfPublish.outcome, next);
      return next;
    }
    function pricePreview(variantId, code, unitPriceMinor) {
      path = 'basePrices';
      return publish({ action: 'price-preview', variantId, priceListId, ...(unitPriceMinor !== undefined && { unitPriceMinor }) }, undefined, code);
    }
    function reviewPreview({ listEffective, priceSetup }, code) {
      if (!listEffective) deny('price_list_not_active', { subject: code });
      const subscription = priceSetup.subscription;
      if (subscription.kind !== 'derived' || subscription.revisionId !== policy.revisionId)
        deny('starter_catalogue_d2c_policy_required', { subject: code });
      const unitPriceMinor = basePrices[code];
      if (pricing.deriveSubscriptionUnitPrice(unitPriceMinor, { ...subscription, roundingRule: 'FLOOR_TO_QUANTUM' }) <= 0)
        deny('starter_catalogue_derived_price_zero', { subject: code });
      return priceSetup;
    }
    async function preview(sku) {
      const { code } = sku;
      const priceSetup = reviewPreview(await pricePreview(sku.id), code);
      const unitPriceMinor = basePrices[code];
      if (priceSetup.currentCount > 1 || (priceSetup.current && priceSetup.current.unitPriceMinor !== unitPriceMinor))
        deny('expected_state_mismatch', { subject: code });
      return priceSetup.current;
    }
    function remapPriceMismatch(error, code, subject) {
      if (error.finding?.code !== 'expected_state_mismatch') throw error;
      deny(code, { subject, reason: error.finding.reason ?? error.finding.code, issues: error.finding.issues });
    }
    function subscriptionFigure(subscription) {
      if (subscription?.kind === 'derived' && subscription.revisionId && subscription.derivedUnitPriceMinor > 0)
        return { policyRevisionId: subscription.revisionId, subscriptionUnitPriceMinor: subscription.derivedUnitPriceMinor };
    }
    function hasPending(priceSetup, subject) {
      if (typeof priceSetup?.hasPending !== 'boolean') deny(unavailable, { subject });
      return priceSetup.hasPending;
    }
    async function reviewPublishedPrices(active) {
      const changes = [];
      for (const sku of skus) {
        const { id: skuId, code } = sku;
        const declared = basePrices[code];
        let reviewed = reviewPreview(await pricePreview(skuId, code), code);
        if (reviewed.currentCount > 1) deny('base_price_ambiguous', { subject: code });
        if (hasPending(reviewed, code)) deny('starter_catalogue_price_scheduled', { subject: code });
        if (mode === '--reprice' && reviewed.current?.unitPriceMinor !== declared) {
          const proposed = await pricePreview(skuId, code, declared)
            .catch(error => remapPriceMismatch(error, 'starter_catalogue_price_scheduled', code));
          reviewed = reviewPreview(proposed, code);
        }
        const { current, subscription } = reviewed;
        if (reviewed.currentCount > 1) deny('base_price_ambiguous', { subject: code });
        if (!current) deny('starter_catalogue_reprice_base_missing', { subject: code });
        const { entryId, unitPriceMinor } = current;
        if (unitPriceMinor === declared) {
          const figure = subscriptionFigure(subscription);
          if (!figure) deny('starter_catalogue_derived_price_zero', { subject: code });
          const item = { skuId, entryId, unitPriceMinor, currency, ...figure };
          prices.push(item);
          if (active) record('price.apply', 'observed', 2, active, [item]);
          continue;
        }
        if (!reviewed.inGate) deny('starter_catalogue_reprice_requires_active', { subject: code });
        const estimate = amount => pricing.deriveSubscriptionUnitPrice(amount, { ...subscription, roundingRule: 'FLOOR_TO_QUANTUM' });
        changes.push({ code, skuId, from: { entryId, unitPriceMinor }, to: { unitPriceMinor: declared },
          subscriptionEstimate: { from: estimate(unitPriceMinor), to: estimate(declared) } });
      }
      if (changes.length && mode !== '--reprice') deny('starter_catalogue_reprice_required', { subject: changes[0].code });
      return changes;
    }
    async function reprice(changes, active) {
      if (!changes.length) { process.stderr.write('No price changes.\n'); return; }
      const proposal = { product: presentation.title, productId, currency, changes };
      if (await ask(`Change live base prices.\n${safePrompt(JSON.stringify(proposal))}\nSubscription figures are estimates under the policy effective now. Approval covers the base amounts only.\nType approve: `) !== 'approve')
        deny('OPENLUP_E_CATALOGUE_CONFIRMATION_INVALID');
      for (const { code, skuId, from: expected, to: { unitPriceMinor } } of changes) {
        path = 'basePrices';
        const key = hash(['reprice', actorId, priceListId, skuId, unitPriceMinor, expected]);
        let sent;
        async function apply(exact = false) {
          const previous = sent;
          let dispatched = false;
          try {
            return await publish(() => {
              dispatched = true;
              if (!exact) sent = { action: 'price-apply', variantId: skuId, priceListId,
                policyRevisionId: writeRevisionId, unitPriceMinor, expected };
              return sent;
            }, key, code);
          } catch (error) {
            if (dispatched && previous && ['starter_catalogue_d2c_policy_required', 'starter_catalogue_reprice_requires_active',
              'starter_catalogue_derived_price_zero', 'price_list_not_active'].includes(error.hostCode))
              deny('starter_catalogue_reprice_retry_unverified', { subject: code, reason: error.hostCode, issues: error.finding.issues });
            if (dispatched && !previous && error.finding?.code === unavailable && error.hostCode === undefined)
              return apply(true);
            throw error;
          }
        }
        const result = await apply().catch(async error => {
          if (error.finding?.code !== 'starter_catalogue_d2c_policy_required') throw error;
          const { listEffective, priceSetup } = await pricePreview(skuId, code);
          const revisionId = subscriptionFigure(priceSetup?.subscription)?.policyRevisionId;
          if (listEffective !== true || !revisionId || revisionId === writeRevisionId) throw error;
          writeRevisionId = revisionId;
          return apply();
        }).catch(async error => {
          if (error.finding?.code !== 'expected_state_mismatch') throw error;
          const { priceSetup } = await pricePreview(skuId, code);
          remapPriceMismatch(error, hasPending(priceSetup, code) ? 'starter_catalogue_price_scheduled' : 'starter_catalogue_reprice_stale', code);
        });
        const { current, previous } = result.receipt;
        const item = { skuId, entryId: current.entryId, unitPriceMinor: current.unitPriceMinor, currency: result.currency,
          previous: { entryId: previous.entryId, unitPriceMinor: previous.unitPriceMinor } };
        record('price.reprice', result.outcome, 2, active, [item]);
        let figure, reason, issues;
        try {
          const { listEffective, priceSetup } = await pricePreview(skuId, code);
          if (listEffective === true && priceSetup?.currentCount === 1 && priceSetup.current?.entryId === item.entryId
            && priceSetup.current.unitPriceMinor === item.unitPriceMinor)
            figure = subscriptionFigure(priceSetup.subscription);
        } catch (error) {
          reason = error.hostCode ?? error.finding?.code;
          issues = error.finding?.issues;
        }
        if (!figure) deny('starter_catalogue_reprice_readback_unverified',
          { path: 'basePrices', subject: code, reason, issues });
        Object.assign(item, figure);
        writeRevisionId = figure.policyRevisionId;
      }
    }
    async function requireHead(expected) {
      const current = await publish({ action: 'current', productId });
      if (!same(current.head ?? null, expected)) deny('head_conflict', { path: 'expectedHead' });
    }
    async function verifyPublished(released, active) {
      record('release.publish', 'observed', 1, released);
      record('activation.publish', 'observed', 2, active);
      const changes = await reviewPublishedPrices(active);
      if (mode === '--reprice') await reprice(changes, active);
      return report();
    }
    const verifyIssuer = mode === '--copy' || mode === '--prepare-only';
    const releaseReceipt = await lookup(first, verifyIssuer);
    const released = releaseReceipt?.head ?? null;
    const activationStep = released && mode !== '--prepare-only' ? makeStage('activation', activation, released) : null;
    const active = activationStep ? (await lookup(activationStep, verifyIssuer))?.head ?? null : null;
    if (mode === '--reprice' && !active) deny('starter_catalogue_copy_requires_published');
    if (active && !verifyIssuer) return await verifyPublished(released, active);
    if (mode === '--copy') {
      if (!active) deny('starter_catalogue_copy_requires_published');
      const { record: saved } = await drafts({ action: 'get', draftId, revision: 2 });
      verifyDraft(saved, activationStep);
      const payload = saved.payload;
      if (same(payload.product.sharedContent.presentation, copyPresentation)) deny('starter_catalogue_copy_unchanged', { path: 'copyPresentation' });
      Object.assign(payload.product.sharedContent, { catalogAction: 'revise', presentation: copyPresentation });
      payload.publication.operations = [{ op: 'set_product_presentation', productSlug: payload.product.slug, presentation: copyPresentation }];
      await bindMedia(payload, copy.media, 'copyPresentation.mediaRef');
      const third = makeStage('copy', { payload, digest: hash(payload) }, active);
      const copied = (await lookup(third))?.head ?? null;
      await requireHead(copied ?? active);
      await reviewPublishedPrices();
      await runStage(third, copied);
    } else {
      if (releaseReceipt) { path = 'release.publish'; requireIssuer(releaseReceipt); }
      if (!released) await requireHead(null);
      const head = await runStage(first, released, mode === '--prepare-only');
      if (mode === '--prepare-only') return report();
      const second = activationStep ?? makeStage('activation', activation, head);
      if (!activationStep) {
        const concurrent = await lookup(second, false);
        if (concurrent) return await verifyPublished(head, concurrent.head);
      }
      path = 'activation.publish';
      await requireHead(head);
      for (const sku of skus) await preview(sku);
      for (const { id: variantId, code } of skus) {
        path = 'basePrices';
        const unitPriceMinor = basePrices[code];
        const result = await publish({ action: 'price-apply', variantId, priceListId, policyRevisionId: policy.revisionId, unitPriceMinor },
          hash(['initial-base', priceListId, variantId, unitPriceMinor, null]), code);
        const current = await preview({ id: variantId, code });
        if (result.currency !== currency || !current || !same(result.receipt?.current, current))
          deny('expected_state_mismatch', { subject: code });
        prices.push({ skuId: variantId, entryId: current.entryId, unitPriceMinor, currency });
        record('price.apply', result.outcome, 1, head);
      }
      await runStage(second, null);
    }
    return report();
  } catch (error) {
    if (error.finding) return report(error.finding);
    if (error.code === 'release_draft_invalid') {
      const [observed, cause, fix, recheck] = error.message.split('\n').map(line => line.slice(line.indexOf(': ') + 2));
      return report({ code: error.code, path: error.path, observed, cause, fix, recheck });
    }
    return report(catalogueApplyRefusal({ code: readStarterDiagnostic(error)?.code ?? unavailable, path }, error).finding);
  } finally { terminal?.close(); }
}

/** Disposable installed-PostgreSQL recipe; never a production or customer database. */
async function databaseBrowserRecipe(argv, prepareCatalogueTemplate = true) {
  if (argv.length === 0) {
    for (const selection of browserJourneyGroups) await databaseBrowserRecipe(selection, selection === browserJourneyGroups.at(-1));
    return;
  }
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { randomBytes, randomUUID } = await import('node:crypto');
  const { createServer } = await import('node:net');
  const { hostname } = await import('node:os');
  const { default: pg } = await import('pg');
  const { createPlatformPostgresMigrationRunner, qualifiedPostgresStartupOptions } = await import('@openlup/platform/migrations');
  const { configurations } = await import('./owned/store.config.ts');
  const { market } = await import('./owned/market.config.ts');
  const { applyDemoSeed, demonstrationMarker, provisionDemonstrationPublicationPassword } = await import('./installation/install.ts');
  const { readStarterCatalogueRules } = await import('./host/editor-catalogue.ts');
  const application = root;
  const directory = resolve(application, '.context/care-browser');
  const upgrade = await readFile(resolve(directory, 'upgrade.json'), 'utf8')
    .then(JSON.parse, error => { if (error.code !== 'ENOENT') throw error; });
  const previous = upgrade && createRequire(resolve(upgrade.predecessor, 'package.json'));
  const previousMigrations = previous && await import(pathToFileURL(previous.resolve('@openlup/platform/migrations')).href);
  const previousSubscriptions = previous && await import(pathToFileURL(previous.resolve('@openlup/platform/subscriptions')).href);
  const containers = [], hosts = [], pools = new Set();
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const delay = (ms) => new Promise(done => setTimeout(done, ms));
  async function child(command, args) {
    const process = spawn(command, args, { cwd: application, stdio: 'inherit' });
    const [code] = await once(process, 'exit');
    if (code !== 0)
      throw new Error('starter_database_browser_command_failed');
  }
  async function seedLegacyCancel(owner, runtime, terms) {
    const email = `legacy-${randomUUID()}@example.test`;
    const actorId = randomUUID(), clientId = randomUUID(), subscriptionRef = randomUUID(), key = randomUUID();
    await owner.query('INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)', [actorId, email]);
    await owner.query("INSERT INTO public.clients(id,email,principal_id,lifecycle_stage) VALUES($1,$2,$3,'customer')", [clientId, email, actorId]);
    await owner.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,started_at,next_cycle_at) VALUES($1,$2,28,now()-interval '1 day',now()+interval '28 days')",
      [subscriptionRef, clientId]);
    const input = { action: 'cancel', reason: '  legacy retention  ', confirmedChargeTiming: false,
      survey: { reasonCode: 'retired_reason', comment: '  prior feedback  ' }, saveOffer: null };
    const receipt = await previousSubscriptions.createPostgresSubscriptionCommands({
      retentionReasonCodes: ['retired_reason'], lifecycleTerms: terms,
      async withTransaction(work) {
        const db = await runtime.connect();
        try { await db.query('BEGIN'); const value = await work(db); await db.query('COMMIT'); return value; }
        catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
      },
      async futureTerms() { throw new Error('starter_legacy_cancel_does_not_use_future_terms'); },
    }).apply({ ...input, actor: { kind: 'customer', clientId, actorId }, subscriptionId: subscriptionRef, idempotencyKey: key, now: new Date().toISOString() });
    if (receipt.outcome !== 'applied') throw new Error(`starter_predecessor_cancel_failed: ${receipt.reason}`);
    const { rows: [snapshot] } = await owner.query(`SELECT r.command->'payload' AS payload, r.command_fingerprint,
      to_jsonb(event) AS event FROM public.subscription_command_receipts r
      JOIN LATERAL (SELECT e.id,e.subscription_id,e.event_type,e.idempotency_key,e.payload,e.occurred_at,e.created_at,e.communication_subject_id
        FROM public.subscription_events e WHERE e.id=(r.result->>'eventId')::uuid) event ON true
      WHERE r.subscription_id=$1 AND r.idempotency_key=$2`, [subscriptionRef, key]);
    return { email, subscriptionRef, input, key, receipt, snapshot };
  }
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // An explicit isolated config avoids accidentally loading an author's parent Vite config.
    const viteConfig = resolve(directory, 'vite.config.mjs');
    await writeFile(viteConfig, `export default {root:${JSON.stringify(application)}};\n`, { mode: 0o600 });
    await child('npx', ['--no', '--', 'vite', 'build', '--config', viteConfig]);
    const entries = [];
    for (const config of Object.values(configurations)) {
      const name = `starter-care-${process.pid}-${config.id}-${randomUUID().slice(0, 8)}`;
      containers.push(name);
      docker('run', '--detach', '--name', name, '--tmpfs', '/var/lib/postgresql/data:rw', '--label', 'dev.disposable=1', '--label', `dev.disposable.owner.pid=${process.pid}`, '--label', `dev.disposable.host=${hostname()}`, '--label', `dev.disposable.started=${Math.floor(Date.now() / 1000)}`, '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', '--env', 'POSTGRES_DB=neutral_store', '--publish', '127.0.0.1::5432', 'postgres:16');
      const endpoint = docker('port', name, '5432/tcp');
      const ownerUrl = `postgresql://postgres@${endpoint}/neutral_store`;
      const owner = new pg.Pool({ connectionString: ownerUrl });
      pools.add(owner);
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          await owner.query('SELECT 1');
          ready = true;
          break;
        }
        catch {
          await delay(100);
        }
      }
      if (!ready)
        throw new Error('starter_database_browser_postgres_unavailable');
      for (const role of ['starter_runtime', 'starter_restore'])
        await owner.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      const selection = { generation: 'qualified-v2', roleMode: 'installer-managed', bootstrapLogin: 'postgres', migrationLogin: 'postgres', runtimeLogin: 'starter_runtime', restoreLogin: 'starter_restore' };
      const migration = new pg.Pool({ connectionString: ownerUrl, options: qualifiedPostgresStartupOptions(selection) });
      pools.add(migration);
      const runner = createPlatformPostgresMigrationRunner({ connectionString: ownerUrl }, { installation: selection, poolFactory: () => migration });
      const runtimeUrl = ownerUrl.replace('postgres@', 'starter_runtime@');
      let legacy;
      if (previousMigrations) {
        const prior = previousMigrations.createPlatformPostgresMigrationRunner({ connectionString: ownerUrl }, { installation: selection, poolFactory: () => migration });
        if (!(await prior.apply()).applied.length) throw new Error('starter_database_browser_predecessor_required');
        const priorRuntime = new pg.Pool({ connectionString: runtimeUrl });
        try {
          legacy = await Promise.all(market.locales.map(async locale =>
            [locale, await seedLegacyCancel(owner, priorRuntime, config.renewal.subscriptionCare.terms)]));
          legacy = Object.fromEntries(legacy);
        } finally { await priorRuntime.end(); }
      }
      const applied = await runner.apply();
      if (previousMigrations && !applied.applied.length) throw new Error('starter_database_browser_upgrade_required');
      if ((await runner.status()).pending.length)
        throw new Error('starter_database_browser_installation_incomplete');
      await owner.query(`COMMENT ON DATABASE neutral_store IS '${demonstrationMarker}'`);
      await applyDemoSeed(config, { connection: owner, installRole: 'postgres', runtimeRole: 'starter_runtime',
        catalogueRules: readStarterCatalogueRules(), close: async () => { } });
      const state = resolve(directory, config.id);
      await mkdir(state, { recursive: true, mode: 0o700 });
      const publicationPasswordFile = resolve(state, 'publication-password');
      await provisionDemonstrationPublicationPassword(owner, publicationPasswordFile);
      const keyring = resolve(state, 'quote-key.json');
      await writeFile(keyring, JSON.stringify({ current: randomBytes(32).toString('base64url') }), { mode: 0o600 });
      if (prepareCatalogueTemplate) {
        for (const pool of [migration, owner]) {
          pools.delete(pool);
          await pool.end();
        }
        const control = new pg.Pool({ connectionString: new URL('/postgres', ownerUrl).href });
        try { await control.query('CREATE DATABASE catalogue_browser_template TEMPLATE neutral_store'); }
        finally { await control.end(); }
      }
      const probe = createServer().listen(0, '127.0.0.1');
      await once(probe, 'listening');
      const address = probe.address();
      if (!address || typeof address === 'string')
        throw new Error('starter_database_browser_port_required');
      const port = address.port;
      await new Promise(done => probe.close(() => done()));
      const host = spawn(process.execPath, ['--experimental-strip-types', resolve(application, 'host/server.ts'),
        '--configuration', config.id, '--port', String(port), '--database-url', runtimeUrl, '--quote-acceptance-key-file', keyring,
        '--catalogue-publication-password-file', publicationPasswordFile], { cwd: state, stdio: ['ignore', 'pipe', 'pipe'] });
      hosts.push(host);
      let logs = '';
      host.stdout?.on('data', value => { logs += value.toString(); });
      host.stderr?.on('data', value => { logs += value.toString(); });
      const baseURL = `http://127.0.0.1:${port}`;
      ready = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        try {
          if ((await fetch(`${baseURL}/api/config`)).ok) {
            ready = true;
            break;
          }
        }
        catch { /* wait for the owned host */ }
        if (host.exitCode !== null)
          break;
        await delay(100);
      }
      await writeFile(resolve(state, 'host.private.log'), logs, { mode: 0o600 });
      if (!ready)
        throw new Error('starter_database_browser_host_unavailable');
      entries.push({ id: config.id, baseURL, runtimeUrl, ownerUrl, state, upgrade, legacy });
    }
    await writeFile(resolve(application, '.context/database-ui-hosts.json'), JSON.stringify(entries.map(({ id, baseURL }) => ({ id, baseURL }))), { mode: 0o600 });
    await writeFile(resolve(directory, 'fixtures.json'), JSON.stringify(entries), { mode: 0o600 });
    await child('npx', ['--no', '--', 'playwright', 'test', '--config', 'playwright.database.config.ts', '--workers', '1', ...argv]);
  }
  finally {
    for (const host of hosts) {
      if (host.exitCode === null && host.signalCode === null) {
        const exit = once(host, 'exit');
        host.kill('SIGTERM');
        await exit;
      }
    }
    for (const pool of pools)
      await pool.end();
    for (const name of containers) {
      try {
        docker('rm', '--force', '--volumes', name);
      }
      catch { /* only this recipe's named containers */ }
    }
  }
}
