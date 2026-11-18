import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertChoice, choice } from '../shared/policy.ts';

test('text choices preserve the owned order and default within the vocabulary', () => {
  const value = choice('pause', 'skip', 'pause');
  assert.deepEqual(value, { allowed: ['skip', 'pause'], default: 'pause' });
  assert.doesNotThrow(() => assertChoice(value, ['skip', 'reschedule', 'pause'], 'named_policy_error'));
});
test('empty, duplicate, unknown and default-outside-allowed choices refuse with the supplied code', () => {
  for (const value of [choice('pause'), choice('pause', 'pause', 'pause'),
    choice('pause', 'pause', 'discount'), choice('pause', 'skip')]) {
    assert.throws(() => assertChoice(value, ['skip', 'reschedule', 'pause'], 'named_policy_error'), { message: 'named_policy_error' });
  }
});
