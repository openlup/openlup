### Starter installation test

Use the target extraction's managed `test/installation.test.ts` when the
predecessor file is pristine. The reminder assertion now checks the setting key
and configured value inside the install transaction, including replay.

For a customized test, reconcile the reminder assertions against the target file.
Keep independent local test cases in an application-owned test file so snapshot
apply and replay can use the exact candidate bytes for the managed test.

Apply the checkout recovery reminder guard migration through your database
migration chain before using the target installer. Valid configuration and
startup drift refusals stay the same. If installation refuses a schedule change
for an open episode, keep the current schedule until the blocking episodes close.
