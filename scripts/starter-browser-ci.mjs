// Required installed starter journeys; all private command output stays in memory.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { env as processEnvironment } from 'node:process';
import { promisify } from 'node:util';
import pg from 'pg';
import { runPostgresContainer, waitForPostgresTcpReady } from '../tests/helpers/postgresContainer.ts';
import { imageIo, imageReference, pullWithRetry, readCiImage } from './ci-image-pull.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);

export function parseArguments(args) {
  const result = {};
  const names = new Map([['--manifest', 'manifest'], ['--expected-commit', 'commit'], ['--local-image', 'localImage']]);
  for (let index = 0; index < args.length; index += 2) {
    const name = names.get(args[index]), value = args[index + 1];
    if (!name || !value || value.startsWith('--') || result[name] !== undefined) throw new Error('starter_browser_arguments_invalid');
    result[name] = value;
  }
  if (!result.manifest || !/^[a-f0-9]{40}$/u.test(result.commit ?? '')) throw new Error('starter_browser_arguments_invalid');
  if (result.localImage && (processEnvironment.CI || result.localImage !== localBrowserReference())) throw new Error('starter_browser_local_image_forbidden');
  return result;
}

function localBrowserReference() {
  return imageReference(readCiImage('starter-browser'), 'mcr.microsoft.com/playwright');
}

export async function resolveBrowserImage(io = imageIo, localImage) {
  if (localImage) {
    if (processEnvironment.CI || localImage !== localBrowserReference()) throw new Error('starter_browser_local_image_forbidden');
    const digests = JSON.parse(await io.exec(['image', 'inspect', localImage, '--format', '{{json .RepoDigests}}']));
    if (!digests.includes(localImage.replace(/:[^/@]+@/u, '@'))) throw new Error('starter_browser_local_image_pin_required');
    return localImage;
  }
  const image = readCiImage('starter-browser');
  if (image.sources.length !== 1 || image.sources[0] !== 'ghcr.io/openlup/playwright') throw new Error('starter_browser_mirror_required');
  return pullWithRetry(image, io);
}

// Reverse acquisition order, attempting every release even after a cleanup error.
export async function withCleanup(work) {
  const releases = [];
  let failure;
  let value;
  try { value = await work(release => releases.push(release)); } catch (error) { failure = error; }
  for (const release of releases.reverse()) {
    try { await release(); } catch { failure ??= new Error('starter_browser_cleanup_failed'); }
  }
  if (failure) throw failure;
  return value;
}

// An idle node-postgres client or pool emits 'error' when its backend disconnects; without a
// listener Node exits outside withCleanup. Guarded connections record the loss, and the run
// fails after its cleanup, including a loss during cleanup.
export async function withConnectionCleanup(work) {
  const losses = [];
  const recordLoss = code => { losses.push(code); };
  const lost = () => recordLoss('starter_browser_database_connection_lost');
  // A pool drops its own idle listener from a client it lends out, so guard every client it creates.
  const guard = connection => {
    connection.on('error', lost);
    if (connection instanceof pg.Pool) connection.on('connect', client => client.on('error', lost));
    return connection;
  };
  // Helpers create connections too, so an error that no listener handles is recorded for the
  // whole run instead of ending Node before cleanup.
  process.on('uncaughtException', lost);
  let value;
  try { value = await withCleanup(defer => work(defer, guard, recordLoss)); } finally { process.removeListener('uncaughtException', lost); }
  if (losses.length) throw new Error(losses[0]);
  return value;
}

// A successful browser result cannot erase a host loss, even after its last request.
export function watchStarterHost(child, configuration, defer, recordLoss) {
  let exited = false, stopping = false, finish;
  const stopped = new Promise(done => { finish = done; });
  const lost = () => { if (!stopping) recordLoss(`starter_browser_host_${configuration}_exited`); };
  child.once('exit', () => { exited = true; lost(); finish(); });
  child.on('error', () => {
    lost();
    // A failed spawn emits error/close without exit; other errors can leave a live child.
    if (child.pid === undefined) { exited = true; finish(); }
  });
  defer(async () => {
    if (exited) return;
    stopping = true;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await stopped; } finally { clearTimeout(timer); }
  });
  return () => exited;
}

