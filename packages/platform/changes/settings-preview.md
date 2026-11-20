### Read-only preview for renewal stock protection

- The experimental settings preview command and `settings_preview` tool report one validation outcome, the
  current installed policy, current availability by SKU, and an estimate of
  proposed availability at the same instant and in the same snapshot. Existing
  reservations keep their quantities and expiry times. Apply
  `20261123152000_inventory_new_purchase_stock_preview.sql` for the proposed
  estimate in CLI JSON, MCP, and library results.
- The explicit-horizon reader still requires a horizon that matches the
  installed value.
