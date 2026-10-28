// Node (self-hosted) host bootstrap.
//
// Boots a Node platform bundle: prepare the host, check the bundle's readiness, apply the
// node-postgres migration replay before serving, admit the host, build the HTTP runtime, register
// the declared jobs with node-cron, and listen. A bundle whose migrations are managed outside the
// process (node-supabase) is expected to be migrated before the container starts.
//
// The deployment supplies its composition root, HTTP runtime options, job registry, direct job
// bindings and host admission; this module owns the order and the failure modes.

import { resolve } from "node:path";

import type { HttpRuntimePort, JobLeasePort } from "@openlup/core/platform-runtime";

import { createDistStaticReader } from "../http/index.js";
import type { StaticAssetReader } from "../http/index.js";
import {
  createEnvAdvisoryLock,
  createNodeScheduler,
  mergeScheduledJobHandlers,
  runScheduledJob,
  type AdvisoryLock,
  type CronScheduler,
  type NodeSchedulerAdapter,
  type ScheduledJob,
  type ScheduledJobDeclaration,
  type ScheduledJobHandler,
  type ScheduledJobHandlerRegistry,
} from "../scheduler/index.js";
import type { ComposeBundle, PlatformBundlePorts } from "./composeBundle.js";

type Env = Record<string, string | undefined>;

/** What the host hands its admission check before it serves or schedules anything. */
export interface NodeHostAdmission {
  kind: "node";
  nodeJobHandlers: ScheduledJobHandlerRegistry;
  /** The path-declared jobs this process will time; empty when it does not run the scheduler. */
  nodeJobs: readonly ScheduledJobDeclaration[];
  /** The registry jobs this process will run directly; empty when it does not run the scheduler. */
  scheduledJobs: readonly ScheduledJob[];
}

export interface NodeHostDependencies {
  /** The deployment's composition root (see `createBundleComposer`). */
  composeBundle: ComposeBundle;
  /**
   * Build the HTTP runtime this host serves, for the declared jobs and its static reader. The
   * bundle's `http` port only proves that the bundle is a Node bundle at readiness time.
   */
  createHttpRuntime: (input: {
    schedulerJobs: readonly ScheduledJobDeclaration[];
    staticReader: StaticAssetReader;
    /** The composed ports (blob storage, data gateway and the rest) for routes to use. */
    ports: PlatformBundlePorts;
  }) => HttpRuntimePort;
  /** The deployment's declared jobs, used when the caller passes none. */
  loadSchedulerJobs: () => readonly ScheduledJobDeclaration[];
  /** Transport-neutral jobs contributed to the registry; run in-process with no HTTP secret. */
  scheduledJobs?: (env: Env, ports: PlatformBundlePorts) => readonly ScheduledJob[];
  /** The job-lease port for registry jobs that declare a lease. */
  jobLease?: (env: Env) => JobLeasePort;
  /** Direct bindings the deployment and its domains contribute; caller overrides win. */
  scheduledJobHandlers?: (env: Env) => ScheduledJobHandlerRegistry;
  /** Runs first, before readiness (for example, process-wide configuration checks). */
  prepareHost?: (env: Env) => void;
  /** Admits the host before it serves or schedules; a rejection stops the boot. */
  admitHost?: (env: Env, admission: NodeHostAdmission) => Promise<void>;
  /** Operational log sink (defaults to console.log). */
  log?: (message: string) => void;
}

/**
 * A deployment's scheduler profile: a fenced projection of the declared jobs with its own
 * validation, applied at the host's boot boundaries. Each hook may throw to stop the boot.
 */
export interface NodeSchedulerProfile {
  /** Replaces the declared jobs with this profile's projection. Runs after any migration replay. */
  projectJobs(env: Env, jobs: readonly ScheduledJobDeclaration[]): readonly ScheduledJobDeclaration[];
  /** Direct bindings the profile adds; they replace the deployment's and the caller's for a job. */
  handlers?(env: Env): ScheduledJobHandlerRegistry;
  /** Runs once the advisory lock is resolved and before any job is registered. */
  validateSchedule?(input: {
    lock: AdvisoryLock | undefined;
    jobs: readonly ScheduledJobDeclaration[];
    overrides: ScheduledJobHandlerRegistry | undefined;
  }): void;
  /**
   * Runs for each job, in order, immediately before it is registered, with its direct binding if
   * any. A refusal stops the boot; jobs registered before it keep their timers, as the boot fails.
   */
  validateJob?(job: ScheduledJobDeclaration, directHandler: ScheduledJobHandler | undefined): void;
}

