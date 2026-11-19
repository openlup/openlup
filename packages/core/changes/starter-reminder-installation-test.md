### Starter installation test

Use the target extraction's managed `test/installation.test.ts` when the
predecessor file is pristine. The test checks one idempotent write per setting
with the configured value inside a single install transaction.

For a customized test, move independent local test cases and their imports to
an application-owned test file. Restore the pristine predecessor at the managed
path, then apply the upgrade. Apply and replay keep the local file and use the
exact target bytes for the managed test. Startup refusals retain their existing
behavior.
