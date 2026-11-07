Add an opt-in sized future-plan editor with complete unchanged-line price
agreements, changed-only quoting, host-owned need/exclusion/catalogue ports,
transactional fact equality and current SKU admission. Explicit accepted consent
binds classic subscriptions atomically; preview and abandonment keep classic.
Direct/reverse binding writes refuse. Renewal uses the stored merged agreements.
Public declarations are additive and require a minor package-set release.
This source preview supplies no sized acquisition, account UI or catalogue
publication-head fence and activates no deployment or release.

Selected catalogue evidence (including document revision/digest, physical size,
exclusions and stock) is retained in the preview ledger and compared by existing
SQL equality. The host rereads and compares it under locks through commit.

Migration: extend `assertCurrentFacts` to lock and compare its selected catalogue
facts argument on the supplied transaction connection. Recreate outstanding
sized previews after upgrading; older previews lack the catalogue evidence.
