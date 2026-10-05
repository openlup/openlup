import metadata from "../package.json" with { type: "json" };
import type { Contribution, RequiredSchema } from "@openlup/core/readiness";
import type { JobLeasePort, PlatformJobInvocation, PlatformJobFinishSummary } from "@openlup/core/platform-runtime";
import type { OutboxHandlerDescriptor } from "@openlup/core/outbox";
import type { OutboxDispatchConfig, OutboxDispatchRunResult, OutboxHandlerRegistry, OutboxLogger, OutboxStore, OutboxQueueDiagnostics, Clock } from "./contracts.js";
import { validateScheduledConfig } from "./config.js";
import { runOutboxDispatchWorker } from "./worker.js";
/** @beta */
export interface CompactionPort { compact(input: { processedDays: number; discardedDays: number; limit: number }): Promise<number> }
/** @beta The builder owns partially acquired resources until this scope is returned. */
export interface HandlerScope { handlers: OutboxHandlerRegistry; close?(): Promise<void> | void }
/** @beta */
export interface OutboxFactoryPorts {
  store: OutboxStore; lease: JobLeasePort;
  descriptors: readonly OutboxHandlerDescriptor[];
  buildHandlers(run: { runId: string; invocation: PlatformJobInvocation }): Promise<OutboxHandlerRegistry | HandlerScope> | OutboxHandlerRegistry | HandlerScope;
  beforeDispatch?(run: { runId: string; invocation: PlatformJobInvocation }): Promise<Record<string, unknown>>;
  diagnostics?: OutboxQueueDiagnostics; clock?: Clock; logger?: OutboxLogger;
  compactor?: CompactionPort;
}
/** @beta Schema requirements describe the selected adapters, not a guessed default. */
export interface OutboxFactoryOptions {
  config: OutboxDispatchConfig; knownEventTypes: readonly string[];
  hostLimitSeconds: number; leaseSeconds: number; cadenceSeconds: number;
  requiredSchema: RequiredSchema;
  prune?: { enabled: boolean; cadenceSeconds: number; processedDays?: number; discardedDays?: number; limit?: number };
}
/** @beta Finish/cleanup evidence is distinct from the accepted worker result. */
export interface OutboxScheduleResult {
  outcome: "success" | "failed" | "skipped" | "disabled";
  detail: OutboxDispatchRunResult | { ok: boolean; checked: number; updated: number; failures: number; skipped: boolean; reason?: string };
  finishApplied?: boolean;
}
export function createOutbox(ports: OutboxFactoryPorts & { compactor: CompactionPort }, options: OutboxFactoryOptions): Contribution;
export function createOutbox(ports: OutboxFactoryPorts, options: OutboxFactoryOptions & { prune?: { enabled: false; cadenceSeconds: number } }): Contribution;
/** @beta Lease-bound dispatch and terminal compaction, with no host entrypoint. */
export function createOutbox(ports: OutboxFactoryPorts, options: OutboxFactoryOptions): Contribution {
  options = { ...options, config: { ...options.config }, knownEventTypes: [...options.knownEventTypes],
    requiredSchema: { ...options.requiredSchema, objects: options.requiredSchema.objects.map((o) => ({ ...o })) },
    ...(options.prune ? { prune: { ...options.prune } } : {}) };
  ports = { ...ports };
  const descriptors = ports.descriptors.map((d) => Object.freeze({ eventType: d.eventType, timeoutMs: d.timeoutMs }));
  validateScheduledConfig(options.config, options.hostLimitSeconds, descriptors.map((d) => d.timeoutMs));
  const positive = (key: string, value: number, maximum: number): void => {
    if (!Number.isInteger(value) || value <= 0 || value > maximum) throw new Error(`@openlup/outbox: ${key}: use a positive integer at most ${maximum}`);
  };
  positive("leaseSeconds", options.leaseSeconds, 3600);
  if (options.leaseSeconds < options.hostLimitSeconds) throw new Error("@openlup/outbox: leaseSeconds: cover the full host execution window, including finish time"); positive("cadenceSeconds", options.cadenceSeconds, 86400);
  if (new Set(descriptors.map((d) => d.eventType)).size !== descriptors.length || descriptors.some((d) => !d.eventType.trim())) throw new Error("@openlup/outbox: descriptors: supply one descriptor for each composed event handler");
  if (!ports.store || !ports.lease || typeof ports.buildHandlers !== "function") throw new Error("@openlup/outbox: ports: supply store, lease and handler builder");
  const suppliedLogger = ports.logger ?? console;
  const log = (method: "warn" | "error", args: unknown[]): void => { try { suppliedLogger[method](...args); } catch { /* Diagnostics cannot skip finish or cleanup. */ } };
  const logger = { warn: (...args: unknown[]) => log("warn", args), error: (...args: unknown[]) => log("error", args) };
  const config = { ...options.config }, knownEventTypes = [...options.knownEventTypes];
  const pruning = options.prune?.enabled === true;
  const retention = { processedDays: options.prune?.processedDays ?? 30, discardedDays: options.prune?.discardedDays ?? 90, limit: options.prune?.limit ?? 500 };
  if (pruning) {
    if (!ports.compactor) throw new Error("@openlup/outbox: compactor: bind terminal compaction when prune is selected");
    positive("prune.cadenceSeconds", options.prune!.cadenceSeconds, 604800);
    positive("processedDays", retention.processedDays, 3650); positive("discardedDays", retention.discardedDays, 3650); positive("limit", retention.limit, 10000);
  }
  const summary = (reason: string): PlatformJobFinishSummary & { ok: false } => ({ ok: false, checked: 0, updated: 0, failures: 1, skipped: false, reason });
  const run = async (jobName: string, invocation: PlatformJobInvocation, dispatch: boolean): Promise<OutboxScheduleResult> => {
    const claim = await ports.lease.claimJobRun(jobName, invocation, options.leaseSeconds);
    if (!claim.acquired) return { outcome: claim.reason === "job_disabled" ? "disabled" : "skipped", detail: { ok: true, checked: 0, updated: 0, failures: 0, skipped: true, reason: claim.reason } };
    if (!claim.runId) throw new Error("@openlup/outbox: acquired lease has no run id");
    let scope: HandlerScope | undefined; let hookMetadata: Record<string, unknown> = {};
    let detail: OutboxScheduleResult["detail"] = summary("outbox_dispatch_failed");
    let failure = false;
    try {
      try {
        if (dispatch) {
          const context = { runId: claim.runId, invocation };
          hookMetadata = await ports.beforeDispatch?.(context) ?? {};
          const built = await ports.buildHandlers(context);
          scope = "handlers" in built ? built : { handlers: built };
          const actual = scope.handlers;
          if (actual.size !== descriptors.length || descriptors.some((d) => actual.get(d.eventType)?.eventType !== d.eventType || actual.get(d.eventType)?.timeoutMs !== d.timeoutMs)) throw new Error("outbox_registry_descriptor_mismatch");
          detail = await runOutboxDispatchWorker({ store: ports.store, registry: actual, config, knownEventTypes, diagnostics: ports.diagnostics, clock: ports.clock, logger });
        } else {
          const count = await ports.compactor!.compact(retention);
          detail = { ok: true, checked: count, updated: count, failures: 0, skipped: false };
        }
      } catch (error) {
        failure = true;
        detail = summary(message(error));
        logger.error("[outbox-dispatch] schedule_failed", message(error));
      }
      // Reserved run identity and worker counters override hook metadata.
      const extra = { ...hookMetadata, ...detail, runId: claim.runId };
      const finishApplied = await ports.lease.finishJobRun(jobName, claim.runId, invocation, failure ? "failed" : "success", detail, extra);
      return { outcome: failure || !finishApplied ? "failed" : detail.skipped ? "skipped" : "success", detail, finishApplied };
    } catch (error) {
      logger.error("[outbox-dispatch] finish_job_run_failed", message(error));
      throw error;
    } finally {
      try { await scope?.close?.(); } catch (error) { logger.error("[outbox-dispatch] handler_scope_close_failed", message(error)); }
    }
  };
  const schedules = [{ id: "outbox-dispatch", cadenceSeconds: options.cadenceSeconds, run: (invocation: PlatformJobInvocation) => run("outbox-dispatch", invocation, true) },
    ...(pruning ? [{ id: "outbox-prune", cadenceSeconds: options.prune!.cadenceSeconds, run: (invocation: PlatformJobInvocation) => run("outbox-prune", invocation, false) }] : [])];
  return { handlers: descriptors, schedules, routes: [], manifest: {
    name: metadata.name, version: metadata.version, kind: "rail", emits: [], handles: descriptors.map((d) => d.eventType),
    schedules: schedules.map(({id,cadenceSeconds}) => ({id,cadenceSeconds})), routes: [], requiredPorts: ["store", "lease", ...(pruning ? ["compactor"] : [])], env: [], requiredSchema: options.requiredSchema,
  } };
}
function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0,180); }