export interface ServeNodeOptions {
  /** The process environment of this host. */
  env: Env;
  /** dist/ root for static serving (defaults to <cwd>/dist). */
  distDir?: string;
  /** node-cron instance; injected so the dependency stays optional for typecheck and tests. */
  cron?: CronScheduler;
  /** Direct bindings added over the deployment's own for this boot. */
  scheduledJobHandlers?: ScheduledJobHandlerRegistry;
  /** Explicit scheduler projection; production uses the deployment's job registry. */
  schedulerJobs?: readonly ScheduledJobDeclaration[];
  /** Optional scheduler profile applied to the declared jobs (see `NodeSchedulerProfile`). */
  schedulerProfile?: NodeSchedulerProfile;
  /**
   * Per-job cluster mutex. Defaults to the one the environment's connection string describes, so a
   * host that runs more than one instance stops executing every timer once per instance.
   */
  advisoryLock?: AdvisoryLock;
  /** Skip binding the network listener (unit tests build the runtime without opening a socket). */
  listen?: boolean;
  port?: number;
  host?: string;
}

export interface ServeNodeResult {
  bundleId: string;
  httpRuntime: HttpRuntimePort;
  registeredJobs: string[];
  /** Fence timers, drain admitted jobs, then close the local listener and lock session. Safe to call repeatedly. */
  stop(): Promise<void>;
}

export interface NodeHost {
  /** Readiness gate: the active bundle's descriptor decides, and the bundle must bind a Node runtime. */
  assertBundleReady(env: Env): { bundleId: string };
  /** Build (and optionally start) the Node host. */
  serveNode(options: ServeNodeOptions): Promise<ServeNodeResult>;
}

