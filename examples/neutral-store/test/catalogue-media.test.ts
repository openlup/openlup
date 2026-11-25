import assert from 'node:assert/strict';
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
  await fs.mkdir(join(media, 'directory.png'));
  await fs.writeFile(join(fixture, 'outside.png'), bytes);
  await fs.symlink(join(fixture, 'outside.png'), join(media, 'outside.png'));
  await fs.symlink('photo.png', join(media, 'alias.png'));

  assert.equal(await digestStarterMedia(claim.mediaRef, directory), revisionDigest);
  assert.equal(await verifyStarterMedia(claim, directory), true);
  assert.equal(await verifyStarterMedia({ ...claim, mediaRef: '/media/alias.png' }, directory), true);
  assert.equal(await verifyStarterMedia({ ...claim, revisionDigest: '0'.repeat(64) }, directory), false);
  for (const mediaRef of ['/media/missing.png', '/media/large.png', '/media/directory.png', '/media/outside.png',
    '/media/../outside.png', '/media/%2e%2e%2foutside.png', '/media//photo.png', '/media/photo.png\n',
    '../media/photo.png', join(media, 'photo.png'), 'https://example.test/media/photo.png']) {
    assert.equal(await verifyStarterMedia({ ...claim, mediaRef }, directory), false, mediaRef);
  }
  context.mock.method(fs, 'open', async () => { throw Object.assign(new Error('fixture I/O failure'), { code: 'EIO' }); });
  assert.equal(await verifyStarterMedia(claim, directory), null);
});
