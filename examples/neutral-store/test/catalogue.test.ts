import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { inspect } from 'node:util';
import type { CatalogProductTypeInput } from '@openlup/platform/catalog';
import * as catalogue from '../owned/catalogue.ts';

test('the offline catalogue pack matches the authored type metadata', () => {
  const { catalogDraftRegistry, catalogDraftTypes } = catalogue;
  const registryFix = 'Build catalogDraftRegistry from catalogDraftTypes in owned/catalogue.ts.';
  assert.equal(Array.isArray(catalogDraftTypes), true,
    'Export the types array that builds the registry as catalogDraftTypes in owned/catalogue.ts.');
  const subject = JSON.parse(readFileSync(new URL('../owned/catalogue.json', import.meta.url), 'utf8')) as {
    packs: { pack: { types: Omit<CatalogProductTypeInput, 'validateContent'>[] } }[];
  };
  const packTypes = subject.packs.flatMap(({ pack }) => pack.types);
  const reconcile = 'owned/catalogue.ts is the authored source. Put the intended value there first, then make owned/catalogue.json match it.';
  const message = (field: string, authored: unknown, pack: unknown, fix = reconcile) =>
    `${field} differs\nowned/catalogue.ts: ${inspect(authored, { depth: null })}\n`
    + `owned/catalogue.json: ${inspect(pack, { depth: null })}\n${fix}`;

  for (const { key, version } of catalogDraftTypes) {
    assert.ok(packTypes.some(type => type.key === key && type.version === version),
      message('type key and version', { key, version }, undefined, 'Add this type to owned/catalogue.json.'));
  }
  const pairs = packTypes.map(type => {
    const ref = { key: type.key, version: type.version };
    const authored = catalogDraftTypes.find(({ key, version }) => key === ref.key && version === ref.version);
    assert.ok(authored, message('type key and version', undefined, ref,
      'Add this type to owned/catalogue.ts or remove it from owned/catalogue.json.'));
    return { authored, type };
  });
  for (const authored of catalogDraftTypes) {
    const { key, version, validateContent: _authoredValidator, ...authoredMetadata } = authored;
    const registered = catalogDraftRegistry.resolve({ key, version });
    assert.ok(registered, `${key}@${version} is missing from catalogDraftRegistry. ${registryFix}`);
    const { validateContent: _registeredValidator, ...registeredMetadata } = registered;
    assert.deepEqual(registeredMetadata, { key, version, ...authoredMetadata },
      `${key}@${version} registry metadata differs from catalogDraftTypes. ${registryFix}`);
  }
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
