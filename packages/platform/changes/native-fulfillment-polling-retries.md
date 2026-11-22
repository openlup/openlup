### Retry failed fulfillment polling pages

When an item fails, native fulfillment polling keeps the page for the next
sweep. After three consecutive failures on the same page, polling advances
and records the operator remedy in the failed job run.
