Breaking change from Platform 1.3.0. When `cron` is supplied on a `node-cron`
bundle, `createNodeHost().serveNode` defaults to `lockMode: "cluster"`.
Startup refuses before registering timers unless the resolved `AdvisoryLock`
declares `durability: "cluster"`.
Direct `createNodeScheduler` calls default to `lockMode: "process"`.

Migration: Supply a session-affine `AdvisoryLock` declaring `durability: "cluster"` as `advisoryLock`, or set `lockMode: "process"` for an intentional single-instance host whose scheduler profile permits it.
