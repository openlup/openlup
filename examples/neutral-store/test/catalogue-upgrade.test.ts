import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cataloguePackAdditions, readCatalogueUpgradeDefault, upgradeStarterCatalogue } from '../installation/catalogue-upgrade.ts';

const releasedCatalogue = `import { createCatalogProductTypeRegistry } from '@openlup/platform/catalog';

/** Fictional authoring type, shared by both configurations; no publication authority. */
export const catalogDraftRegistry = createCatalogProductTypeRegistry([{
  key: 'starter:item', version: 1, dimensions: [],
  units: [{ code: 'starter:each', dimension: 'count', integral: true }],
  netContentUnits: ['starter:each'],
  validateContent: content => content !== null && typeof content === 'object'
    && 'title' in content && typeof content.title === 'string' && content.title.trim()
    ? [] : [{ path: 'title', code: 'title_required' }],
}]);
`;

for (const changed of ['none', 'copy', 'pack'] as const) test(`catalogue owned-file migration ${changed}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'starter-catalogue-upgrade-'));
  try {
    await mkdir(join(root, 'owned'));
    const catalogue = join(root, 'owned/catalogue.ts');
    const copy = join(root, 'owned/copy.ts');
    const other = join(root, 'owned/other.ts');
    const currentCopy = await readCatalogueUpgradeDefault('copy.ts');
    const legacyCopy = currentCopy.replace('Draft payload JSON (ignored only for abandonment)',
      'Draft payload JSON (starter:item version 1; ignored only for abandonment)').replace('JSON wersji roboczej (pomijany tylko przy porzuceniu)',
      'JSON wersji roboczej (starter:item, wersja 1; pomijany tylko przy porzuceniu)');
    await writeFile(catalogue, releasedCatalogue);
    await writeFile(copy, legacyCopy + (changed === 'copy' ? '\n// Application customization\n' : ''));
    const pack = join(root, cataloguePackAdditions[0]);
    if (changed === 'pack') {
      await mkdir(dirname(pack), { recursive: true });
      await writeFile(pack, 'application catalogue');
      await assert.rejects(upgradeStarterCatalogue(root), { name: 'AppUpgradeConflictError' });
      assert.equal(await readFile(pack, 'utf8'), 'application catalogue');
      assert.equal(await readFile(catalogue, 'utf8'), releasedCatalogue);
      assert.equal(await readFile(copy, 'utf8'), legacyCopy);
    }
    await writeFile(other, 'maintained by the application\n');
    if (changed === 'copy') {
      await assert.rejects(upgradeStarterCatalogue(root), { message: 'starter_catalogue_upgrade_manual_merge_required' });
      assert.equal(await readFile(catalogue, 'utf8'), releasedCatalogue);
      assert.equal(await readFile(copy, 'utf8'), legacyCopy + '\n// Application customization\n');
    } else if (changed === 'none') {
      assert.deepEqual((await upgradeStarterCatalogue(root)).applied, [...cataloguePackAdditions, 'owned/catalogue.ts', 'owned/copy.ts'].sort());
      for (const path of cataloguePackAdditions) {
        assert.equal(await readFile(join(root, path), 'utf8'), await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
      }
      assert.equal(await readFile(catalogue, 'utf8'), await readCatalogueUpgradeDefault('catalogue.ts'));
      assert.equal(await readFile(copy, 'utf8'), currentCopy);
      assert.deepEqual((await upgradeStarterCatalogue(root)).applied, []);
    }
    assert.equal(await readFile(other, 'utf8'), 'maintained by the application\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