export function scanPrivateOutput(output, privateValues = []) {
  if (privateValues.some(value => value && output.includes(value))
    || /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|postgres(?:ql)?:\/\/|(?:token|quoteAcceptance|cookie|authorization)["']?\s*[:=]\s*["']?\S{16}|(?<![A-Za-z0-9_-])(?:rcv_)?[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-]))/iu.test(output)) {
    throw new Error('starter_browser_private_output_detected');
  }
}

export function capturePrivateValues(message) {
  const record = message.record ?? message;
  const values = ['token', 'rawToken', 'email', 'recipient', 'recoveryUrl', 'completionUrl', 'orderRef']
    .map(key => record[key]).filter(value => typeof value === 'string' && value.length > 0);
  for (const value of [...values]) {
    try {
      const token = new URL(value, 'http://127.0.0.1').searchParams.get('token');
      if (token) values.push(token);
    } catch { /* A contact value is not a URL. */ }
  }
  return values;
}

export async function writeBrowserFixtures(app, entries) {
  const directory = join(app, '.context/care-browser');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'fixtures.json'), JSON.stringify(entries), { mode: 0o600 });
  await writeFile(join(app, '.context/database-ui-hosts.json'),
    JSON.stringify(entries.map(({ id, baseURL }) => ({ id, baseURL }))), { mode: 0o600 });
}

export function browserArguments(app, reference, name, localImage) {
  if (reference !== imageReference(readCiImage('starter-browser')) && (processEnvironment.CI || !localImage || reference !== localBrowserReference())) throw new Error('starter_browser_mirror_required');
  return ['run', '--rm', '--pull=never', '--name', name, '--network=host', '--read-only',
    '--user', `${process.getuid()}:${process.getgid()}`,
    '--tmpfs', '/tmp:rw,nosuid,nodev', '--ipc=host', '-e', 'CI=true', '-e', 'HOME=/tmp',
    '--mount', `type=bind,src=${app},dst=/app,readonly`,
    '--mount', `type=bind,src=${join(app, '.context/care-browser')},dst=/app/.context/care-browser`,
    '--workdir', '/app', reference,
    'node', 'node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.database.config.ts',
    '--workers=1', '--retries=0', '--reporter=dot', '--output=/tmp/test-results'];
}

export async function acquireStarterPostgres(defer, io = { start: runPostgresContainer, ready: waitForPostgresTcpReady }) {
  const password = randomBytes(32).toString('hex');
  // The helper resolves its default test-postgres inventory pin through the shared pull loop.
  const container = await io.start({ name: `starter-browser-postgres-${randomBytes(6).toString('hex')}`, password });
  defer(() => container.remove());
  if (!await io.ready(container.connectionString)) throw new Error('starter_browser_postgres_not_ready');
  return { ...container, password };
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((done, reject) => probe.close(error => error ? reject(error) : done()));
  return port;
}

