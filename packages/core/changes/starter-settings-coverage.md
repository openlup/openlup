### Find more starter settings by goal

New neutral-store extractions declare payment retry timing, checkout limits,
shipping and tax, subscription care, the displayed returns period, price
rounding, and market settings in `owned/settings-host.ts`. Use the app's
settings script with `list --goal "payment retry"` or `list --goal "flat shipping"`
to find the owned file to edit, then run `check --json` for the selected
configuration.

An upgrade preserves an existing `owned/settings-host.ts`. To add these
settings to an existing app's search, copy the new declarations from the target
starter into your binding and keep your app's values, locations and custom
entries. This step is optional. Existing bindings and app behavior continue to
work without it. The upgrade requires no installed-policy step. If the settings
check refuses after reconciliation, correct the named declaration or startup
validation error and rerun it.
