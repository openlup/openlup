import type {
  AlertDecision,
  AlertNotificationOutcome,
  ObservabilitySnapshot,
  OpenAlert,
} from "./observabilityContracts.js";

export type ObservabilityEvidencePort = {
  collectSnapshot(now: Date): Promise<ObservabilitySnapshot>;
};

export type AlertLedgerPort = {
  listOpenAlerts(): Promise<OpenAlert[]>;
  upsertOpenAlert(decision: AlertDecision, now: Date): Promise<OpenAlert>;
  resolveAlert(dedupeKey: string, now: Date): Promise<void>;
  recordNotification(
    alertId: string,
    outcome: AlertNotificationOutcome,
    now: Date,
    schedule: {
      nextAttemptAt: Date;
      failureCount: number;
    },
  ): Promise<void>;
};

export type AlertSinkPort = {
  send(decision: AlertDecision, alert: OpenAlert): Promise<AlertNotificationOutcome>;
};