export function createNodeHost(deps: NodeHostDependencies): NodeHost {
  const log = deps.log ?? ((message: string) => console.log(message));

  function assertBundleReady(env: Env): { bundleId: string } {
    const bundle = deps.composeBundle(env);
    const readiness = bundle.descriptor.readReadiness(env);
    if (!readiness.ok) {
      throw new Error(`[serve.node] bundle "${bundle.id}" not ready: ${readiness.error}`);
    }
    if (!bundle.ports.http) {
      throw new Error(`[serve.node] bundle "${bundle.id}" has no http runtime (expected node bundle)`);
    }
    return { bundleId: bundle.id };
  }

  async function serveNode(options: ServeNodeOptions): Promise<ServeNodeResult> {
    const env = options.env;
    deps.prepareHost?.(env);
    const { bundleId } = assertBundleReady(env);

    // Deploy parity (migrate -> health -> serve): the node-postgres bundle has no external migration
    // step, so it applies the composed MigrationRunnerPort BEFORE serving. Gated on the data
    // capability so managed-schema bundles are untouched. A listening node-postgres process has no
    // bypass: unit tests that need no database use the non-listening seam.
    const bundle = deps.composeBundle(env);
    const shouldMigrate =
      options.listen !== false &&
      bundle.descriptor.capabilities.data === "postgres" &&
      bundle.ports.migrations !== null;
    if (shouldMigrate) {
      const { applied } = await bundle.ports.migrations!.apply();
      log(`[serve.node] bundle=${bundleId} applied ${applied.length} migration(s) before serve`);
    }

    const distDir = options.distDir ?? resolve(process.cwd(), "dist");
    const staticReader = createDistStaticReader(distDir);
    const declaredSchedulerJobs = options.schedulerJobs ?? deps.loadSchedulerJobs();
    const profile = options.schedulerProfile;
    const schedulerJobs = profile ? profile.projectJobs(env, declaredSchedulerJobs) : declaredSchedulerJobs;

    const handlers = mergeScheduledJobHandlers(
      deps.scheduledJobHandlers?.(env),
      options.scheduledJobHandlers,
      profile?.handlers?.(env),
    );
    const registryJobs = deps.scheduledJobs?.(env, bundle.ports) ?? [];
    for (const job of registryJobs) {
      if (schedulerJobs.some((declared) => declared.jobId === job.id)) {
        throw new Error(`scheduled_job_declared_twice:${job.id}`);
      }
    }
    if (deps.admitHost && (options.listen !== false || options.cron)) {
      await deps.admitHost(env, {
        kind: "node",
        nodeJobHandlers: handlers,
        nodeJobs: options.cron ? schedulerJobs : [],
        scheduledJobs: options.cron ? registryJobs : [],
      });
    }

    const httpRuntime = deps.createHttpRuntime({ schedulerJobs, staticReader, ports: bundle.ports });

    // Node cron invokes a direct binding where one exists. Every other job takes the HTTP
    // compatibility bridge to its own entrypoint, which the runtime mounts from the same registry,
    // so a routing miss cannot masquerade as a scheduler failure and a job without an entrypoint
    // fails visibly. The scheduler holds the cluster mutex: without it every instance of a
    // horizontally scaled host fires the same timer in the same minute.
    const registeredJobs: string[] = [];
    let scheduler: NodeSchedulerAdapter | null = null;
    let schedulerLock: AdvisoryLock | undefined;
    if (options.cron) {
      schedulerLock = options.advisoryLock ?? createEnvAdvisoryLock(env) ?? undefined;
      scheduler = createNodeScheduler({
        cron: options.cron,
        env,
        jobs: schedulerJobs,
        lock: schedulerLock,
      });
      profile?.validateSchedule?.({
        lock: schedulerLock,
        jobs: scheduler.jobs,
        overrides: options.scheduledJobHandlers,
      });
      const baseUrl = env.APP_BASE_URL ?? "http://localhost:3000";
      const cronSecret = env.CRON_SECRET ?? "";
      for (const job of scheduler.jobs) {
        const directHandler = handlers[job.jobId];
        profile?.validateJob?.(job, directHandler);
        scheduler.register({
          jobId: job.jobId,
          schedule: job.schedule,
          handler: async () => {
            if (directHandler) {
              await directHandler({ jobId: job.jobId, invocationSource: "node_cron" });
              return;
            }
            const response = await fetch(new URL(job.path, baseUrl).toString(), {
              method: "GET",
              headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {},
            });
            if (!response.ok) {
              throw new Error(
                `node scheduler compatibility bridge for "${job.jobId}" returned HTTP ${response.status}`,
              );
            }
          },
        });
        registeredJobs.push(job.jobId);
      }
      const lease = registryJobs.some((job) => job.lease) ? deps.jobLease?.(env) : undefined;
      for (const job of registryJobs) {
        scheduler.register({
          jobId: job.id,
          schedule: job.schedule,
          handler: async () => {
            await runScheduledJob(job, { invocation: { triggerKind: "scheduler", invocationSource: "node_cron" }, lease });
          },
        });
        registeredJobs.push(job.id);
      }
    }

    if (options.listen !== false) {
      const port = options.port ?? Number(env.PORT ?? 3000);
      await httpRuntime.listen?.({ port, host: options.host ?? "0.0.0.0" });
      log(`[serve.node] bundle=${bundleId} listening on :${port} (${registeredJobs.length} cron jobs)`);
    }

    let stopPromise: Promise<void> | null = null;
    return {
      bundleId,
      httpRuntime,
      registeredJobs,
      stop: () => (stopPromise ??= stopNodeHost(scheduler, schedulerLock, httpRuntime)),
    };
  }

  return { assertBundleReady, serveNode };
}

async function stopNodeHost(
  scheduler: NodeSchedulerAdapter | null,
  advisoryLock: AdvisoryLock | undefined,
  httpRuntime: HttpRuntimePort,
): Promise<void> {
  const timers = scheduler?.stopAll() ?? Promise.resolve();
  const server = (httpRuntime as HttpRuntimePort & {
    server?: { close(callback: (error?: Error) => void): void } | null;
  }).server;
  // Admitted jobs may still need the local HTTP compatibility bridge after lock acquisition.
  // Both cleanup attempts must also run when draining fails.
  const drained = timers.then(() => {}, () => {});
  const listener = drained.then(() => server
    ? new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
    : undefined);
  const lock = drained.then(() => advisoryLock?.close());
  const results = await Promise.allSettled([timers, lock, listener]);
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, "node_host_shutdown_failed");
}
