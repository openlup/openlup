import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { applyAppUpgrade } from '@openlup/platform/lifecycle';

const predecessorFiles: Readonly<Record<string, readonly string[]>> = {
  'catalogue.ts': [
    '4da487a0c1a5df777a835d895ec97dd8f7f626661ec7610bf5fdcd47841e2acd',
    'cd57f913ea50537884cab0a994325dc449cbdf0349285fe925fd4bff8e0d1c99',
    '24176f6fe5fa5c32e4876e6c4c50defe03e3ff8a33cf8026ece423e2ec36f472',
  ],
  'copy.ts': ['2bb92cdb674151dc1dbef385a1844a471c75e13660b799b55b12948f4efbc29b'],
};

export async function readCatalogueUpgradeDefault(file: string): Promise<string> {
  if (!Object.hasOwn(predecessorFiles, file)) throw new Error('starter_catalogue_upgrade_owned_file_required');
  try { return await readFile(new URL(`./defaults/${file}.txt`, import.meta.url), 'utf8'); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    return readFile(new URL(`../owned/${file}`, import.meta.url), 'utf8');
  }
}

/** Explicit upgrade of released defaults. Customized files require a manual merge. */
export async function upgradeStarterCatalogue(application: string) {
  const root = await realpath(application);
  const owned = join(root, 'owned');
  if (!(await lstat(owned)).isDirectory()) throw new Error('starter_catalogue_upgrade_owned_file_required');
  const from: Record<string, string> = {}, to: Record<string, string> = {};
  for (const [file, hashes] of Object.entries(predecessorFiles)) {
    const path = `owned/${file}`;
    const target = join(root, path);
    if (!(await lstat(target)).isFile()) throw new Error('starter_catalogue_upgrade_owned_file_required');
    const [current, candidate] = await Promise.all([
      readFile(target, 'utf8'), readCatalogueUpgradeDefault(file),
    ]);
    if (current !== candidate && !hashes.includes(createHash('sha256').update(current).digest('hex'))) {
      throw new Error('starter_catalogue_upgrade_manual_merge_required');
    }
    from[path] = current;
    to[path] = candidate;
  }
  const schema = { min: 0, max: 0 };
  return applyAppUpgrade({ root, schemaVersion: 0,
    from: { version: 'starter-catalogue-v1', schema, files: from },
    to: { version: 'starter-catalogue-v2', schema, files: to },
  });
}
