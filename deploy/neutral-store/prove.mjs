import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { env as processEnvironment } from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const recipeDirectory = dirname(fileURLToPath(import.meta.url));
const imagePattern = /^sha256:[a-f0-9]{64}$/u;
const limitation = 'Image rollback only; no database, data or migration-history preservation is proved.';

export function compareDigests(a, b, restored) {
  if (![a, b, restored].every(value => typeof value === 'string' && imagePattern.test(value))) {
    throw new Error('image_digest_invalid');
  }
  if (a === b) throw new Error('image_change_not_observed');
  if (a !== restored) throw new Error('original_image_not_restored');
  return { a, b, restored, equalToOriginal: true, limitation };
}

export function rollbackDecision(observations) {
  if (!Array.isArray(observations) || observations.length !== 3
    || observations.some((row, index) => row?.phase !== ['A', 'B', 'A-restored'][index]
      || row.healthy !== true)) throw new Error('image_health_or_sequence_invalid');
  return compareDigests(...observations.map(row => row.image));
}

export function parseArguments(args) {
  const [command, ...values] = args;
  if (command === 'digest' && values.length === 3) return { command, values };
  if (command === 'edge' && values.length === 1) return { command, values };
  if (['rollback', 'data-rollback'].includes(command) && values.length === 2) return { command, values };
  throw new Error('usage: prove.mjs digest <A> <B> <restored-A> | edge <checkout> | rollback <prepared-app> <scratch-parent> | data-rollback <prepared-app> <scratch-parent>');
}

/** Conservative source-text check, not a general JavaScript security analyser. */
export function edgeFindings(files) {
  const edgePackage = String.raw`(?:@vercel\/edge(?:\/[^'"]*)?|@edge-runtime\/[^'"]+|(?:@[^/'"]+\/)?edge-runtime(?:\/[^'"]*)?)`;
  const edgeImport = new RegExp(String.raw`(?:^|[;\n])\s*(?:import|export)\s+(?:[^;]*?\sfrom\s*)?['"]${edgePackage}['"]|\b(?:require|import)\s*\(\s*['"]${edgePackage}['"]`, 'u');
  const rules = [
    ['edge-import', edgeImport],
    ['edge-runtime', /\bruntime['"]?\s*(?:=|:)\s*['"]edge['"]/u],
    ['function-config', /\bexport\s+(?:const|let|var)\s+config\s*=\s*\{[^}]*\bruntime['"]?\s*:/su],
    ['function-hook', /\b(?:deployHook|deployHooks|scheduledFunction|scheduledFunctions|scheduleFunction|onDeploy|onSchedule)\s*[(:=]|["'](?:crons|functions|deploy-hooks|scheduled-functions)["']\s*:|[{,]\s*(?:crons|functions)\s*:/u],
  ];
  return files.flatMap(({ path, contents }) => rules.flatMap(([rule, pattern]) => {
    const match = pattern.exec(contents);
    return match ? [{ path, rule, line: contents.slice(0, match.index).split('\n').length }] : [];
  }));
}

function sourceFiles(directory) {
  const ignored = new Set(['.git', '.context', 'node_modules', 'artifacts', 'dist', 'test', 'browser', 'test-results', 'playwright-report']);
  return readdirSync(directory).sort().flatMap(name => {
    if (ignored.has(name) || name.endsWith('.test.mjs') || name.startsWith('.env')) return [];
    const path = join(directory, name);
    const state = lstatSync(path);
    if (state.isSymbolicLink()) throw new Error('edge_scan_symlink_refused: ' + path);
    if (state.isDirectory()) return sourceFiles(path);
    const bytes = readFileSync(path);
    if (bytes.includes(0)) return [];
    return [{ path, contents: bytes.toString('utf8') }];
  });
}

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error('docker_command_failed: ' + args[0] + '\n' + (result.error?.message ?? result.stderr));
  }
  return result.stdout.trim();
}

async function availablePort() {
  const server = createServer();
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const address = server.address();
  const port = address.port;
  await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return port;
}

async function healthy(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(1000) });
      const body = await response.json();
      if (response.status === 200 && body.config?.id && body.artifact?.kind === 'local-candidate') return true;
    } catch { /* The child may still be starting; the bounded deadline remains binding. */ }
    await delay(250);
  }
  throw new Error('configuration_health_failed');
}

