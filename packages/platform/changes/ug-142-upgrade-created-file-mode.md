- New managed files created by `openlup upgrade apply` are readable by the app user (`0644` subject to the process umask). Replaced files keep their existing mode.

Images built from the working copy where you ran `openlup upgrade apply` may
contain files with mode `0600`. The 1.0.0→1.1.0 upgrade created `shared/policy.ts`
and `test/policy.test.ts`. The 1.1.0→1.2.0 upgrade created `owned/market.config.ts`,
`shared/copy-keys.ts`, `shared/locale-copy.ts`, `shared/locales.ts`,
`test/checkout-recovery-stage.test.ts`, `test/locales.test.ts`, and
`test/subscription-creation.test.ts`. The 1.2.0→1.3.0 upgrade created
`owned/settings-host.ts` when absent. Run `chmod a+r` on those files or rebuild
from a fresh checkout. Committed files already check out with mode `0644`.
