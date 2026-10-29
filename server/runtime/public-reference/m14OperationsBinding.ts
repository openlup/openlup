import type { AdminPipelineReadPort, OperationsAuthorizationResult } from "@openlup/platform/operations/contracts";
import { JOB_CATALOG } from "../../../src/domains/platform/jobCatalog.js";
import type { JobCatalogEntry } from "../../../src/domains/platform/observabilityContracts.js";
import type { AlertLedgerPort, AlertSinkPort, ObservabilityEvidencePort } from "../../../src/domains/platform/observabilityPorts.js";
import { createAdminAlertsOverviewHandler, type AdminAlertsReadPort } from "../../domains/platform/adminAlertsHandlers.js";
import { createAdminPipelineReadHandler } from "../../domains/platform/adminPipelineHandlers.js";
import { runPlatformWatchdog } from "../../domains/platform/platformWatchdogService.js";
import { sendBffError } from "../../_lib/bff/response.js";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";

/** Host-owned evidence/persistence, retained interpretation, no implicit network sink. */
export function createM14OperationsReferenceBinding(input: {
  evidencePort: ObservabilityEvidencePort;
  ledgerPort: AlertLedgerPort;
  alertsReadPort: AdminAlertsReadPort;
  pipelinePort: AdminPipelineReadPort;
  authorizeAdmin(req: HttpRequest): Promise<OperationsAuthorizationResult>;
  recordHeartbeat(now: Date): Promise<boolean>;
  catalog?: readonly JobCatalogEntry[];
  /** Explicit adapter selection replaces capture; its receipt is not remote readback. */
  sinkPort?: AlertSinkPort;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  function boundedRead(handler: (req: HttpRequest, res: HttpResponse) => Promise<void>) {
    return async (req: HttpRequest, res: HttpResponse) => {
      try { await handler(req, res); }
      catch { sendBffError(res, "UPSTREAM_UNAVAILABLE", "Operations read unavailable"); }
    };
  }

  return {
    // The host schedules this trusted callable; it is not an unauthenticated HTTP route.
    async runWatchdog({ checkOnly = false }: { checkOnly?: boolean } = {}) {
      const checkedAt = now();
      // Capture belongs to this invocation, so concurrent ticks cannot share readback.
      // Raw payloads stay in the host-owned ledger, never in this capture or route logs.
      const captured: { alertId: string; dedupeKey: string; severity: string; capturedAt: string }[] = [];
      const sinkPort: AlertSinkPort = input.sinkPort ?? {
        async send(decision, alert) {
          captured.push({ alertId: alert.id, dedupeKey: decision.dedupeKey, severity: decision.severity, capturedAt: checkedAt.toISOString() });
          return { channel: "webhook", status: "skipped", provider: "local_capture", error: "local_capture_only" };
        },
      };
      // Capture is an observation, not a notification attempt. Preserve alert
      // upserts/resolution while leaving a later selected sink's cadence untouched.
      const ledgerPort: AlertLedgerPort = input.sinkPort ? input.ledgerPort : {
        listOpenAlerts: () => input.ledgerPort.listOpenAlerts(),
        upsertOpenAlert: (decision, at) => input.ledgerPort.upsertOpenAlert(decision, at),
        resolveAlert: (key, at) => input.ledgerPort.resolveAlert(key, at),
        recordNotification: async () => {},
      };
      try {
        const result = await runPlatformWatchdog({
          evidencePort: input.evidencePort, ledgerPort, sinkPort,
          catalog: input.catalog ?? JOB_CATALOG, now: checkedAt, checkOnly,
        });
        const heartbeatRecorded = !checkOnly && await input.recordHeartbeat(checkedAt);
        return { ...result, heartbeatRecorded, delivery: input.sinkPort ? "adapter" as const : "captured" as const, captured };
      } catch {
        return { ok: false as const, error: "operations_watchdog_unavailable" as const };
      }
    },
    alerts: boundedRead(async (req, res) => {
      await createAdminAlertsOverviewHandler({
        readPort: input.alertsReadPort, authorizeAdmin: () => input.authorizeAdmin(req), now,
      })(req, res);
    }),
    pipeline: boundedRead(createAdminPipelineReadHandler({
      pipelinePort: input.pipelinePort, authorizeAdmin: input.authorizeAdmin,
    })),
  };
}
