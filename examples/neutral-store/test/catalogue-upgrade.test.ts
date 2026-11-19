import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCatalogueUpgradeDefault, upgradeStarterCatalogue } from '../installation/catalogue-upgrade.ts';

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

const previousCatalogue = `import type { CatalogProductTypeInput } from '@openlup/platform/catalog';
import type { CatalogPackInput } from '@openlup/platform/catalog/contracts';
import { createStarterCatalogueRegistry } from '../host/catalogue-registry.ts';
import { configurations, defaultConfigurationId } from './store.config.ts';

const validateContent: CatalogProductTypeInput['validateContent'] = content => content !== null && typeof content === 'object'
  && 'title' in content && typeof content.title === 'string' && content.title.trim()
  ? [] : [{ path: 'title', code: 'title_required' }];
const validatorRef = 'sha256:3833a12b67f874c6d23ef91ffd9924b6141d3aa03b96363bc7ca63aa290d2230';
const legacyType: CatalogProductTypeInput = {
  key: 'starter:item', version: 1, dimensions: [],
  units: [{ code: 'starter:each', dimension: 'count', integral: true }], netContentUnits: ['starter:each'],
  validatorRef, validateContent,
};
const draftType: CatalogProductTypeInput = {
  key: legacyType.key, version: 2, dimensions: [],
  units: [{ code: 'openlup:g', dimension: 'mass', integral: false }], netContentUnits: ['openlup:g'],
  validatorRef, validateContent,
};
const demonstrationPack: CatalogPackInput = {
  id: 'starter:demonstration', namespace: 'starter', version: 1, openlupRange: '0.43.x',
  capabilities: { publish: false }, types: [legacyType, draftType], taxClasses: [],
};

export const starterCatalogue = createStarterCatalogueRegistry([
  { get configuration() { return configurations.supplements!; }, pack: demonstrationPack, draftType, offerVersion: 'classic' },
  { get configuration() { return configurations.coffee!; }, pack: demonstrationPack, draftType, offerVersion: 'classic' },
], defaultConfigurationId);
`;

for (const trial of ['released defaults', 'previous registration', 'customization'] as const) test(`catalogue owned-file migration: ${trial}`, async () => {
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
    await writeFile(catalogue, trial === 'previous registration' ? previousCatalogue : releasedCatalogue);
    await writeFile(copy, trial === 'previous registration' ? currentCopy : legacyCopy + (trial === 'customization' ? '\n// Application customization\n' : ''));
    await writeFile(other, 'maintained by the application\n');
    if (trial === 'customization') {
      await assert.rejects(upgradeStarterCatalogue(root), { message: 'starter_catalogue_upgrade_manual_merge_required' });
      assert.equal(await readFile(catalogue, 'utf8'), releasedCatalogue);
      assert.equal(await readFile(copy, 'utf8'), legacyCopy + '\n// Application customization\n');
    } else {
      assert.deepEqual((await upgradeStarterCatalogue(root)).applied,
        trial === 'previous registration' ? ['owned/catalogue.ts'] : ['owned/catalogue.ts', 'owned/copy.ts']);
      assert.equal(await readFile(catalogue, 'utf8'), await readCatalogueUpgradeDefault('catalogue.ts'));
      assert.equal(await readFile(copy, 'utf8'), currentCopy);
      assert.deepEqual((await upgradeStarterCatalogue(root)).applied, []);
    }
    assert.equal(await readFile(other, 'utf8'), 'maintained by the application\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
