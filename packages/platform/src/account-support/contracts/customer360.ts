/** Verified human administrator context, supplied by the host. */
export interface OperatorContext { operatorId: string; role: "admin"; isMachineActor: false; graph: "managed" | "native" }
/** Verbatim parsed customer-360 lookup vocabulary; defaults belong to the host codec. */
export interface Customer360Lookup {
  query?: string; subjectId?: string; orderId?: string; subscriptionId?: string;
  email?: string; pageSize: number; mode?: "search" | "snapshot";
}
/** The supplied search/snapshot DTOs preserve owner coverage and omitted enrichments. */
export interface Customer360ReadPort<Search, Snapshot> {
  searchCustomerJourney(request: Customer360Lookup): Promise<Search>;
  getCustomerJourney(request: Customer360Lookup): Promise<Snapshot | null>;
}

export type Customer360LifecycleStage = "lead" | "waitlist" | "tester" | "customer" | "inactive";

export interface Customer360Subject {
  subjectId: string;
  displayName: string | null;
  email: string | null;
  phone?: string | null;
  lifecycleStage: Customer360LifecycleStage;
  lifecycle: { stage: Customer360LifecycleStage; enteredAt: string | null; exitedAt: string | null }[];
  firstSeenAt: string | null;
  lastActivityAt: string | null;
  authUserLinked?: boolean;
  hasSignedIn?: boolean;
}

export interface Customer360Order {
  orderId: string;
  orderNumber: string | null;
  status: string;
  subscriptionId: string | null;
  totalMinor: number | null;
  currency: string | null;
  createdAt: string | null
}

export interface Customer360Subscription {
  subscriptionId: string;
  status: string;
  nextCycleAt: string | null;
  latestOrderId: string | null;
  templateVersion?: number;
  shippingAddressId?: string | null;
  paymentMethodKind?: string | null;
  paymentMethodStatus?: string | null
}

export interface Customer360PaymentTruth {
  orderId: string;
  status: string;
  recoverable: boolean;
  amountMinor: number | null;
  currency: string | null;
  lastAttemptAt: string | null
}

export interface Customer360DunningCase {
  caseId: string;
  subscriptionId: string;
  orderId: string | null;
  status: string;
  retryAttempt: number;
  nextRetryAt: string | null;
  notificationStatus: string | null;
  recoveryAvailable: boolean
}

export interface Customer360Recovery {
  caseId: string;
  status: "available" | "unavailable";
  actionAvailable: boolean;
  lastIssuedAt: string | null;
  lastDeliveryStatus: string | null
}

export interface Customer360ContactHealth {
  lastTerminalStatus: "delivered" | "bounced" | "complained" | "failed" | null;
  lastTerminalAt: string | null;
  reachable: boolean
}

export interface Customer360Address {
  addressId: string;
  label: string | null;
  recipientName: string | null;
  line1: string;
  line2: string | null;
  postalCode: string;
  city: string;
  country: string;
  contactPhone: string | null;
  isDefault: boolean;
  kind: "shipping" | "both"
}

export interface Customer360AuditEvent {
  eventId: string;
  occurredAt: string;
  action: string;
  outcome: string;
  entity: { kind: "subject" | "order" | "subscription" | "dunning_case" | "recovery"; id: string }
}

export interface Customer360LookupResult {
  query: string;
  matchedBy: "subject_id" | "email" | "order_id" | "order_number" | "subscription_id" | "text";
  confidence: "exact" | "high" | "medium";
  warnings: string[]
}

export interface Customer360SearchResponse {
  contractVersion: "support.customer_360.v2";
  query: string;
  candidates: {
    subjectId: string;
    displayName: string | null;
    email: string | null;
    lifecycleStage: Customer360LifecycleStage;
    matchedBy: Customer360LookupResult["matchedBy"];
    confidence: Customer360LookupResult["confidence"];
    lastActivityAt: string | null;
    snapshotLookup: { subjectId: string }
  }[];
  warnings: string[];
}

export interface Customer360Snapshot<Extension = unknown> {
  contractVersion: "support.customer_360.v2";
  lookup: Customer360LookupResult;
  subject: Customer360Subject;
  orders: Customer360Order[];
  subscriptions: Customer360Subscription[];
  payment: Customer360PaymentTruth[];
  dunningCases: Customer360DunningCase[];
  recovery: Customer360Recovery[];
  auditTrail: Customer360AuditEvent[];
  contactHealth?: Customer360ContactHealth;
  addresses?: Customer360Address[];
  extension?: Extension;
}

export interface Customer360SummaryReadPort<Request, Result> {
  getPortableSummary(request: Request): Promise<Result>
}

export interface DiagnosticHistoryReadPort<Request, Result> {
  history(request: Request): Promise<Result>
}