async function rollback(prepared, scratchParent) {
  const source = resolve(prepared);
  const parent = resolve(scratchParent);
  // Reject recursive copies and refuse before creating any proof resources.
  const outside = relative(source, parent);
  if (outside !== '..' && !outside.startsWith('..' + sep)) throw new Error('scratch_inside_application_refused');
  for (const file of ['Dockerfile', 'package-lock.json', 'owned/copy.ts', ...['core', 'outbox', 'platform'].map(name => `artifacts/openlup-${name}.tgz`)]) {
    if (!existsSync(join(source, file))) throw new Error('prepared_application_input_missing: ' + file);
  }
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(join(parent, 'image-rollback-'));
  const runId = 'openlup-image-' + randomUUID();
  const label = 'io.openlup.recipe-proof=' + runId;
  const images = new Set();
  const containers = new Set();
  const observations = [];
  const cleanup = () => {
    const errors = [];
    for (const name of containers) {
      try { docker(['rm', '--force', '--volumes', name]); containers.delete(name); }
      catch (error) { errors.push(error.message); }
    }
    for (const image of images) {
      try { docker(['image', 'rm', image]); images.delete(image); }
      catch (error) { errors.push(error.message); }
    }
    rmSync(scratch, { recursive: true, force: true });
    return errors;
  };
  const interrupt = () => {
    const errors = cleanup();
    process.stderr.write('proof_interrupted' + (errors.length ? ': ' + errors.join('\n') : '') + '\n');
    process.exit(130);
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const context = join(scratch, 'application');
    const excluded = new Set(['.git', '.context', 'node_modules', 'dist', 'test-results', 'playwright-report']);
    cpSync(source, context, { recursive: true, filter: path => {
      const name = basename(path);
      if (lstatSync(path).isSymbolicLink()) throw new Error('application_symlink_refused');
      return !excluded.has(name) && !name.startsWith('.env');
    } });
    // The Dockerfile is the starter's unchanged application build, not its Compose/HBA.
    const build = phase => {
      const identityFile = join(scratch, phase + '.image-id');
      docker(['build', '--label', label, '--iidfile', identityFile, context]);
      const image = readFileSync(identityFile, 'utf8').trim();
      if (!imagePattern.test(image)) throw new Error('built_image_digest_invalid');
      images.add(image);
      return image;
    };
    const port = await availablePort();
    const observe = async (phase, image) => {
      const name = runId + '-' + phase.toLowerCase();
      containers.add(name); // Covers a created-but-not-started container on a launch failure.
      docker(['run', '--detach', '--name', name, '--label', label,
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--publish', `127.0.0.1:${port}:${port}`, image,
        'node', '--experimental-strip-types', 'host/server.ts', '--port', String(port), '--listen', '0.0.0.0']);
      const observedImage = docker(['inspect', '--format', '{{.Image}}', name]);
      if (observedImage !== image) throw new Error('running_image_mismatch');
      const observation = { phase, image: observedImage, healthy: await healthy(port), endpoint: `http://127.0.0.1:${port}/api/config` };
      observations.push(observation);
      process.stdout.write(JSON.stringify(observation) + '\n');
      docker(['rm', '--force', '--volumes', name]);
      containers.delete(name);
    };
    const a = build('a');
    await observe('A', a);
    const copyPath = join(context, 'owned/copy.ts');
    const before = readFileSync(copyPath, 'utf8');
    const after = before.replace('Development preview', 'Image rollback candidate B');
    if (after === before) throw new Error('owned_copy_change_missing');
    writeFileSync(copyPath, after);
    const b = build('b');
    await observe('B', b);
    await observe('A-restored', a);
    return { ...rollbackDecision(observations), observations, changedOwnedInput: 'owned/copy.ts' };
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    const cleanupErrors = cleanup();
    if (cleanupErrors.length) throw new Error('proof_cleanup_failed: ' + cleanupErrors.join('\n'));
  }
}

