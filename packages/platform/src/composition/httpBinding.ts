// HTTP slot binding for the Node runtime.
//
// Only a bundle whose `http` capability is "node" receives a Node runtime; a hosted bundle keeps
// `http: null` and serves its route table through its own function entrypoint. The scheduled-route
// resolver mounts exactly the jobs the deployment declared, so an undeclared `/api/cron/<id>`
// path stays a 404 and a declared job without an entrypoint fails visibly when called.

import type { HttpRuntimePort } from "@openlup/core/platform-runtime";

import type { EntrypointLoader } from "../http/index.js";
import { createNodeHttpRuntime, type NodeHttpRuntimeOptions } from "../http/index.js";
import type { ScheduledJob } from "../scheduler/index.js";

/** Mount only the scheduled routes declared by the job registry. */
export function createScheduledEntrypointResolver(
  jobs: readonly ScheduledJob[],
  load: (jobId: string) => ReturnType<EntrypointLoader>,
): (jobId: string) => EntrypointLoader | null {
  const declared = new Set(jobs.map((job) => job.jobId));
  return (jobId) => declared.has(jobId) ? () => load(jobId) : null;
}

/** Build the http port for a bundle capability ("node" => Node runtime; else null). */
export function bindNodeHttpPort(
  capability: string,
  options: () => NodeHttpRuntimeOptions,
): HttpRuntimePort | null {
  if (capability !== "node") return null;
  return createNodeHttpRuntime(options());
}
