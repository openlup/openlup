import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { applyAppUpgrade } from '@openlup/platform/lifecycle';

const predecessorFiles: Readonly<Record<string, readonly string[]>> = {
  'catalogue.ts': [
    '4da487a0c1a5df777a835d895ec97dd8f7f626661ec7610bf5fdcd47841e2acd',
    'cd57f913ea50537884cab0a994325dc449cbdf0349285fe925fd4bff8e0d1c99',
    '24176f6fe5fa5c32e4876e6c4c50defe03e3ff8a33cf8026ece423e2ec36f472',
    'bfa73a7f127aa3bef285c0e1dba159794afcb6ece1ad62b0cc28a2e444842da9',
    '8421b0d2dd07ca03e26d89aa7ef017efc75a51e351d6115fd1bdd1ab38881939',
    'bb6a846ea1d463c5e487a9e1e63d85f0b1fa55d9ddcfe0a661aa66cab5f92eb6',
    '828c6b609246ad374d54391982afaf4d84d67df46a45ec10928b1473887b195a',
  ],
  'copy.ts': ['2bb92cdb674151dc1dbef385a1844a471c75e13660b799b55b12948f4efbc29b'],
};

export const cataloguePackAdditions = [
  'owned/catalog-packs/supplements/catalogue.ts',
  'owned/catalog-packs/supplements/fixtures.ts',
  'owned/catalog-packs/supplements/pack.ts',
  'owned/catalog-packs/supplements/policy.ts',
  'owned/market-packs/market-fictional/tax-table.ts',
] as const;

const packPredecessors: Readonly<Record<string, string>> = {
  'owned/catalog-packs/supplements/catalogue.ts': 'f36609858806b63098311dedc8d520b5f00de1c362bc0ef8cc5ff893373fa6f4',
  'owned/catalog-packs/supplements/fixtures.ts': '7d0db5de09a7e2be77d4416dedd951b5db173f95ee04b052f91985f1f55cf3b4',
};

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

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
    if (current !== candidate && !hashes.includes(digest(current))) {
      throw new Error('starter_catalogue_upgrade_manual_merge_required');
    }
    from[path] = current;
    to[path] = candidate;
  }
  for (const path of cataloguePackAdditions) {
    to[path] = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    const previous = packPredecessors[path];
    if (!previous) continue;
    const target = join(root, path);
    const status = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (status?.isFile()) {
      const current = await readFile(target, 'utf8');
      if (digest(current) === previous) from[path] = current;
    }
  }
  const schema = { min: 0, max: 0 };
  return applyAppUpgrade({ root, schemaVersion: 0,
    from: { version: 'starter-catalogue-v1', schema, files: from },
    to: { version: 'starter-catalogue-v2', schema, files: to },
  });
}
