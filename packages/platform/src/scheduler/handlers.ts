// Direct scheduled-job bindings for self-hosted runtimes.
//
// The Node host mounts every declared `/api/cron/<jobId>` route, so any job can be reached
// through the HTTP compatibility bridge. A direct binding skips that hop: it calls the
// application runtime in-process and records an honest invocation source instead of a
// hosted-cron one. Deployments and domains contribute bindings; this module only merges them.

export type ScheduledInvocationSource = "node_cron" | "scheduler";

export interface ScheduledJobInvocation {
  jobId: string;
  invocationSource: ScheduledInvocationSource;
}

export type ScheduledJobHandler = (invocation: ScheduledJobInvocation) => Promise<void> | void;

export type ScheduledJobHandlerRegistry = Readonly<Partial<Record<string, ScheduledJobHandler>>>;

/** Merge contributed bindings in order; a later contribution replaces an earlier one for the same job. */
export function mergeScheduledJobHandlers(
  ...registries: ReadonlyArray<ScheduledJobHandlerRegistry | undefined>
): ScheduledJobHandlerRegistry {
  return Object.assign({}, ...registries.filter((registry) => registry !== undefined));
}
