import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PRODUCT_MEDIA_LIMITS } from '@openlup/platform/catalog/contracts';
import { digestStarterMedia, verifyStarterMedia } from '../host/catalogue-media.ts';

test('starter media verification binds local regular files to their exact bytes', async context => {
  const scratch = fileURLToPath(new URL('../.context/', import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const fixture = await fs.mkdtemp(join(scratch, 'catalogue-media-'));
  context.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const directory = join(fixture, 'public'), media = join(directory, 'media');
  const bytes = Buffer.alloc(PRODUCT_MEDIA_LIMITS.imageBytes, 7);
  const revisionDigest = createHash('sha256').update(bytes).digest('hex');
  const claim = { mediaRef: '/media/photo.png', revisionDigest };
  await fs.mkdir(media, { recursive: true });
  await fs.writeFile(join(media, 'photo.png'), bytes);
  await fs.writeFile(join(media, 'large.png'), Buffer.concat([bytes, Buffer.of(0)]));
  await fs.writeFile(join(media, 'empty.png'), '');
  execFileSync('mkfifo', [join(media, 'pipe.png')]);
  await fs.mkdir(join(media, 'directory.png'));
  await fs.writeFile(join(fixture, 'outside.png'), bytes);
  await fs.symlink(join(fixture, 'outside.png'), join(media, 'outside.png'));
  await fs.symlink('photo.png', join(media, 'alias.png'));
  const otherPublic = join(fixture, 'other-public');
  await fs.mkdir(otherPublic);
  await fs.symlink(media, join(otherPublic, 'media'));

  assert.equal(await digestStarterMedia(claim.mediaRef, directory), revisionDigest);
  assert.equal(await verifyStarterMedia(claim, directory), true);
  assert.equal(await verifyStarterMedia({ ...claim, mediaRef: '/media/alias.png' }, directory), true);
  assert.equal(await verifyStarterMedia({ ...claim, revisionDigest: '0'.repeat(64) }, directory), false);
  assert.equal(await verifyStarterMedia(claim, otherPublic), false, 'symlinked directory escapes public');
  for (const mediaRef of ['/media/missing.png', '/media/large.png', '/media/empty.png', '/media/pipe.png',
    '/media/PHOTO.PNG', '/Media/photo.png', '/media/directory.png', '/media/outside.png',
    '/media/../outside.png', '/media/%2e%2e%2foutside.png', '/media/%252e%252e%252foutside.png',
    String.raw`/media/..\outside.png`, String.raw`/media\photo.png`, '/media//photo.png', '/media/photo.png\n',
    '../media/photo.png', join(media, 'photo.png'), 'https://example.test/media/photo.png']) {
    assert.equal(await verifyStarterMedia({ ...claim, mediaRef }, directory), false, mediaRef);
  }
  let failure = 'EIO';
  context.mock.method(fs, 'open', async () => { throw Object.assign(new Error('fixture I/O failure'), { code: failure }); });
  for (failure of ['EIO', 'EACCES']) assert.equal(await verifyStarterMedia(claim, directory), null, failure);
});
