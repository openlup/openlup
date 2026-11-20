### Starter paid receipts and account dates

A pristine upgrade replaces the managed `host/paid-mail.ts`,
`client/pages/account.ts` and `browser/acquisition.spec.ts` with the target
extraction's files. Paid receipts use the order currency's minor-unit exponent.
The account page shows the next cycle date in the market time zone.

If apply refuses because one of those files has local edits, move the edits to
application-owned files, keeping any imports they need. Restore the pristine
predecessor at each modified managed path, then apply again. Apply installs
the target managed files and replay preserves the application-owned files.
