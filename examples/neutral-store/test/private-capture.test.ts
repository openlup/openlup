import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateCapture } from '../host/private-capture.ts';

const messageKey = 'subscription-notice:dunning:example';
const record = { kind: 'recovery', body: 'Private rendered content', context: { order: 'example-order' } };
const filename = createHash('sha256').update(messageKey).digest('hex') + '.json';
async function fixture(work: (root: string, mailbox: string) => Promise<void>) {
  const scratch = fileURLToPath(new URL('../.context/', import.meta.url));
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(scratch, 'starter-capture-'));
  try { await work(root, join(root, 'mailbox')); } finally { await rm(root, { recursive: true, force: true }); }
}

test('exclusive durable publication reconciles identical competing writers and process restart', async () => {
  await fixture(async (_root, directory) => {
    const capture = createPrivateCapture(directory);
    assert.equal(await capture.read(messageKey), null);
    await Promise.all(Array.from({ length: 8 }, () => capture.writeOnce(messageKey, record)));
    assert.deepEqual(await readdir(directory), [filename]);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, filename))).mode & 0o777, 0o600);
    const before = await readFile(join(directory, filename));
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
      `import {createPrivateCapture} from ${JSON.stringify(new URL('../host/private-capture.ts', import.meta.url).href)};
       const capture=createPrivateCapture(${JSON.stringify(directory)});
       if (!(await capture.read(${JSON.stringify(messageKey)}))) throw new Error("readback_required");`], { encoding: 'utf8' });
    assert.equal(child.status, 0, 'restart readback must succeed');
    await assert.rejects(capture.writeOnce(messageKey, { ...record, body: 'Changed' }), /starter_private_capture_unavailable/);
    assert.deepEqual(await readFile(join(directory, filename)), before);
    assert.equal((await readdir(directory)).length, 1);
    await rm(join(directory, filename));
    assert.equal(await createPrivateCapture(directory).read(messageKey), null);
  });
});

test('corrupt, changed-key, unsafe permission and symlink artifacts refuse with a neutral code', async () => {
  await fixture(async (root, directory) => {
    const capture = createPrivateCapture(directory);
    await capture.writeOnce(messageKey, record);
    const path = join(directory, filename), bytes = await readFile(path, 'utf8');
    for (const invalid of ['partial', bytes.replace(messageKey, 'different-context')]) {
      await writeFile(path, invalid);
      await assert.rejects(capture.read(messageKey), /starter_private_capture_unavailable/);
    }
    await writeFile(path, bytes);
    await chmod(path, 0o644);
    await assert.rejects(capture.read(messageKey), /starter_private_capture_unavailable/);
    await chmod(path, 0o600);
    await rm(path);
    const target = join(root, 'target');
    await writeFile(target, bytes, { mode: 0o600 });
    await symlink(target, path);
    await assert.rejects(capture.read(messageKey), /starter_private_capture_unavailable/);
    await assert.rejects(capture.writeOnce(messageKey, record), /starter_private_capture_unavailable/);
    await rm(path);
    await chmod(directory, 0o755);
    await assert.rejects(capture.writeOnce(messageKey, record), /starter_private_capture_unavailable/);
    await chmod(directory, 0o700);
  });
});
