import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const [command, ...args] = process.argv.slice(2);
const packageNames = ['core', 'outbox', 'platform'];

function run(executable, argv) {
  execFileSync(executable, argv, { cwd: root, stdio: 'inherit', env: process.env });
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
  if (args.length > 0) throw new Error('starter_up_unexpected_arguments');
  try {
    run('docker', ['compose', 'build']);
    run('docker', ['compose', 'up', '--wait', 'database']);
    run('docker', ['compose', 'run', '--rm', '--no-deps', 'installation']);
    run('docker', ['compose', 'up', '--wait', 'application']);
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
    await installDemonstration(selectConfiguration(process.env.STORE_CONFIGURATION || undefined), bootstrapDemonstration);
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
  process.stderr.write('Usage: ./lifecycle candidate <core.tgz> <outbox.tgz> <platform.tgz> | up | down | verify | upgrade <args> | ownership\n');
  process.exitCode = 2;
}
