import type { PaymentIntentStatus } from "@openlup/core/payment";
import type { StockWaitCase, StockWaitDeficit } from "./stockWait.js";

/** @experimental */
export type StockWaitReadState = StockWaitCase["state"];

/** @experimental */
export interface StockWaitReadNotice {
  templateSlug: "subscription-stock-wait-started" | "subscription-stock-wait-resumed";
  status: string;
  lastErrorCode: string | null;
  updatedAt: string;
}

/** Compact read evidence. Snapshot, recipient and command bindings stay server-side.
 * @experimental
 */
export interface StockWaitReadProjection {
  schemaVersion: 2;
  caseKind: string;
  id: string;
  clientId: string;
  subscriptionId: string;
  cycleNumber: number;
  scheduledAt: string;
  state: StockWaitReadState;
  deficits: StockWaitDeficit[];
  orderId: string | null;
  cycleId: string | null;
  fulfillmentId: string | null;
  openedAt: string;
  lastCheckedAt: string;
  stockSecuredAt: string | null;
  resumedAt: string | null;
  closedAt: string | null;
  blockReason: string | null;
  automaticRecoveryEligible: boolean;
  independentBlock: string | null;
  notices: StockWaitReadNotice[];
}

/** @experimental */
export interface StockWaitOperatorSummary {
  totalCount: number;
  productTotals: { sku: string; displayName: string; missingUnits: number; affectedCases: number }[];
}

/** @experimental */
export interface StockWaitAdminPage extends StockWaitOperatorSummary {
  cases: (StockWaitReadProjection & {
    paymentStatus: PaymentIntentStatus | "not_started";
    paymentEvidence: "recorded" | "missing" | "not_applicable";
  })[];
  page: number;
  pageSize: number;
}
