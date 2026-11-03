import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
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
  if (command === 'rollback' && values.length === 2) return { command, values };
  throw new Error('usage: prove.mjs digest <A> <B> <restored-A> | edge <checkout> | rollback <prepared-app> <scratch-parent>');
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
  return rollback(...values);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
