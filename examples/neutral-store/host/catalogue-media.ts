import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_MEDIA_LIMITS, type CatalogDraftMediaClaimV3 } from '@openlup/platform/catalog/contracts';
import { starterMediaReferenceSchema } from '../shared/catalogue-presentation.ts';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));

export async function digestStarterMedia(reference: unknown, directory = publicDirectory): Promise<string | false | null> {
  const admitted = starterMediaReferenceSchema.safeParse(reference);
  if (!admitted.success) return false;
  try {
    const root = resolve(await fs.realpath(dirname(directory)), basename(directory));
    if (await fs.realpath(root) !== root) return false;
    const file = await fs.realpath(resolve(root, '.' + admitted.data));
    if (!file.startsWith(root + sep)) return false;
    const current = await fs.lstat(file);
    if (!current.isFile() || current.size > PRODUCT_MEDIA_LIMITS.imageBytes) return false;
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (current.dev !== info.dev || current.ino !== info.ino || await fs.realpath(file) !== file) return false;
      const bytes = Buffer.alloc(PRODUCT_MEDIA_LIMITS.imageBytes + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) return createHash('sha256').update(bytes.subarray(0, offset)).digest('hex');
        offset += bytesRead;
      }
      return false;
    } finally { await handle.close(); }
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' ? false : null;
  }
}

export async function verifyStarterMedia(claim: Pick<CatalogDraftMediaClaimV3, 'mediaRef' | 'revisionDigest'>, directory?: string) {
  const digest = await digestStarterMedia(claim.mediaRef, directory);
  return digest === null ? null : typeof digest === 'string' && digest === claim.revisionDigest;
}
