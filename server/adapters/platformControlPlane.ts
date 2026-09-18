import { createHash } from "node:crypto";

import type {
  PlatformControlPlaneMutation,
  PlatformControlPlaneMutationResponse,
  PlatformControlPlaneReadResponse,
} from "../../src/domains/platform/contracts.js";
import {
  PlatformControlPlaneConflictError,
  PlatformControlPlaneUnavailableError,
  type PlatformControlPlanePort,
} from "../../src/domains/platform/ports.js";
import type { PgQueryExecutor } from "./postgres/queryBuilder.js";

const rpc = (name: string, types: string[]) =>
  `SELECT * FROM public.${name}(${types.map((type, index) => `$${index + 1}::${type}`).join(", ")})`;

export const platformControlPlaneSql = {
  active: rpc("platform_control_operator_is_active", ["uuid"]),
  setControl: rpc("platform_control_set_control", ["uuid", "text", "text", "text", "boolean"]),
  heartbeat: rpc("platform_control_record_heartbeat", ["uuid", "text", "text", "text", "integer", "text", "boolean"]),
  controls: rpc("platform_control_list_controls", ["uuid"]),
  jobs: rpc("platform_control_list_jobs", ["uuid"]),
  alerts: rpc("platform_control_list_alerts", ["uuid"]),
} as const;

export function createPlatformControlPlanePort(
  client: PgQueryExecutor,
  operatorId: string,
): PlatformControlPlanePort {
  return {
    async readControlPlane() {
      try {
        const [controls, jobs, alerts] = await Promise.all([
          client.query(platformControlPlaneSql.controls, [operatorId]),
          client.query(platformControlPlaneSql.jobs, [operatorId]),
          client.query(platformControlPlaneSql.alerts, [operatorId]),
        ]);
        return {
          controls: controls.rows.map((row) => ({
            controlKey: text(row.control_key), enabled: bool(row.enabled),
            revision: positive(row.revision), updatedAt: timestamp(row.updated_at),
          })),
          jobs: jobs.rows.map((row) => ({
            jobName: text(row.job_name), enabled: bool(row.enabled),
            activeDriver: driver(row.active_driver), lastStatus: jobStatus(row.last_status),
            lastStartedAt: nullableTimestamp(row.last_started_at),
            lastFinishedAt: nullableTimestamp(row.last_finished_at),
            lastSuccessAt: nullableTimestamp(row.last_success_at),
          })),
          alerts: alerts.rows.map((row) => ({
            dedupeKey: text(row.dedupe_key), severity: severity(row.severity),
            status: alertStatus(row.status), owner: text(row.owner), title: text(row.title),
            firstSeenAt: timestamp(row.first_seen_at), lastSeenAt: timestamp(row.last_seen_at),
            resolvedAt: nullableTimestamp(row.resolved_at),
          })),
        } satisfies PlatformControlPlaneReadResponse;
      } catch (error) {
        throw mapError(error);
      }
    },

    async mutateControlPlane(request) {
      try {
        const fingerprint = digest(JSON.stringify(request));
        const result = request.action === "set-control"
          ? await client.query(platformControlPlaneSql.setControl, [
              operatorId, request.idempotencyKey, fingerprint, request.controlKey, request.enabled,
            ])
          : await client.query(platformControlPlaneSql.heartbeat, [
              operatorId, request.idempotencyKey, fingerprint, request.health,
              request.firingCount, request.maxSeverity, request.promotionReady,
            ]);
        return mutation(first(result.rows), request.action);
      } catch (error) {
        throw mapError(error);
      }
    },
  };
}

export async function isPlatformControlOperatorActive(
  client: PgQueryExecutor,
  principalId: string,
): Promise<boolean> {
  try {
    return first((await client.query(platformControlPlaneSql.active, [principalId])).rows)
      ?.platform_control_operator_is_active === true;
  } catch (error) {
    throw mapError(error);
  }
}

function mutation(
  row: Record<string, unknown> | undefined,
  expected: PlatformControlPlaneMutation["action"],
): PlatformControlPlaneMutationResponse {
  if (!row || row.action !== expected) throw new PlatformControlPlaneUnavailableError();
  return {
    action: expected,
    replayed: bool(row.replayed),
    revision: row.revision == null ? null : positive(row.revision),
    recordedAt: timestamp(row.recorded_at),
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function first(rows: Record<string, unknown>[]): Record<string, unknown> | undefined { return rows[0]; }
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new PlatformControlPlaneUnavailableError();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new PlatformControlPlaneUnavailableError();
  return value;
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new PlatformControlPlaneUnavailableError();
  return value;
}
function timestamp(value: unknown): string {
  const result = text(value);
  if (!Number.isFinite(Date.parse(result))) throw new PlatformControlPlaneUnavailableError();
  return result;
}
function nullableTimestamp(value: unknown): string | null { return value == null ? null : timestamp(value); }
function driver(value: unknown): "worker" | "scheduler" | "operator" {
  if (value === "worker" || value === "scheduler" || value === "operator") return value;
  throw new PlatformControlPlaneUnavailableError();
}
function jobStatus(value: unknown): "running" | "success" | "failed" | "skipped" | null {
  if (value == null) return null;
  if (value === "running" || value === "success" || value === "failed" || value === "skipped") return value;
  throw new PlatformControlPlaneUnavailableError();
}
function severity(value: unknown): "p0" | "p1" | "p2" | "p3" {
  if (value === "p0" || value === "p1" || value === "p2" || value === "p3") return value;
  throw new PlatformControlPlaneUnavailableError();
}
function alertStatus(value: unknown): "open" | "acknowledged" | "resolved" {
  if (value === "open" || value === "acknowledged" || value === "resolved") return value;
  throw new PlatformControlPlaneUnavailableError();
}
function mapError(error: unknown): Error {
  if (error instanceof PlatformControlPlaneUnavailableError || error instanceof PlatformControlPlaneConflictError) return error;
  const code = typeof error === "object" && error && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code === "23505") return new PlatformControlPlaneConflictError("platform_control_idempotency_conflict");
  return new PlatformControlPlaneUnavailableError("platform_control_plane_unavailable");
}
