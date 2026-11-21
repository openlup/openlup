# Native renewal end-to-end throughput baseline

Status: local synthetic benchmark for [#825](https://github.com/openlup/openlup/issues/825).

Run the benchmark from a source checkout with Node.js, Docker, and the root
dependencies installed (`node scripts/build-packages-incremental.mjs` builds the
workspace packages first). The runner starts and removes its own stock
PostgreSQL 16 container using the repository's `qualified-v2` migration runner
and runtime role (`starter_runtime`). It accepts an output path and dataset
parameters, and gets its database connection from its own container.

```sh
report_dir=$(mktemp -d)
node --import tsx tests/postgres/benchmarks/nativeRenewalThroughput.ts \
  --cycles 10000 --batch-limit 50 --batches 2 --rtt-ms 0,50,200 \
  --output "$report_dir/native-renewal-10000.json"
node --import tsx tests/postgres/benchmarks/nativeRenewalThroughput.ts \
  --cycles 100000 --batch-limit 50 --batches 2 --rtt-ms 0,50,200 \
  --output "$report_dir/native-renewal-100000.json"
```

The [runner](../../../tests/postgres/benchmarks/nativeRenewalThroughput.ts)
seeds `N` active subscriptions with paid activation cycles, orders, shipping
destinations, renewal attachments, renewal terms, and a single stocked SKU,
with `next_cycle_at` distributed evenly across the 24 hours preceding the
benchmark clock (`AS_OF` = 1 hour after the newest due cycle, so initial oldest
backlog age is ~90,000 s). Each scenario runs consecutive batches of
`createNativeSubscriptionBinding().services.run()` with a local in-memory fake
payment rail that simulates `0 ms`, `50 ms`, and `200 ms` provider RTT without
network access.

Before running the batches, the runner instruments
`public.subscription_stock_wait_normal_due(integer, timestamptz)` with
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` (one warm-up discarded, five measured
samples). During batch execution it records selector SQL time, total database
query time (`executor.query` + `withTransaction`), simulated provider RTT,
total batch wall time, drain rate (`cycles/s`), projected full-backlog drain
time, and oldest backlog age before and after each scenario. Keep the JSON
outside the checkout.

The baseline describes synthetic single-worker (`concurrency = 1`) throughput
with local PostgreSQL and a deterministic fake rail. Qualification of a
specific deployment, live provider latency distribution, and multi-worker
contention require separate evidence.

## Measured baseline

Measured on November 21, 2026 UTC against the Native schema at commit
`599efb8d9`. PostgreSQL 16.15 ran in Docker on an ARM64 macOS host (16 CPUs,
Node.js `v24.22.2`) with JIT enabled, `shared_buffers = 16384` (128 MB), and
`work_mem = 4096` (4 MB). Each RTT scenario processed 2 consecutive batches of
50 due renewals (100 settled renewals per scenario, 0 failures, 0 duplicate
dispatches).

### Selector SQL (`subscription_stock_wait_normal_due`)

| Dataset | Median (`ms`) | Max (`ms`) | Planning (`ms`) | Shared hits | Shared reads |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10,000 due cycles | 1.18 | 1.19 | 0.59 | 704 | 0 |
| 100,000 due cycles | 8.71 | 10.02 | 0.62 | 3,117 | 0 |

### End-to-end throughput (`batchLimit = 50`, `concurrency = 1`)

| Dataset | Simulated RTT | Settled | Wall (`ms`) | DB (`ms`, share) | Provider RTT (`ms`, share) | Selector (`ms`) | Drain rate (`cycles/s`) | Projected full backlog |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 0 ms | 100 | 1,911.12 | 1,777.41 (93.0%) | 0.02 (0.0%) | 8.86 | 52.33 | 191 s (~3.2 min) |
| 10,000 | 50 ms | 100 | 8,228.61 | 2,870.17 (34.9%) | 5,176.22 (62.9%) | 14.11 | 12.15 | 823 s (~13.7 min) |
| 10,000 | 200 ms | 100 | 24,111.95 | 3,735.56 (15.5%) | 20,167.85 (83.6%) | 15.28 | 4.15 | 2,411 s (~40.2 min) |
| 100,000 | 0 ms | 100 | 10,705.09 | 10,535.58 (98.4%) | 0.02 (0.0%) | 46.83 | 9.34 | 10,705 s (~3.0 h) |
| 100,000 | 50 ms | 100 | 16,164.98 | 10,801.73 (66.8%) | 5,169.06 (32.0%) | 38.34 | 6.19 | 16,165 s (~4.5 h) |
| 100,000 | 200 ms | 100 | 34,298.74 | 13,847.98 (40.4%) | 20,180.19 (58.8%) | 46.38 | 2.92 | 34,299 s (~9.5 h) |

## Key observations and next steps

1. **Due-lane selector is not the bottleneck:** `subscription_stock_wait_normal_due`
   took `1.18 ms` at 10,000 cycles and `8.71 ms` at 100,000 cycles (`< 0.5%` of
   batch wall time in every scenario). No additional selector index is needed
   based on this baseline.
2. **Provider RTT dominates realistic latencies (GO for bounded concurrency):**
   At `200 ms` RTT, waiting on sequential provider calls accounts for `83.6%` of
   wall time at 10,000 cycles (`4.15 cycles/s`) and `58.8%` at 100,000 cycles
   (`2.92 cycles/s`). At `50 ms` RTT, provider RTT is `62.9%` at 10,000 cycles.
   Adding opt-in bounded `concurrency` (default `1`) to `runRenewalBatchRows`
   and `createNativeSubscriptionBinding` is justified to overlap provider I/O
   within a batch without changing retry ordering or default 1.x behavior.
3. **Per-renewal DB cost grows with table size at 100,000 cycles:** At `0 ms`
   RTT, average DB time per renewal rose from `17.8 ms` at 10,000 cycles to
   `105.4 ms` at 100,000 cycles across ~22 queries per renewal. Follow-up
   profiling of per-renewal SQL lookups (`subscription_activations`,
   `commerce_destinations`, `subscription_renewal_operations`) is a separate
   optimization opportunity beyond bounded concurrency.
