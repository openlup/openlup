### Read-only preview for renewal stock protection

- The experimental `previewSetting` dispatcher and read-only
  `settings__preview` tool report one validation outcome, the
  current installed policy, current availability by SKU, and how a proposed
  horizon can affect new purchases. Existing reservations keep their
  quantities and expiry times. Proposed availability is pending.
- The starter editor reads the installed renewal horizon on each stock read.
  The explicit-horizon reader still requires a horizon that matches the
  installed value.
