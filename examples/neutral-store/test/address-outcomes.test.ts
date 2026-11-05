import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressOutcomeMessage } from '../client/pages/account.ts';
import { copy } from '../owned/copy.ts';
test('both locales distinguish immediate address application from the next parcel', () => {
  for (const locale of ['en', 'pl'] as const) {
    const immediate = addressOutcomeMessage({ outcome: 'applied' });
    const next = addressOutcomeMessage({ outcome: 'applied_from_next_parcel' });
    assert.equal(immediate, 'addressApplied'); assert.equal(next, 'addressNextParcel');
    assert.notEqual(copy[locale][immediate!], copy[locale][next!]);
    assert.match(copy[locale][next!], locale === 'en' ? /next parcel.*in flight/ : /następnej przesyłki.*w drodze/);
  }
  assert.equal(addressOutcomeMessage({ outcome: 'unknown' }), undefined);
});
