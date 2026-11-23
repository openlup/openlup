For the next 1.x release. Adds explicit `lockMode?: "cluster" | "process"`
(`SchedulerLockMode`) to `createNodeScheduler` (`@openlup/platform/scheduler`)
and `createNodeHost().serveNode` (`@openlup/platform/composition`).
Both entry points default to `lockMode: "process"`, preserving 1.x behavior.
Pass `lockMode: "cluster"` to require a session-affine `AdvisoryLock` that
declares `durability: "cluster"` before registering timers.
