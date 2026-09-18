import type {
  AlertDecision,
  OpenAlert,
} from "../src/domains/platform/observabilityContracts.ts";
import {
  requireOrderMoneyEvidence,
  type OrderMoneyEvidenceLedgerPort,
  type OrderMoneyEvidenceLedgerProbe,
  type OrderMoneyEvidenceSinkPort,
} from "./order-money-reconciliation-local-rehearsal-contracts.ts";

export function createInMemoryOrderMoneyEvidencePorts(): {
  ledgerPort: OrderMoneyEvidenceLedgerPort;
  sinkPort: OrderMoneyEvidenceSinkPort;
} {
  const alerts = new Map<string, OpenAlert>();
  const notifications: OrderMoneyEvidenceLedgerProbe["notifications"] = [];
  const sent: AlertDecision[] = [];

  const ledgerPort: OrderMoneyEvidenceLedgerPort = {
    async listOpenAlerts() {
      return structuredClone([...alerts.values()]);
    },
    async upsertOpenAlert(decision) {
      const existing = alerts.get(decision.dedupeKey);
      const alert: OpenAlert = existing
        ? { ...existing, status: "open", severity: decision.severity }
        : {
          id: `evidence-alert-${alerts.size + 1}`,
          dedupeKey: decision.dedupeKey,
          status: "open",
          severity: decision.severity,
          lastNotifiedAt: null,
        };
      alerts.set(alert.dedupeKey, alert);
      return structuredClone(alert);
    },
    async resolveAlert(dedupeKey) {
      alerts.delete(dedupeKey);
    },
    async recordNotification(alertId, outcome, now) {
      const alert = [...alerts.values()].find((row) => row.id === alertId);
      requireOrderMoneyEvidence(alert, `notification references unknown alert ${alertId}`);
      alert.lastNotifiedAt = now.toISOString();
      notifications.push({ alertId, dedupeKey: alert.dedupeKey, outcome: structuredClone(outcome) });
    },
    async readProbe() {
      return structuredClone({ alerts: [...alerts.values()], notifications });
    },
  };

  const sinkPort: OrderMoneyEvidenceSinkPort = {
    async send(decision) {
      sent.push(structuredClone(decision));
      return { channel: "webhook", status: "sent", provider: "in-memory-evidence-sink" };
    },
    async readProbe() {
      return structuredClone(sent);
    },
  };

  return { ledgerPort, sinkPort };
}
