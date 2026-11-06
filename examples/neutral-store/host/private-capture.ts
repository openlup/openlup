import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, link, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export type CaptureValue = null | boolean | number | string | CaptureValue[] | { [key: string]: CaptureValue };
export interface PrivateCapture {
  /** Existing identical bytes are reused; differing bytes are never overwritten. */
  writeOnce(key: string, record: CaptureValue): Promise<void>;
  /** Missing is distinct from corrupt/unreadable. A retry must refuse missing. */
  read(key: string): Promise<CaptureValue | null>;
}

const unavailable = () => new Error('starter_private_capture_unavailable');
function canonical(value: CaptureValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key]!)).join(',') + '}';
  }
  throw unavailable();
}

/** One private message artifact, not a bearer authority or an HTTP mailbox. */
export function createPrivateCapture(directory = resolve('.context/captured-messages')): PrivateCapture {
  function filename(key: string) {
    if (typeof key !== 'string' || !key.trim()) throw unavailable();
    return join(directory, createHash('sha256').update(key).digest('hex') + '.json');
  }
  async function checkDirectory(create: boolean) {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700
      || (process.getuid && info.uid !== process.getuid())) throw unavailable();
  }
  async function syncDirectory() {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function read(key: string): Promise<CaptureValue | null> {
    const path = filename(key);
    try {
      try { await checkDirectory(false); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      let handle;
      try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      try {
        const info = await handle.stat();
        if (!info.isFile() || (info.mode & 0o777) !== 0o600
          || (process.getuid && info.uid !== process.getuid())) throw unavailable();
        const bytes = await handle.readFile('utf8');
        const envelope = JSON.parse(bytes);
        if (Object.keys(envelope).sort().join() !== 'key,record,version'
          || envelope.version !== 1 || envelope.key !== key || envelope.record === null
          || canonical(envelope) + '\n' !== bytes) throw unavailable();
        return envelope.record as CaptureValue;
      } finally { await handle.close(); }
    } catch { throw unavailable(); }
  }
  return {
    read,
    async writeOnce(key, record) {
      let temporary: string | undefined;
      try {
        // null is reserved for absent readback, never a committed message.
        if (record === null) throw unavailable();
        const bytes = canonical({ version: 1, key, record }) + '\n';
        const path = filename(key);
        await checkDirectory(true);
        temporary = join(directory, '.pending-' + randomUUID());
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        try { await link(temporary, path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        await syncDirectory();
        const committed = await read(key);
        if (committed === null || canonical(committed) !== canonical(record)) throw unavailable();
      } catch { throw unavailable(); }
      finally {
        if (temporary) {
          await unlink(temporary).catch(() => {});
        }
      }
    },
  };
}
