import { market } from '../owned/market.config.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressOutcomeMessage } from '../client/pages/account.ts';
import { copy } from '../owned/copy.ts';
test('configured locales distinguish immediate address application from the next parcel', () => {
  for (const locale of market.locales) {
    const immediate = addressOutcomeMessage({ outcome: 'applied' });
    const next = addressOutcomeMessage({ outcome: 'applied_from_next_parcel' });
    assert.equal(immediate, 'addressApplied'); assert.equal(next, 'addressNextParcel');
    assert.notEqual(copy[locale][immediate!], copy[locale][next!]);
    assert.match(copy[locale][next!], { en: /next parcel.*in flight/, pl: /następnej przesyłki.*w drodze/ }[locale]);
  }
  assert.equal(addressOutcomeMessage({ outcome: 'unknown' }), undefined);
});
