import type {
  AlertDecision,
  AlertNotificationOutcome,
  WatchdogSnapshot,
  OpenAlert,
} from "./observabilityContracts.js";

export type ObservabilityEvidencePort<Snapshot extends WatchdogSnapshot = WatchdogSnapshot> = {
  collectSnapshot(now: Date): Promise<Snapshot>;
};

export type AlertLedgerPort<Channel extends string = string> = {
  listOpenAlerts(): Promise<OpenAlert[]>;
  upsertOpenAlert(decision: AlertDecision<Channel>, now: Date): Promise<OpenAlert>;
  resolveAlert(dedupeKey: string, now: Date): Promise<void>;
  recordNotification(
    alertId: string,
    /** The kernel retains its existing webhook-keyed skipped-attempt audit rows. */
    outcome: AlertNotificationOutcome<Channel | "webhook">,
    now: Date,
    schedule: {
      nextAttemptAt: Date;
      failureCount: number;
    },
  ): Promise<void>;
};

export type AlertSinkPort<Channel extends string = string> = {
  send(decision: AlertDecision<Channel>, alert: OpenAlert): Promise<AlertNotificationOutcome<Channel>>;
};
