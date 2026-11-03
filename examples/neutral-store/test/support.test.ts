import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertConfig } from '../shared/config.ts';
import { configurations } from '../owned/store.config.ts';

for (const original of Object.values(configurations)) {
  test(`${original.id}: optional support contact is validated by shared configuration admission`, () => {
    const config = structuredClone(original);
    assert.doesNotThrow(() => assertConfig(config));
    config.supportEmail = 'support@example.test';
    assert.doesNotThrow(() => assertConfig(config));
    for (const value of ['', ' support@example.test', 'support@example.test\n',
      'mailto:support@example.test', '<b>support@example.test</b>', 'support@',
      'support@example.test?body=hello', 'x'.repeat(255) + '@example.test', 42, null]) {
      Object.assign(config, { supportEmail: value });
      assert.throws(() => assertConfig(config), /starter_support_email_invalid/);
    }
  });
}
