import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { starterDiagnostic } from '../shared/refusals.ts';

export const runtimeUrl = 'postgresql://starter_runtime@database:5432/neutral_store';
export const runtimeTarget = '/run/secrets/starter_runtime_password';
export const runtimeReadFailed = 'starter_runtime_credential_read_failed';
export const runtimeAuthFailed = 'starter_runtime_database_auth_failed';
export const runtimeMounted = () => process.env.OPENLUP_STARTER_RUNTIME_CREDENTIAL === '1';

function readCredential(path: string, uid?: number) {
  if (!lstatSync(path).isFile()) throw starterDiagnostic(runtimeReadFailed);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true }), bytes = Buffer.alloc(66);
    if (!stat.isFile() || (stat.mode & 0o7777n) !== 0o444n || stat.size !== 65n
      || (uid !== undefined && stat.uid !== BigInt(uid))) throw starterDiagnostic(runtimeReadFailed);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null);
      if (!read) break;
      size += read;
    }
    const line = bytes.toString('latin1', 0, size);
    if (size !== 65 || !/^[0-9a-f]{64}\n$/u.test(line)) throw starterDiagnostic(runtimeReadFailed);
    return { line, revision: [stat.dev, stat.ino, stat.ctimeNs].join('-') };
  } finally { closeSync(fd); }
}

export function mountedRuntimeLine() {
  try { return readCredential(runtimeTarget).line; }
  catch { throw starterDiagnostic(runtimeReadFailed); }
}

export function runtimeConnectionString(explicit?: string) {
  if (!runtimeMounted()) return explicit;
  const url = new URL(runtimeUrl);
  url.password = mountedRuntimeLine().slice(0, -1);
  if (explicit) {
    const specified = new URL(explicit);
    specified.protocol = 'postgresql:';
    specified.port ||= '5432';
    if (specified.href !== runtimeUrl) throw starterDiagnostic(runtimeAuthFailed);
  }
  return url.href;
}

export async function connectRuntime(client: Pick<import('pg').Client, 'connect'>) {
  try { await client.connect(); }
  catch (error) {
    if (runtimeMounted() && (error as { code?: string }).code === '28P01') throw starterDiagnostic(runtimeAuthFailed);
    throw error;
  }
}

export async function assertRuntimeIdentity(client: Pick<import('pg').Client, 'query'>) {
  const result = await client.query(`SELECT current_database() = 'neutral_store'
    AND session_user = 'starter_runtime' AND current_user = session_user AS allowed`);
  if (result.rows[0]?.allowed !== true) throw starterDiagnostic(runtimeAuthFailed);
}

const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
export function assertRuntimeSourceOutside(source: string, roots: readonly string[]) {
  if (roots.map(root => realpathSync(root)).some(root => within(source, root) || within(root, source)))
    throw starterDiagnostic('starter_runtime_credential_source_invalid');
}

export function prepareRuntimeHandoff(project: string, roots: readonly string[]) {
  try {
    const home = homedir(), uid = process.getuid?.();
    if (!/^[a-z0-9][a-z0-9_-]*$/u.test(project) || realpathSync(home) !== home) throw new Error();
    const parts = ['.local', 'state', 'openlup', 'neutral-store', project];
    const path = join(home, ...parts, 'runtime-password');
    assertRuntimeSourceOutside(path, roots);
    let directory = home;
    for (const [index, part] of parts.entries()) {
      directory = join(directory, part);
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o022)
        || (index >= 2 && (stat.mode & 0o7777) !== 0o700)) throw new Error();
    }
    if (realpathSync(directory) !== directory) throw new Error();
    try { lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const pending = mkdtempSync(join(dirname(path), '.runtime-'));
      try {
        const source = join(pending, 'password');
        writeFileSync(source, randomBytes(32).toString('hex') + '\n', { mode: 0o444 });
        try { linkSync(source, path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      } finally { rmSync(pending, { recursive: true, force: true }); }
    }
    const { revision } = readCredential(path, uid);
    const handoff = mkdtempSync(join(realpathSync(tmpdir()), 'openlup-starter-'));
    const cleanup = () => rmSync(handoff, { recursive: true, force: true });
    try {
      const empty = join(handoff, 'empty');
      writeFileSync(empty, '', { mode: 0o600 });
      return { source: path, cleanup, environment: {
        OPENLUP_STARTER_RUNTIME_SOURCE: path, OPENLUP_STARTER_RUNTIME_REVISION: revision,
        OPENLUP_STARTER_PREFLIGHT_HANDOFF: empty,
      } };
    } catch (error) { cleanup(); throw error; }
  } catch { throw starterDiagnostic('starter_runtime_credential_source_invalid'); }
}
