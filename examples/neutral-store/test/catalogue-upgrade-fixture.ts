import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const declaration = 'owned/catalogue.ts';
const sources = ['pack.ts', 'fixtures.ts'];
const paths = [declaration, ...sources.map(path => 'owned/catalogue/' + path)];

export function catalogueUpgradeFixture(app: string, skeleton?: string): Record<string, string> {
  if (skeleton) {
    const path = join(app, declaration);
    const initial = readFileSync(path, 'utf8');
    const declared = initial.replace('const pack = {', 'const starterPack = {')
      .replace('packs: [{ pack, drafts:', 'packs: [{ pack: starterPack, drafts:')
      .replace('}, skus: [] }] }],', '}, skus: [] }] }, { pack, drafts: fixtures.drafts }],')
      .replace('packs.flatMap(', 'packs.flatMap<CatalogProductTypeInput>(');
    assert.notEqual(declared, initial);
    const directory = join(app, 'owned/catalogue');
    mkdirSync(directory);
    for (const source of sources) cpSync(join(skeleton, source), join(directory, source));
    writeFileSync(path, "import { pack } from './catalogue/pack.ts';\nimport { fixtures } from './catalogue/fixtures.ts';\n" + declared);
  }
  return Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(join(app, path))).digest('hex')]));
}
