### Move `shipping.rateResolver` to the packaged catalogue and report B1/B2 file values

`shipping.rateResolver` is now a packaged `callback` entry in `@openlup/platform`
rather than a starter `code` declaration. `owned/settings-host.ts` removes its
local `shipping.rateResolver` descriptor and reports file values (without
descriptors) for `subscription_minimum_base_units` and
`subscription_sized_intro_phase`.

Upgrade replaces a pristine `owned/settings-host.ts`. For a customized copy,
remove any local `shipping.rateResolver` descriptor so `settings list` and
`settings check` do not refuse a duplicate packaged key. This change requires
no installed-policy step.
