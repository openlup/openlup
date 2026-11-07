- Close recovery and unpaid obligations on explicit pause/cancellation. Add
  confirmed order-now/reactivation commands, trusted lifecycle timing terms and
  structured retention evidence through the existing subscription entries.

Migration: apply the lifecycle-closure forward before selecting these command
bindings. Hosts may provide `lifecycleTerms` and `retentionReasonCodes`; existing
SQL signatures retain their prior timing defaults. Send literal charge-timing
confirmation for order now/reactivation. Stored receipt replays keep their
accepted results; legacy survey strings remain supported.
