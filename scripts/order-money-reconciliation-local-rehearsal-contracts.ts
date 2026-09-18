import type {
  AlertDecision,
  AlertNotificationOutcome,
  OpenAlert,
} from "../src/domains/platform/observabilityContracts.ts";
import type {
  AlertLedgerPort,
  AlertSinkPort,
} from "../src/domains/platform/observabilityPorts.ts";
import type {
  OrderMoneyReconciliationMode,
  OrderMoneyReconciliationSnapshot,
} from "../src/domains/platform/orderMoneyReconciliationContracts.ts";
import type { OrderMoneyReconciliationRows } from "../server/adapters/supabase/platform/orderMoneyReconciliationRows.ts";

export type OrderMoneyReconciliationEvidenceFixture = {
  namespace: string;
  ids: {
    healthyOrderId: string;
    unavailableByMode: Record<OrderMoneyReconciliationMode, string>;
    mismatchOrderId: string;
  };
  loadRows(): Promise<OrderMoneyReconciliationRows>;
  cleanup(): Promise<void>;
};

export type OrderMoneyEvidenceLedgerProbe = {
  alerts: OpenAlert[];
  notifications: Array<{
    alertId: string;
    dedupeKey: string;
    outcome: AlertNotificationOutcome;
  }>;
};

export type OrderMoneyEvidenceLedgerPort = AlertLedgerPort & {
  readProbe(): Promise<OrderMoneyEvidenceLedgerProbe>;
};

export type OrderMoneyEvidenceSinkPort = AlertSinkPort & {
  readProbe(): Promise<AlertDecision[]>;
};

export type OrderMoneyReconciliationLocalRehearsalInput = {
  fixture: OrderMoneyReconciliationEvidenceFixture;
  ledgerPort: OrderMoneyEvidenceLedgerPort;
  sinkPort: OrderMoneyEvidenceSinkPort;
  now?: Date;
};

export type OrderMoneyReconciliationLocalRehearsalReport = {
  namespace: string;
  checkedCount: number;
  mismatchCount: number;
  providerUnavailableCount: number;
  byMode: OrderMoneyReconciliationSnapshot["byMode"];
  firstRunDecisionKeys: string[];
  secondRunDecisionKeys: string[];
  durableAlertKeys: string[];
  sentDecisionKeys: string[];
};

export function requireOrderMoneyEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`order_money_reconciliation_local_rehearsal_failed: ${message}`);
}
