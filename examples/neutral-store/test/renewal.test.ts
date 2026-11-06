import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations } from '../owned/store.config.ts';
import { assertRenewalConfig } from '../shared/renewal-config.ts';

for (const config of Object.values(configurations)) {
  test(`${config.id}: renewal values are shared and explicit opt-in`, () => {
    assertRenewalConfig(config.renewal);
    assert.equal(config.renewal.enabled, false);
    const changed = structuredClone(config.renewal);
    changed.enabled = true; changed.batchLimit = 3; changed.cadenceSeconds = 120;
    changed.leaseSeconds = 240; changed.recovery.activeGraceSeconds = 600;
    assertRenewalConfig(changed);
  });
  test(`${config.id}: unsafe renewal values refuse rather than coerce`, () => {
    for (const value of [0, 1, 59, 3601, -1, Infinity, 1.5, 2147483648]) {
      const changed = structuredClone(config.renewal);
      changed.leaseSeconds = value;
      assert.throws(() => assertRenewalConfig(changed), /starter_renewal_configuration_invalid/);
    }
  });
}