/** Configured authority is sent even when the transport connects to loopback. */
export function hostHeaders(origin) {
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error('public_origin_invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin
    || parsed.username || parsed.password) throw new Error('public_origin_invalid');
  return { Host: parsed.host };
}

export function commandReference(result) {
  const reference = result?.value?.caseRef;
  if (result?.ok !== true || typeof reference !== 'string'
    || !/^acquisition-case:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(reference)) throw new Error('command_reference_invalid');
  return reference;
}

export function replayReference(expected, result) {
  const reference = commandReference(result);
  if (typeof expected !== 'string' || reference !== expected || result.replayed !== true) {
    throw new Error('command_replay_mismatch');
  }
  return reference;
}

export function compareDataSnapshots(original, current, expectedRecords) {
  for (const snapshot of [original, current]) {
    if (!snapshot || !Number.isSafeInteger(snapshot.ledgerCount) || snapshot.ledgerCount < 1
      || typeof snapshot.ledgerHash !== 'string' || !/^[a-f0-9]{64}$/u.test(snapshot.ledgerHash)
      || !Number.isSafeInteger(snapshot.records) || snapshot.records < 0
      || !snapshot.catalogue || Object.keys(snapshot.catalogue).sort().join(',') !== 'priceLists,prices,products,skus'
      || Object.values(snapshot.catalogue).some(value => !Number.isSafeInteger(value) || value < 1)) {
      throw new Error('data_snapshot_invalid');
    }
  }
  if (original.ledgerCount !== current.ledgerCount || original.ledgerHash !== current.ledgerHash) {
    throw new Error('migration_ledger_changed');
  }
  if (!isDeepStrictEqual(original.catalogue, current.catalogue)) throw new Error('catalogue_count_changed');
  if (!Number.isSafeInteger(expectedRecords) || expectedRecords < 0 || current.records !== expectedRecords) {
    throw new Error('record_count_mismatch');
  }
  return true;
}

