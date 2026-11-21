### Declare 15 additional starter settings for discovery and check

`owned/settings-host.ts` now declares 15 existing starter configuration settings
(locale policy, guest contact defaults, return and hold reason subsets, checkout
initial payment window, recovery link policy, wave windows, subscription care
retention/actions/recovered window, renewal recovery and notice locales, sized
editing preferences, graduation cadence, and minimum product payable minor) with
Draft-7 Zod schemas and effect descriptions.

Upgrade replaces a pristine `owned/settings-host.ts`. For a customized copy,
merge the added declarations from the target starter. This change requires no
installed-policy step.
