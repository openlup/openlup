import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { applicationHealthcheck } from './host/healthcheck.ts';

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
  const { assertConfig } = await import('./shared/config.ts');
  try {
    const config = selectConfiguration(configurationArgument(args));
    assertConfig(config);
    run('docker', ['compose', 'build']);
    run('docker', ['compose', 'up', '--wait', 'database']);
    run('docker', ['compose', 'run', '--rm', '--no-deps', 'installation',
      'node', 'lifecycle.mjs', 'install', '--configuration', config.id]);
    // Install and runtime receive the same non-secret configuration through arguments.
    const override = { services: { application: { command: [
      'node', '--experimental-strip-types', 'lifecycle.mjs', 'serve-demo',
      '--configuration', config.id, '--port', '4319', '--listen', '0.0.0.0',
      '--database-url', 'postgresql://starter_runtime@database:5432/neutral_store',
    ] } } };
    const healthcheck = applicationHealthcheck(config.publicOrigin);
    if (healthcheck) override.services.application.healthcheck = healthcheck;
    run('docker', ['compose', '-f', 'compose.yaml', '-f', '-', 'up', '--wait', 'application'], JSON.stringify(override));
  } catch (error) {
    const code = error instanceof Error && /^starter_[a-z_]+$/.test(error.message)
      ? error.message : 'starter_installation_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 2;
  }
} else if (command === 'serve-demo') {
  // Internal container entry: private runtime state never enters the image or Compose values.
  try {
    const { parseHostArguments } = await import('./shared/config.ts');
    const { prepareDemonstrationQuoteKey } = await import('./installation/install.ts');
    const { default: pg } = await import('pg');
    const options = parseHostArguments(args);
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
    const code = error instanceof Error && /^starter_[a-z_]+$/.test(error.message)
      ? error.message : 'starter_demo_start_failed';
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
} else if (command === 'browser') {
  await databaseBrowserRecipe(args);
} else if (command === 'checkout-recovery') {
  const { selectConfiguration } = await import('./owned/store.config.ts');
  const { parseHostArguments } = await import('./shared/config.ts');
  const { runCheckoutRecovery } = await import('./host/paid-mail.ts');
  const { default: pg } = await import('pg');
  const options = parseHostArguments(args), config = selectConfiguration(options.configuration);
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
  run(binary, ['verify', ...args]);
} else if (command === 'upgrade') {
  const binary = resolve(root, 'node_modules/.bin/openlup');
  try { await access(binary); }
  catch { throw new Error('starter_installed_upgrade_unavailable'); }
  run(binary, ['upgrade', ...args]);
} else if (command === 'ownership') {
  process.stdout.write(await readFile(resolve(root, 'ownership.json'), 'utf8'));
} else {
  process.stderr.write('Usage: ./lifecycle candidate <core.tgz> <outbox.tgz> <platform.tgz> | up [--configuration <id>] | browser [Playwright selection flags] | care --configuration <id> --database-url <runtime-url> | renewal --configuration <id> --database-url <runtime-url> | down | verify | upgrade <args> | ownership\n');
  process.exitCode = 2;
}

/** Disposable installed-PostgreSQL recipe; never a production or customer database. */
async function databaseBrowserRecipe(argv) {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { randomBytes, randomUUID } = await import('node:crypto');
  const { createServer } = await import('node:net');
  const { hostname } = await import('node:os');
  const { default: pg } = await import('pg');
  const { createPlatformPostgresMigrationRunner, qualifiedPostgresStartupOptions } = await import('@openlup/platform/migrations');
  const { configurations } = await import('./owned/store.config.ts');
  const { applyDemoSeed, demonstrationMarker } = await import('./installation/install.ts');
  const application = root;
  const directory = resolve(application, '.context/care-browser');
  const containers = [], hosts = [], pools = [];
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const delay = (ms) => new Promise(done => setTimeout(done, ms));
  async function child(command, args) {
    const process = spawn(command, args, { cwd: application, stdio: 'inherit' });
    const [code] = await once(process, 'exit');
    if (code !== 0)
      throw new Error('starter_database_browser_command_failed');
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
      pools.push(owner);
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
      pools.push(migration);
      const runner = createPlatformPostgresMigrationRunner({ connectionString: ownerUrl }, { installation: selection, poolFactory: () => migration });
      await runner.apply();
      if ((await runner.status()).pending.length)
        throw new Error('starter_database_browser_installation_incomplete');
      await owner.query(`COMMENT ON DATABASE neutral_store IS '${demonstrationMarker}'`);
      await applyDemoSeed(config, { connection: owner, installRole: 'postgres', runtimeRole: 'starter_runtime', close: async () => { } });
      const runtimeUrl = ownerUrl.replace('postgres@', 'starter_runtime@');
      const state = resolve(directory, config.id);
      await mkdir(state, { recursive: true, mode: 0o700 });
      const keyring = resolve(state, 'quote-key.json');
      await writeFile(keyring, JSON.stringify({ current: randomBytes(32).toString('base64url') }), { mode: 0o600 });
      const probe = createServer().listen(0, '127.0.0.1');
      await once(probe, 'listening');
      const address = probe.address();
      if (!address || typeof address === 'string')
        throw new Error('starter_database_browser_port_required');
      const port = address.port;
      await new Promise(done => probe.close(() => done()));
      const host = spawn(process.execPath, ['--experimental-strip-types', resolve(application, 'host/server.ts'),
        '--configuration', config.id, '--port', String(port), '--database-url', runtimeUrl, '--quote-acceptance-key-file', keyring], { cwd: state, stdio: ['ignore', 'pipe', 'pipe'] });
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
      entries.push({ id: config.id, baseURL, runtimeUrl, ownerUrl, state });
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