function httpJson(port, headers, path = '/api/config', payload) {
  return new Promise((accept, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const req = request({ hostname: '127.0.0.1', port, path, agent: false, method: body === undefined ? 'GET' : 'POST',
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body) }) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try { accept({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch { reject(new Error('proof_response_invalid')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('proof_request_timeout')));
    req.end(body);
  });
}

async function dataRollback(prepared, scratchParent) {
  const source = resolve(prepared), parent = resolve(scratchParent);
  const outside = relative(source, parent);
  if (outside !== '..' && !outside.startsWith('..' + sep)) throw new Error('scratch_inside_application_refused');
  for (const file of ['compose.yaml', 'lifecycle.mjs', 'Dockerfile', 'package-lock.json', 'owned/copy.ts',
    'owned/store.config.ts', ...['core', 'outbox', 'platform'].map(name => `artifacts/openlup-${name}.tgz`)]) {
    if (!existsSync(join(source, file))) throw new Error('prepared_application_input_missing: ' + file);
  }
  const contextName = docker(['context', 'show']);
  const contextEndpoint = JSON.parse(docker(['context', 'inspect', contextName]))[0]?.Endpoints?.docker?.Host;
  if (!contextEndpoint?.startsWith('unix://')
    || (processEnvironment.DOCKER_HOST && !processEnvironment.DOCKER_HOST.startsWith('unix://'))) {
    throw new Error('local_docker_context_required');
  }
  const localDocker = args => docker(['--context', contextName, ...args]);
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(join(parent, 'data-rollback-'));
  const project = 'openlup-data-' + randomUUID();
  const labelKey = 'io.openlup.recipe-proof', label = labelKey + '=' + project;
  const application = join(scratch, 'application');
  const overridePath = join(scratch, 'proof.yaml'), runtimePath = join(scratch, 'runtime.json');
  const tags = [project + ':a', project + ':b'];
  const observations = [], commands = [];
  let cleanupStarted = false;
  const compose = args => localDocker(['compose', '--project-name', project, '--project-directory', application,
    '-f', join(application, 'compose.yaml'), '-f', overridePath, '-f', runtimePath, ...args]);
  const cleanup = () => {
    if (cleanupStarted) return [];
    cleanupStarted = true;
    const errors = [];
    try {
      if (existsSync(overridePath) && existsSync(runtimePath)) compose(['down', '--volumes', '--remove-orphans', '--rmi', 'local']);
    } catch (error) { errors.push(error.message); }
    // Labels cover builds that failed after producing an image and containers
    // created before Compose reported success. Never touch a neighboring project.
    for (const [kind, listing, removal] of [
      ['container', ['ps', '-aq'], ['rm', '--force', '--volumes']],
      ['network', ['network', 'ls', '-q'], ['network', 'rm']],
      ['volume', ['volume', 'ls', '-q'], ['volume', 'rm']],
      ['image', ['image', 'ls', '-q'], ['image', 'rm', '--force']],
    ]) {
      try {
        const ids = localDocker([...listing, '--filter', 'label=' + label]).split(/\s+/u).filter(Boolean);
        for (const id of new Set(ids)) localDocker([...removal, id]);
        if (localDocker([...listing, '--filter', 'label=' + label])) errors.push(kind + '_cleanup_incomplete');
      } catch (error) { errors.push(error.message); }
    }
    rmSync(scratch, { recursive: true, force: true });
    return errors;
  };
  const interrupt = () => {
    const errors = cleanup();
    process.stderr.write('proof_interrupted' + (errors.length ? ': ' + errors.join('\n') : '') + '\n');
    process.exit(130);
  };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const excluded = new Set(['.git', '.context', 'node_modules', 'dist', 'test-results', 'playwright-report']);
    cpSync(source, application, { recursive: true, filter: path => {
      if (lstatSync(path).isSymbolicLink()) throw new Error('application_symlink_refused');
      return !excluded.has(basename(path)) && !basename(path).startsWith('.env');
    } });
    const port = await availablePort(), origin = `http://localhost:${port}`;
    const configurationPath = join(application, 'owned/store.config.ts');
    const configuration = readFileSync(configurationPath, 'utf8');
    if (/\bpublicOrigin\s*:/u.test(configuration)) throw new Error('proof_owned_origin_already_set');
    const configured = configuration.replace("id: 'supplements',", `id: 'supplements', publicOrigin: '${origin}',`);
    if (configured === configuration) throw new Error('proof_configuration_missing');
    writeFileSync(configurationPath, configured);
    const { applicationHealthcheck } = await import(pathToFileURL(join(application, 'host/healthcheck.ts')).href);
    const runtime = { services: { application: { command: ['node', '--experimental-strip-types', 'host/server.ts',
      '--configuration', 'supplements', '--port', '4319', '--listen', '0.0.0.0',
      '--database-url', 'postgresql://starter_runtime@database:5432/neutral_store'],
      healthcheck: applicationHealthcheck(origin) } } };
    writeFileSync(runtimePath, JSON.stringify(runtime));
    const selectImage = tag => writeFileSync(overridePath, `services:
  database:
    labels: {${JSON.stringify(labelKey)}: ${JSON.stringify(project)}}
  installation:
    image: ${tag}
    pull_policy: never
    build:
      labels: {${JSON.stringify(labelKey)}: ${JSON.stringify(project)}}
    labels: {${JSON.stringify(labelKey)}: ${JSON.stringify(project)}}
  application:
    image: ${tag}
    pull_policy: never
    build:
      labels: {${JSON.stringify(labelKey)}: ${JSON.stringify(project)}}
    labels: {${JSON.stringify(labelKey)}: ${JSON.stringify(project)}}
    ports: !override
      - "127.0.0.1:${port}:4319"
volumes:
  database:
    labels: {${JSON.stringify(labelKey)}: ${JSON.stringify(project)}}
  installation-socket:
    labels: {${JSON.stringify(labelKey)}: ${JSON.stringify(project)}}
networks:
  default:
    labels: {${JSON.stringify(labelKey)}: ${JSON.stringify(project)}}
`);
    const fingerprint = () => createHash('sha256').update(JSON.stringify(sourceFiles(application)
      .filter(row => relative(application, row.path) !== 'owned/copy.ts')
      .map(row => [relative(application, row.path), createHash('sha256').update(row.contents).digest('hex')]))).digest('hex');
    const frozenInputs = fingerprint();
    const packageInputs = ['package-lock.json', ...['core', 'outbox', 'platform'].map(name => `artifacts/openlup-${name}.tgz`)];
    const packageHashes = () => Object.fromEntries(packageInputs.map(path => [path, createHash('sha256').update(readFileSync(join(application, path))).digest('hex')]));
    const frozenPackages = packageHashes();
    selectImage(tags[0]);
    // Same four operations as lifecycle up; every operation retains the scratch
    // override. Installation itself remains the starter's one-shot lifecycle path.
    compose(['build']);
    compose(['up', '--wait', 'database']);
    compose(['run', '--rm', '--no-deps', 'installation', 'node', 'lifecycle.mjs', 'install', '--configuration', 'supplements']);
    compose(['up', '--wait', '--no-build', 'application']);
    const sql = text => JSON.parse(compose(['exec', '-T', 'database', 'psql', '-X', '-A', '-t',
      '-v', 'ON_ERROR_STOP=1', '-h', '/var/run/postgresql', '-U', 'postgres', '-d', 'neutral_store',
      '-c', 'BEGIN READ ONLY; ' + text + '; COMMIT']).split('\n').filter(row => row.startsWith('{') || row.startsWith('['))[0]);
    const snapshot = () => {
      const rows = sql("SELECT coalesce(json_agg(to_jsonb(m) ORDER BY position), '[]'::json) FROM public.platform_schema_migrations m");
      const counts = sql(`SELECT json_build_object('catalogue', json_build_object(
        'products', (SELECT count(*) FROM public.catalog_products), 'skus', (SELECT count(*) FROM public.catalog_skus),
        'priceLists', (SELECT count(*) FROM public.price_lists), 'prices', (SELECT count(*) FROM public.price_entries)),
        'records', (SELECT count(*) FROM acquisition_private.partner_details))`);
      return { ledgerCount: rows.length, ledgerHash: createHash('sha256').update(JSON.stringify(rows)).digest('hex'), ...counts };
    };
    const observe = async phase => {
      const health = await httpJson(port, hostHeaders(origin));
      if (health.status !== 200 || health.body.config?.publicOrigin !== origin
        || health.body.artifact?.kind !== 'local-candidate') throw new Error('configuration_health_failed');
      const container = compose(['ps', '-q', 'application']);
      const state = JSON.parse(localDocker(['inspect', container]))[0];
      const publication = state?.NetworkSettings?.Ports?.['4319/tcp'];
      if (publication?.length !== 1 || publication[0].HostIp !== '127.0.0.1'
        || publication[0].HostPort !== String(port)) throw new Error('loopback_publication_required');
      const image = state.Image;
      if (!imagePattern.test(image)) throw new Error('running_image_digest_invalid');
      return { phase, image, healthy: true };
    };
    const submit = async (command, replay = false) => {
      const response = await httpJson(port, { ...hostHeaders(origin), Origin: origin,
        'X-Starter-Request': '1', 'Content-Type': 'application/json', 'Idempotency-Key': command.key },
      '/api/actions/partners.submit', command.body);
      if (response.status !== 200) throw new Error('proof_command_failed: ' + JSON.stringify(response));
      return replay ? replayReference(command.reference, response.body) : commandReference(response.body);
    };
    const writeCommand = async number => {
      const key = 'recipe-' + randomUUID();
      const command = { operation: 'partners.submit', key, body: { company: 'Fictional Proof ' + number,
        country: 'ZZ', firstName: 'Demo', lastName: 'Partner', email: `proof-${number}@example.test` } };
      command.reference = await submit(command);
      commands.push(command);
    };
    const database = JSON.parse(localDocker(['inspect', compose(['ps', '-q', 'database'])]))[0];
    if (Object.values(database.NetworkSettings.Ports ?? {}).some(bindings => bindings?.length)) {
      throw new Error('database_publication_refused');
    }
    const initial = snapshot();
    if (initial.records !== 0) throw new Error('proof_database_not_empty');
    const a = await observe('A');
    const refusal = await httpJson(port, { Host: `127.0.0.1:${port}` });
    if (refusal.status !== 403 || refusal.body.code !== 'starter_local_host_required') throw new Error('host_refusal_not_observed');
    await writeCommand(1);
    a.data = snapshot(); compareDataSnapshots(initial, a.data, 1); observations.push(a);
    process.stdout.write(JSON.stringify(a) + '\n');
    const copyPath = join(application, 'owned/copy.ts'), before = readFileSync(copyPath, 'utf8');
    const after = before.replace('Development preview', 'Data rollback candidate B');
    if (after === before) throw new Error('owned_copy_change_missing');
    writeFileSync(copyPath, after);
    if (fingerprint() !== frozenInputs || !isDeepStrictEqual(packageHashes(), frozenPackages)) throw new Error('unchanged_input_mismatch');
    selectImage(tags[1]); compose(['build', 'application']);
    compose(['up', '--wait', '--no-deps', '--no-build', '--force-recreate', 'application']);
    const b = await observe('B');
    await submit(commands[0], true); await writeCommand(2);
    b.data = snapshot(); compareDataSnapshots(a.data, b.data, 2); observations.push(b);
    process.stdout.write(JSON.stringify(b) + '\n');
    selectImage(a.image);
    compose(['up', '--wait', '--no-deps', '--no-build', '--force-recreate', 'application']);
    const restored = await observe('A-restored');
    for (const command of commands) await submit(command, true);
    restored.data = snapshot(); compareDataSnapshots(a.data, restored.data, 2); observations.push(restored);
    process.stdout.write(JSON.stringify(restored) + '\n');
    const { limitation: imageOnlyLimitation, ...identity } = rollbackDecision(observations);
    void imageOnlyLimitation;
    return { ...identity, observations, commands: commands.map(({ body, ...identity }) => { void body; return identity; }),
      origin, refusal: refusal.body.code, frozenInputs, frozenPackages, changedOwnedInput: 'owned/copy.ts',
      limitation: 'Application-image swap over unchanged schema and package inputs, for the two partner records written by this proof only.' };
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    const errors = cleanup();
    if (errors.length) throw new Error('proof_cleanup_failed: ' + errors.join('\n'));
  }
}

export async function main(args) {
  const { command, values } = parseArguments(args);
  if (command === 'digest') return compareDigests(...values);
  if (command === 'edge') {
    const root = resolve(values[0]);
    const files = [...sourceFiles(join(root, 'examples/neutral-store')), ...sourceFiles(recipeDirectory)];
    const findings = edgeFindings(files);
    if (findings.length) throw new Error('edge_check_failed: ' + JSON.stringify(findings));
    return { files: files.length, findings: 0, scope: 'Starter application and recipe source; generated inputs and test instruments excluded.' };
  }
  const lockParent = resolve(recipeDirectory, '../../.context');
  mkdirSync(lockParent, { recursive: true });
  const lock = join(lockParent, 'recipe-proof.lock');
  try { mkdirSync(lock); } catch { throw new Error('recipe_proof_already_running'); }
  const unlock = () => rmSync(lock, { recursive: true, force: true });
  process.once('exit', unlock);
  try { return await (command === 'data-rollback' ? dataRollback(...values) : rollback(...values)); }
  finally { process.removeListener('exit', unlock); unlock(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
