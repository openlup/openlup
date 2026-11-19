import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { inspect } from 'node:util';
import type { CatalogProductTypeInput } from '@openlup/platform/catalog';
import { catalogDraftRegistry, catalogDraftTypeRefs } from '../owned/catalogue.ts';

test('the offline catalogue pack matches the authored type metadata', () => {
  const subject = JSON.parse(readFileSync(new URL('../owned/catalogue.json', import.meta.url), 'utf8')) as {
    packs: { pack: { types: Omit<CatalogProductTypeInput, 'validateContent'>[] } }[];
  };
  const types = subject.packs.flatMap(({ pack }) => pack.types);
  const reconcile = 'owned/catalogue.ts is the authored source. Put the intended value there first, then make owned/catalogue.json match it.';
  const message = (field: string, authored: unknown, pack: unknown, fix = reconcile) =>
    `${field} differs\nowned/catalogue.ts: ${inspect(authored, { depth: null })}\n`
    + `owned/catalogue.json: ${inspect(pack, { depth: null })}\n${fix}`;

  for (const ref of catalogDraftTypeRefs) {
    assert.ok(types.some(({ key, version }) => key === ref.key && version === ref.version),
      message('type key and version', ref, undefined, 'Add this type to owned/catalogue.json.'));
  }
  const pairs = types.map(type => {
    const ref = { key: type.key, version: type.version };
    const authored = catalogDraftRegistry.resolve(ref);
    assert.ok(authored, message('type key and version', undefined, ref,
      'Add this type to owned/catalogue.ts or remove it from owned/catalogue.json.'));
    return { authored, type };
  });
  for (const { authored, type } of pairs) {
    const prefix = `${authored.key}@${authored.version}`;
    for (const field of ['key', 'version', 'netContentUnits', 'dimensions'] as const) {
      assert.deepEqual(authored[field], type[field], message(`${prefix}.${field}`, authored[field], type[field]));
    }
    const authoredCodes = authored.units.map(({ code }) => code);
    const packCodes = type.units.map(({ code }) => code);
    assert.deepEqual(authoredCodes, packCodes, message(`${prefix}.units codes`, authoredCodes, packCodes));
    for (const [index, unit] of authored.units.entries()) {
      const packUnit = type.units[index]!;
      for (const field of ['dimension', 'integral', 'factor'] as const) {
        assert.deepEqual(unit[field], packUnit[field], message(`${prefix}.units[${unit.code}].${field}`, unit[field], packUnit[field]));
      }
    }
  }
});
