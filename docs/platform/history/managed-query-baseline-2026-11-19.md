# Managed ATP and OMS query baseline

Status: local synthetic benchmark for [#826](https://github.com/openlup/openlup/issues/826).

Run the benchmark from a source checkout with Node.js, Docker, and the root
dependencies installed. The runner starts and removes its own stock PostgreSQL 17
container with the same managed-compatibility adapter as the repository tests.
It installs the checkout's managed migrations. It accepts an output path and
dataset parameters, and gets its database connection from its own container.

```sh
report_dir=$(mktemp -d)
node --import tsx tests/postgres/benchmarks/managedQueries.ts \
  --rows 10000 --samples 5 --output "$report_dir/managed-10000.json"
node --import tsx tests/postgres/benchmarks/managedQueries.ts \
  --rows 20000 --samples 5 --output "$report_dir/managed-20000.json"
```

The [fixture](../../../tests/postgres/benchmarks/managedQueryData.sql) generates
a year of order history, payment intents, items, a mix of order states, and
scheduled subscriptions for one hot SKU. It represents 70% paid, 10%
withdrawn, and 20% renewal-mode rows, with separate dimensions for timing,
inventory coverage, and active review holds. Two additional draft orders
exercise checkout and renewal allocation. The fixture creates sellable
quantity, safety stock and active, expired, and terminal-cycle holds. Fulfillment
and invoicing projections are empty in this workload. It
temporarily disables the order-item reservation trigger during historical item
seeding so explicit fixture holds determine the distribution. The trigger is
enabled before every measurement. Older orders with recent payment timestamps
exercise the different date predicates for OMS page rows and paid totals.

The benchmark uses the installed functions as `service_role`. It discards one
warm-up, times uninstrumented calls from the local database client, and saves
raw samples and medians. A separate instrumented call records the nested plan
with actual rows, loops and buffer counts for each case. The report includes
server settings and fingerprints of the installed function definitions. To
compare a change, repeat the same sizes, sample counts, and host conditions.
Keep the JSON outside the checkout.

Each contention trial has one real checkout reservation hold its transaction
open. An independent caller attempts checkout or renewal for the same SKU,
and a third connection observes the blocking PID before releasing the holder.
Both transactions roll back. The report separates time to observe the lock
from total caller time. Those timings include polling and local round trips.

The baseline describes managed query behavior for synthetic data. Its timings
serve local diagnosis. Qualification of the managed installation, provider
latency, and production distribution require separate evidence.

## Measured baseline

Measured on November 19, 2026 UTC with the managed migrations from
`9a627035047bbb094c76e7947bb5d7c741866c35`. PostgreSQL 17.11 ran in Docker
on an ARM64 macOS host with JIT enabled, 128 MB of shared buffers and 4 MB of
work memory. Values are median client milliseconds from five samples per case.
The contention rows are single observed trials per size.

| Case | 10,000 historical orders and subscriptions | 20,000 historical orders and subscriptions |
| --- | ---: | ---: |
| Hot-SKU checkout ATP | 31.7 | 108.8 |
| Hot-SKU renewal ATP | 17.2 | 67.9 |
| OMS first page, full history | 2,948.9 | 5,502.0 |
| OMS deep page, full history | 1,779.9 | 6,030.3 |
| OMS first page, last seven days | 245.1 | 296.6 |
| OMS exact order-number search, full history | 862.9 | 1,550.9 |
| OMS exact order-number search, last seven days | 921.0 | 1,591.4 |
| Managed checkout allocation with the observed blocker | 46.0 | 135.5 |
| Managed renewal allocation with the observed blocker | 20.2 | 76.8 |

At 10,000 subscriptions, both checkout soft-demand subplans ran their
correlated cycle lookup 7,501 times. The checkout ATP plan had 78,333 shared
buffer hits. The renewal plan had 39,293. Both managed allocators waited on
the holder's transaction ID and reserved after the rollback. The next
comparison can measure aggregating hold credits once, with equivalent
amounts for both callers and the same stock locking order.

At 20,000 orders, both full-history pages reported 18,002 visible orders
and the same paid totals. Each wrote 1,488 temporary buffers in its
instrumented plan. The recent page listed 358 visible orders. Its paid
summary counted 872 paid orders, including 596 from orders created before the
window. Moving the creation-date predicate into the input shared with paid
totals would change this result. Evaluate date filtering for the page
pipeline with a separate paid-date witness.

The two exact searches touched the same number of shared buffers at each
size, including 127,877 at 20,000. Profile the normalized search and item
lookups before proposing an index or changing ranking. Evaluate keyset
pagination with an explicit review of cursor ordering, page visibility and
the independent summary counts.
