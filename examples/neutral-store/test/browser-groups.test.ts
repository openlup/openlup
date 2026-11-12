import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserJourneyGroups, journeySelections } from '../browser-groups.mjs';

function matches(selection: string[], title: string) {
  const pattern = (flag: string) => {
    const index = selection.indexOf(flag);
    return index < 0 ? null : new RegExp(selection[index + 1]!);
  };
  return (pattern('--grep')?.test(title) ?? true) && !(pattern('--grep-invert')?.test(title) ?? false);
}

test('the current care, portal, recovery, operator, returns, guidance, shipments, account preferences and remainder groups partition journey titles', () => {
  for (const title of ['database subscription care pause', 'database subscription care en: portal recovery', 'database subscription care en: recovery extension payment', 'database subscription care en: operator operations refund', 'database subscription care en: returns portal request', 'database subscription care pl: payment guidance refusal', 'database subscription care en: shipment operations label', 'database subscription care pl: account preferences saved selection', 'en: follows T01', 'sandbox purchase']) {
    assert.equal(browserJourneyGroups.filter(group => matches(group, title)).length, 1);
  }
  assert.ok(matches(browserJourneyGroups[0]!, 'database subscription care pause'));
  assert.ok(matches(browserJourneyGroups.at(-1)!, 'sandbox purchase'));
});

test('one additional specific pattern partitions a nested journey without duplicating or losing it', () => {
  const groups = journeySelections(['database subscription care', 'portal ']);
  const titles = ['database subscription care pause', 'database subscription care en: portal recovery', 'sandbox purchase'];
  for (const [index, title] of titles.entries()) {
    assert.deepEqual(groups.map(group => matches(group, title)), titles.map((_, candidate) => candidate === index));
  }
});
