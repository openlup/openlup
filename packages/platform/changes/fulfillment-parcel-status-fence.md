- Fence provider-command enqueue, batch claim and submission against committed parcel cancellation under the parcel row lock. Refusals preserve ledger state and existing live-parcel replay rules; installed function authority is unchanged.

Migration:

Install the complete selected native prefix through `20261110155000_fulfillment_parcel_status_fence.sql`. Cancelled parcels refuse new enqueue and submission with the existing command-fence conflict; claim skips them. Outcome recording and provider behavior are unchanged. Cancellation continues to require its existing in-flight-effect guards.
