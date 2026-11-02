import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const [command, ...args] = process.argv.slice(2);
const packageNames = ['core', 'outbox', 'platform'];

function run(executable, argv, input) {
  execFileSync(executable, argv, { cwd: root,
    stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    ...(input === undefined ? {} : { input }) });
}

function configurationArgument(argv) {
  let configuration;
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] !== '--configuration') throw new Error('starter_argument_unknown');
    if (configuration !== undefined) throw new Error('starter_argument_duplicate');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('starter_argument_value_required');
    configuration = value;
  }
  return configuration;
}

if (command === 'candidate') {
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
    if (manifest.name !== `@openlup/${name}` || !/^0\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)) {
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
} else if (command === 'up') {
  const { selectConfiguration } = await import('./owned/store.config.ts');
  try {
    const config = selectConfiguration(configurationArgument(args));
    run('docker', ['compose', 'build']);
    run('docker', ['compose', 'up', '--wait', 'database']);
    run('docker', ['compose', 'run', '--rm', '--no-deps', 'installation',
      'node', 'lifecycle.mjs', 'install', '--configuration', config.id]);
    // Install and runtime receive the same non-secret configuration through arguments.
    const override = { services: { application: { command: [
      'node', '--experimental-strip-types', 'host/server.ts',
      '--configuration', config.id, '--port', '4319', '--listen', '0.0.0.0',
    ] } } };
    run('docker', ['compose', '-f', 'compose.yaml', '-f', '-', 'up', '--wait', 'application'], JSON.stringify(override));
  } catch (error) {
    const code = error instanceof Error && /^starter_[a-z_]+$/.test(error.message)
      ? error.message : 'starter_installation_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 2;
  }
} else if (command === 'install') {
  // Internal one-shot Compose entry; no install connection reaches the HTTP host.
  const { installDemonstration, bootstrapDemonstration } = await import('./installation/install.ts');
  const { selectConfiguration } = await import('./owned/store.config.ts');
  try {
    await installDemonstration(selectConfiguration(configurationArgument(args)), bootstrapDemonstration);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'starter_installation_failed';
    process.stderr.write(`${code}\n`);
    if (code === 'starter_seed_demonstration_database_required') {
      process.stderr.write('See README.md#reset-an-interrupted-first-install for the local demonstration reset recipe.\n');
    }
    process.exitCode = 2;
  }
  // The installed runner owns its pool; this one-shot process owns its lifetime.
  process.exit(process.exitCode ?? 0);
} else if (command === 'down') {
  // Does not discard the database volume. Destruction is an explicit separate owner action.
  run('docker', ['compose', 'down']);
} else if (command === 'verify') {
  const binary = resolve(root, 'node_modules/.bin/openlup');
  try { await access(binary); }
  catch { throw new Error('starter_installed_verify_unavailable'); }
  run(binary, ['verify', ...args]);
} else if (command === 'upgrade') {
  const binary = resolve(root, 'node_modules/.bin/openlup');
  try { await access(binary); }
  catch { throw new Error('starter_installed_upgrade_unavailable'); }
  run(binary, ['upgrade', ...args]);
} else if (command === 'ownership') {
  process.stdout.write(await readFile(resolve(root, 'ownership.json'), 'utf8'));
} else {
  process.stderr.write('Usage: ./lifecycle candidate <core.tgz> <outbox.tgz> <platform.tgz> | up [--configuration <id>] | down | verify | upgrade <args> | ownership\n');
  process.exitCode = 2;
}
