### Fence legacy dispatch for destination v2

On native installations, legacy provider-command polling skips parcels bound to destination v2.
Fresh enqueue and submission for those parcels return `destination_adapter_unsupported`.
Use the qualified native dispatch workflow for the original order.
Existing command replay and reconciliation remain available. Upgrades require no operator action.
