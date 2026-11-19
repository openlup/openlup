import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { inspect } from 'node:util';
import type { CatalogProductTypeInput } from '@openlup/platform/catalog';
import { catalogDraftRegistry } from '../owned/catalogue.ts';

test('the offline catalogue pack matches the authored type metadata', () => {
  const subject = JSON.parse(readFileSync(new URL('../owned/catalogue.json', import.meta.url), 'utf8')) as {
    packs: { pack: { types: Omit<CatalogProductTypeInput, 'validateContent'>[] } }[];
  };
  const types = subject.packs.flatMap(({ pack }) => pack.types);
  const fix = 'owned/catalogue.ts is the authored source: update owned/catalogue.json to match';
  const message = (field: string, authored: unknown, pack: unknown) =>
    `${field} differs\nowned/catalogue.ts: ${inspect(authored, { depth: null })}\n`
    + `owned/catalogue.json: ${inspect(pack, { depth: null })}\n${fix}`;

  assert.ok(types.length, message('types.length', 'at least 1', types.length));
  for (const type of types) {
    const ref = { key: type.key, version: type.version };
    const authored = catalogDraftRegistry.resolve(ref);
    assert.ok(authored, message('type key and version', authored, ref));
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
