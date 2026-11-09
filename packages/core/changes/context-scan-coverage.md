Report bounded declaration and opt-in source scan coverage in `openlup-context` JSON, and show a notice when a scan reaches its file budget.

Migration: JSON consumers may receive an additive top-level `scans` array. Its conservative `limitReached` indicates the budget was reached, not that another eligible file exists; filters and other bounds still apply.
