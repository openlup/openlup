For the next 1.x release. Adds explicit `lockMode?: "cluster" | "process"`
(`SchedulerLockMode`) to `createNodeScheduler` (`@openlup/platform/scheduler`)
and `createNodeHost().serveNode` (`@openlup/platform/composition`).
`createNodeHost` now defaults to `lockMode: "cluster"` for `node-cron` bundles,
failing closed unless the resolved `AdvisoryLock` declares
`durability: "cluster"` (such as `createPgAdvisoryLock` or
`createEnvAdvisoryLock`). Direct `createNodeScheduler` callers retain the
`"process"` default for 1.x compatibility and can opt into `lockMode: "cluster"`.

Migration: Hosts using `createPgAdvisoryLock` or `createEnvAdvisoryLock` need
no changes. Custom `AdvisoryLock` implementations passed to `serveNode` on
`node-cron` bundles must declare `durability: "cluster"`, or callers running
intentional single-instance/test hosts may pass `lockMode: "process"`.