export async function runStarterBrowser(options) {
  const started = performance.now(), outputs = [], privateValues = [];
  let phase = 'inputs';
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const command = async (file, args, cwd = root, env = processEnvironment) => {
    try {
      const result = await execute(file, args, { cwd, env, timeout: 300_000, maxBuffer: 32 * 1024 * 1024, signal: cancellation.signal });
      outputs.push(result.stdout, result.stderr);
      return result.stdout;
    } catch (error) {
      outputs.push(error.stdout ?? '', error.stderr ?? '');
      if (phase === 'journeys') {
        const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
        const locations = [...new Set(output.match(/\[(?:supplements|coffee)\] › (?:browser\/)?(?:journey|acquisition)\.spec\.ts:\d+:\d+/gu) ?? [])];
        const codes = [...new Set(output.match(/\b(?:starter|acquisition)_[a-z_]+\b/gu) ?? [])];
        const counts = output.match(/\b\d+ (?:passed|skipped|failed|did not run)\b/gu) ?? [];
        console.error(`Starter browser failures: ${locations.join('; ') || 'see selected specs'}; codes: ${codes.join(', ') || 'none'}; counts: ${counts.join(', ') || 'incomplete'}`);
      }
      throw new Error(`starter_browser_${phase}_failed`);
    }
  };
  try {
    await withConnectionCleanup(async (defer, guard, recordLoss) => {
      const { readCurrentPackManifest, assertInstalledPackages } = await import('./packages/pack-manifest-input.ts');
      const commit = (await command('git', ['rev-parse', 'HEAD'])).trim();
      if (options.commit !== commit) throw new Error('starter_browser_candidate_mismatch');
      const packs = readCurrentPackManifest(root, options.manifest, options.commit);
      phase = 'image';
      const image = await resolveBrowserImage(undefined, options.localImage);
      console.log(`Starter browser image: ${image}`);
      console.log(`Starter browser image resolution: ${Math.round(performance.now() - started)} ms`);
      phase = 'application';
      await mkdir(join(root, '.context/scratch'), { recursive: true });
      const scratch = await mkdtemp(join(root, '.context/scratch/starter-browser-'));
      defer(() => rm(scratch, { recursive: true, force: true }));
      const app = join(scratch, 'app');
      defer(async () => {
        // Scan credentials from failed journeys too, before deleting the private fixture.
        for (const state of [app, ...['supplements', 'coffee'].map(id => join(app, '.context/care-browser', id))]) {
          const capture = join(state, '.context/captured-messages');
          try {
            for (const file of await readdir(capture)) {
              const contents = await readFile(join(capture, file), 'utf8');
              for (const line of contents.split('\n').filter(Boolean)) {
                const message = JSON.parse(line);
                privateValues.push(...capturePrivateValues(message));
              }
            }
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      });
      // Hosts and extracted npm commands receive no ambient database or cloud credentials.
      const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'TZ', 'CI']
        .filter(key => processEnvironment[key] !== undefined).map(key => [key, processEnvironment[key]]));
      await command(process.execPath, ['examples/neutral-store/extract.mjs', app], root, env);
      for (const name of ['core', 'outbox', 'platform']) {
        const artifact = packs.get(`@openlup/${name}`);
        if (!artifact) throw new Error('starter_browser_package_missing');
        await copyFile(artifact.path, join(app, 'artifacts', `openlup-${name}.tgz`));
      }
      await command('npm', ['install', '--ignore-scripts', '--legacy-peer-deps', '--prefer-offline', '--no-audit', '--fund=false'], app, env);
      assertInstalledPackages(app, ['@openlup/core', '@openlup/outbox', '@openlup/platform']);
      await command('npm', ['run', 'build'], app, env);
      const installed = createRequire(join(app, 'package.json'));
      const migrations = await import(pathToFileURL(installed.resolve('@openlup/platform/migrations')).href);
      const { applyDemoSeed, demonstrationMarker } = await import(pathToFileURL(join(app, 'installation/install.ts')).href);
      const { selectConfiguration } = await import(pathToFileURL(join(app, 'owned/store.config.ts')).href);
      const suffix = randomBytes(6).toString('hex'), hosts = [];
      await mkdir(join(app, '.context'), { mode: 0o700 });
      for (const configuration of ['supplements', 'coffee']) {
        phase = `postgres_${configuration}`;
        const postgres = await acquireStarterPostgres(defer);
        cancellation.signal.throwIfAborted();
        privateValues.push(postgres.password);
        const bootstrap = guard(new pg.Client({ connectionString: postgres.connectionString, connectionTimeoutMillis: 5000 }));
        defer(() => bootstrap.end());
        await bootstrap.connect();
        const installRole = 'starter_install', runtimeRole = 'starter_runtime', restoreRole = 'starter_restore';
        const password = randomBytes(32).toString('hex');
        privateValues.push(password);
        for (const [role, privileges] of [[installRole, 'INHERIT SUPERUSER'], [runtimeRole, 'NOINHERIT NOSUPERUSER'], [restoreRole, 'NOINHERIT NOSUPERUSER']]) {
          await bootstrap.query(`CREATE ROLE ${role} LOGIN ${privileges} NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
        }
        phase = `install_${configuration}`;
        const database = 'neutral_store';
        await bootstrap.query(`CREATE DATABASE ${database} OWNER ${installRole}`);
        await bootstrap.query(`COMMENT ON DATABASE ${database} IS '${demonstrationMarker}'`);
        const installUrl = `postgresql://${installRole}:${password}@127.0.0.1:${postgres.port}/${database}`;
        const selection = { generation: 'qualified-v2', roleMode: 'installer-managed', bootstrapLogin: 'postgres', migrationLogin: installRole, runtimeLogin: runtimeRole, restoreLogin: restoreRole };
        const migrationPool = guard(new pg.Pool({ connectionString: installUrl,
          options: migrations.qualifiedPostgresStartupOptions(selection), connectionTimeoutMillis: 5000 }));
        defer(() => migrationPool.end());
        const runner = migrations.createPlatformPostgresMigrationRunner({ connectionString: installUrl }, { installation: selection, poolFactory: () => migrationPool });
        const first = await runner.apply(), repeat = await runner.apply(), status = await runner.status();
        if (repeat.applied.length || status.pending.length) throw new Error('starter_browser_migration_replay_failed');
        console.log(`Starter ${configuration} migrations: ${first.applied.length}; repeat: ${repeat.applied.length}; elapsed: ${Math.round(performance.now() - started)} ms`);
        const installer = guard(new pg.Client({ connectionString: installUrl, connectionTimeoutMillis: 5000 }));
        await installer.connect();
        try {
          const seed = { connection: installer, installRole, runtimeRole };
          phase = `seed_${configuration}`;
          await applyDemoSeed(selectConfiguration(configuration), seed);
          await applyDemoSeed(selectConfiguration(configuration), seed);
        } finally { await installer.end(); }
        phase = 'runtime';
        const runtimeUrl = `postgresql://${runtimeRole}@127.0.0.1:${postgres.port}/${database}`;
        const runtime = guard(new pg.Client({ host: '127.0.0.1', port: postgres.port, database, user: runtimeRole, password, connectionTimeoutMillis: 5000 }));
        await runtime.connect();
        try {
          const { rows } = await runtime.query('SELECT session_user,current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
          if (rows[0]?.session_user !== runtimeRole || rows[0]?.current_user !== runtimeRole || rows[0]?.rolsuper !== false || rows[0]?.rolbypassrls !== false) throw new Error('starter_browser_runtime_role_required');
        } finally { await runtime.end(); }
        const key = randomBytes(32).toString('base64url');
        privateValues.push(key);
        const keyFile = join(scratch, `${configuration}-key.json`);
        await writeFile(keyFile, JSON.stringify({ current: key }), { mode: 0o600 });
        const state = join(app, '.context/care-browser', configuration);
        await mkdir(state, { recursive: true, mode: 0o700 });
        const port = await freePort(), baseURL = `http://127.0.0.1:${port}`;
        phase = `host_${configuration}`;
        const child = spawn(process.execPath, ['--experimental-strip-types', join(app, 'host/server.ts'), '--configuration', configuration,
          '--port', String(port), '--listen', '127.0.0.1', '--database-url', runtimeUrl, '--quote-acceptance-key-file', keyFile],
        { cwd: state, env: { ...env, PGPASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
        const exited = watchStarterHost(child, configuration, defer, recordLoss);
        let hostOutput = '';
        for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { hostOutput += String(chunk); outputs.push(String(chunk)); });
        const deadline = performance.now() + 30000;
        let ready = false;
        while (!exited() && performance.now() < deadline) {
          cancellation.signal.throwIfAborted();
          try {
            const response = await fetch(`${baseURL}/api/config`, { signal: AbortSignal.timeout(1000) });
            if (response.ok && (await response.json()).config.id === configuration) { ready = true; break; }
          } catch { /* The host has not bound its loopback socket yet. */ }
          await new Promise(done => setTimeout(done, 100));
        }
        if (!ready) {
          const code = /\b(starter_[a-z_]+|ERR_[A-Z_]+)\b/u.exec(hostOutput)?.[1] ?? 'not_ready';
          throw new Error(`starter_browser_host_${configuration}_${code}`);
        }
        const browserRuntime = new URL(runtimeUrl);
        browserRuntime.password = password;
        hosts.push({ id: configuration, baseURL, ownerUrl: installUrl, runtimeUrl: browserRuntime.href,
          state: `/app/.context/care-browser/${configuration}` });
      }
      await writeBrowserFixtures(app, hosts);
      phase = 'journeys';
      const name = `starter-browser-${suffix}`;
      // Registered before launch: a timed-out Docker client may leave its container running.
      defer(async () => {
        try { await execute('docker', ['rm', '-f', '-v', name], { timeout: 30000 }); }
        catch (error) { if (!/No such container/iu.test(error.stderr ?? '')) throw new Error('starter_browser_container_cleanup_failed'); }
      });
      const output = await command('docker', browserArguments(app, image, name, options.localImage));
      const counts = output.match(/\b\d+ (?:passed|skipped|failed|did not run)\b/gu) ?? [];
      if (!counts.some(count => count.endsWith(' passed'))) throw new Error('starter_browser_results_missing');
      console.log(`Starter database journeys: ${counts.join(', ')}`);

    });
  } catch (error) {
    // Never publish assertion bodies, SQL details, connection strings or child errors.
    const refusal = /qualified PostgreSQL installation refused: ([a-z0-9_]+)/u.exec(error.message)?.[1]
      ?? (/^[A-Z0-9]{5}$/u.test(error.code ?? '') ? `sqlstate_${error.code}` : undefined);
    throw new Error(/^starter_[A-Za-z_]+$/u.test(error.message) ? error.message : `starter_browser_${phase}_failed${refusal ? `_${refusal}` : ''}`);
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    console.log(`Starter browser total: ${Math.round(performance.now() - started)} ms (including cleanup)`);
    try { scanPrivateOutput(outputs.join('\n'), privateValues); }
    catch { throw new Error(`starter_browser_private_output_detected_during_${phase}`); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runStarterBrowser(parseArguments(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
