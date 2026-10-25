import type {
  Customer360Snapshot,
  Customer360Subject,
  Customer360ContactHealth,
  Customer360ReadPort,
  Customer360Lookup,
  Customer360SummaryReadPort,
  DiagnosticHistoryReadPort
} from "./contracts/customer360.js";

export const SUPPORT_CUSTOMER_360_CONTRACT_VERSION = "support.customer_360.v2" as const;
type Row = Record<string, unknown>;
export type CustomerJourneyAuditEvent = {
  eventId: string;
  occurredAt: string;
  action: string;
  outcome: string;
  entity: { kind: "subject" | "order" | "subscription" | "dunning_case"; id: string }
};

export interface ContactHealthDelivery {
  readonly status: string;
  readonly occurredAt: string | null;
  readonly permanentBounce: boolean | null
}

export interface Customer360ProjectionInput<Extension = unknown> {
  subject: {
    subjectId: string;
    displayName: string | null;
    email: string | null;
    phone?: string | null;
    lifecycleStage: Customer360Subject["lifecycleStage"];
    createdAt: string | null;
    lastActivityAt: string | null
  };
  legacy: {
    lookup: { warnings: string[] };
    customer: { authUserLinked: boolean };
    orders: { orderId: string; orderNumber: string | null; status: string | null; omsProjection: Row }[];
    subscriptions: {
      subscriptionId: string;
      status: string | null;
      nextCycleAt: string | null;
      templateVersion?: number | null;
      paymentMethodStatus?: string | null;
      renewalOrders: Row[]
    }[];
    payment: { status: string | null; intents: Row[] };
    timeline: Row[];
  } | null;
  cases: Row[];
  notices: Row[];
  tokens: Row[];
  recoveryAudit: Row[];
  orderTruth: Row[];
  now: number;
  contactHealth?: Customer360ContactHealth | null;
  signedIn?: boolean;
  addresses?: Customer360Snapshot["addresses"] | null;
  subscriptionPointers?: Map<string, { shippingAddressId: string | null; paymentMethodKind: string | null }> | null;
  /** false means failed/unavailable; null means no enrichment selected. */
  profile?: { extension: Extension; partial: boolean } | false | null;
}

export interface Customer360ProjectionPolicy {
  lifecycle(subject: Customer360ProjectionInput["subject"]): Customer360Subject["lifecycle"];
  /** Stable audit identity hashing remains in the server host. */
  timelineAudit(event: Row, subjectId: string): CustomerJourneyAuditEvent[];
}

export function projectCustomer360Snapshot<Extension>(
  input: Customer360ProjectionInput<Extension>,
  policy: Customer360ProjectionPolicy
): Customer360Snapshot<Extension> {
  const { subject, legacy, cases, notices, tokens, recoveryAudit, orderTruth, now } = input;
  const orders = legacy?.orders.map(order => ({
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    status: order.status ?? "unknown",
    subscriptionId: string(order.omsProjection.subscriptionId),
    totalMinor: integer(order.omsProjection.totalMinor),
    currency: string(order.omsProjection.currency),
    createdAt: date(order.omsProjection.createdAt)
  })) ?? [];
  const pending = (row: Row) => orderTruth.some(
    order => order.id === row.order_id && order.client_id === row.client_id && order.status === "pending_payment"
  );
  const eligible = (row: Row) => subject.lifecycleStage === "customer" && row.status === "open" && pending(row);
  const audit = boundedCustomerJourneyAudit([
    ...(legacy?.timeline ?? []).flatMap(event => policy.timelineAudit(event, subject.subjectId)),
    ...recoveryAudit.flatMap(recoveryEvent)
  ]);
  const profile = input.profile;
  const warnings = [...new Set([
    ...(legacy?.lookup.warnings ?? []),
    ...(audit.windowed ? ["evidence_window_limited:customer_360_audit_trail"] : []),
    ...(recoveryAudit.length === 80 ? ["evidence_window_limited:customer_recovery_audit"] : []),
    ...(profile === false ? ["evidence_unavailable:customer_profile"] : profile?.partial ? ["evidence_partial:customer_profile"] : [])
  ])];
  return {
    contractVersion: SUPPORT_CUSTOMER_360_CONTRACT_VERSION,
    lookup: { query: subject.subjectId, matchedBy: "subject_id", confidence: "exact", warnings },
    ...(input.contactHealth ? { contactHealth: input.contactHealth } : {}),
    ...(input.addresses ? { addresses: input.addresses } : {}),
    ...(profile ? { extension: profile.extension } : {}),
    subject: {
      subjectId: subject.subjectId,
      displayName: subject.displayName,
      email: subject.email,
      phone: subject.phone ?? null,
      lifecycleStage: subject.lifecycleStage,
      lifecycle: policy.lifecycle(subject),
      firstSeenAt: subject.createdAt,
      lastActivityAt: latest([...(legacy?.timeline ?? []), ...cases, ...recoveryAudit]) ?? subject.lastActivityAt,
      ...(legacy ? { authUserLinked: legacy.customer.authUserLinked } : {}),
      ...(input.signedIn === undefined ? {} : { hasSignedIn: input.signedIn })
    },
    orders,
    subscriptions: legacy?.subscriptions.map(value => ({
      subscriptionId: value.subscriptionId,
      status: value.status ?? "unknown",
      nextCycleAt: value.nextCycleAt,
      latestOrderId: string(value.renewalOrders[0]?.orderId),
      ...(typeof value.templateVersion === "number" ? { templateVersion: value.templateVersion } : {}),
      ...(input.subscriptionPointers
        ? {
          shippingAddressId: input.subscriptionPointers.get(value.subscriptionId)?.shippingAddressId ?? null,
          paymentMethodKind: input.subscriptionPointers.get(value.subscriptionId)?.paymentMethodKind ?? null
        }
        : {}),
      paymentMethodStatus: string(value.paymentMethodStatus)
    })) ?? [],
    payment: orders.map(order => {
      const intent = legacy?.payment.intents.find(value => string(value.orderId) === order.orderId);
      return {
        orderId: order.orderId,
        status: string(intent?.status) ?? legacy?.payment.status ?? "unknown",
        recoverable: cases.some(row => row.order_id === order.orderId && eligible(row)),
        amountMinor: order.totalMinor,
        currency: order.currency,
        lastAttemptAt: date(intent?.updatedAt)
      };
    }),
    dunningCases: cases.map(row => ({
      caseId: string(row.id)!,
      subscriptionId: string(row.subscription_id)!,
      orderId: string(row.order_id),
      status: string(row.status) ?? "unknown",
      retryAttempt: integer(row.retry_attempt) ?? 0,
      nextRetryAt: date(row.next_retry_at),
      notificationStatus: string(latestNotice(notices, string(row.id)!)?.status),
      recoveryAvailable: eligible(row)
    })),
    recovery: cases.map(row => {
      const id = string(row.id)!, related = tokens.filter(value => value.case_id === id);
      return {
        caseId: id,
        status: pending(row) && related.some(value => {
          const expiry = date(value.expires_at);
          return Boolean(expiry && Date.parse(expiry) > now && !value.used_at && !value.revoked_at);
        }) ? "available" : "unavailable",
        actionAvailable: eligible(row),
        lastIssuedAt: related.map(value => date(value.created_at)).filter(value => value !== null).sort().at(-1) ?? null,
        lastDeliveryStatus: string(latestNotice(notices, id, "payment_recovery")?.status)
      };
    }),
    auditTrail: audit.events
  };
}

export function boundedCustomerJourneyAudit(events: CustomerJourneyAuditEvent[]) {
  const instant = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
  const newest = [...events].sort((a, b) => instant(b.occurredAt) - instant(a.occurredAt) || a.eventId.localeCompare(b.eventId));
  return {
    events: newest.slice(0, 80).sort((a, b) => instant(a.occurredAt) - instant(b.occurredAt) || a.eventId.localeCompare(b.eventId)),
    windowed: newest.length > 80
  };
}

export function deriveContactHealth(deliveries: readonly ContactHealthDelivery[]): Customer360ContactHealth {
  const terminal = ["delivered", "bounced", "complained", "failed"] as const;
  const newest = deliveries.filter(
    (value): value is ContactHealthDelivery & { occurredAt: string } =>
      (terminal as readonly string[]).includes(value.status) && typeof value.occurredAt === "string"
  )
    .reduce<(ContactHealthDelivery & { occurredAt: string }) | null>(
      (best, value) => best === null || value.occurredAt > best.occurredAt ? value : best,
      null
    );
  if (!newest) return { lastTerminalStatus: null, lastTerminalAt: null, reachable: true };
  return {
    lastTerminalStatus: newest.status as typeof terminal[number],
    lastTerminalAt: newest.occurredAt,
    reachable: newest.status === "delivered" || (newest.status === "bounced" && newest.permanentBounce === false)
  };
}

/** Authorize before every source read; retain host defaults, ambiguity, null and failure semantics. */
export function createCustomer360ReadFacade<Search, Snapshot, SummaryRequest, SummaryResult, DiagnosticRequest, DiagnosticResult>(ports: {
  authorize(): Promise<boolean>;
  journey: Customer360ReadPort<Search, Snapshot>;
  summary: Customer360SummaryReadPort<SummaryRequest, SummaryResult>;
  diagnostics: DiagnosticHistoryReadPort<DiagnosticRequest, DiagnosticResult>;
}) {
  async function read<Result>(query: () => Promise<Result>) {
    if (!await ports.authorize()) return { kind: "denied" as const };
    return query();
  }
  return {
    searchCustomerJourney: (request: Customer360Lookup) => read(() => ports.journey.searchCustomerJourney(request)),
    getCustomerJourney: (request: Customer360Lookup) => read(() => ports.journey.getCustomerJourney(request)),
    getPortableSummary: (request: SummaryRequest) => read(() => ports.summary.getPortableSummary(request)),
    history: (request: DiagnosticRequest) => read(() => ports.diagnostics.history(request))
  };
}

function recoveryEvent(row: Row): CustomerJourneyAuditEvent[] {
  const eventId = string(row.id),
    occurredAt = date(row.occurred_at),
    id = string(row.case_id),
    outcome = string(row.outcome);
  if (!eventId || !occurredAt || !id || !outcome) return [];
  const refusal = string(row.refusal_code);
  return [{
    eventId,
    occurredAt,
    action: "recovery.issue",
    outcome: refusal ? `${outcome}:${refusal}` : outcome,
    entity: { kind: "dunning_case", id }
  }];
}

function latestNotice(rows: Row[], id: string, kind?: string) {
  return rows.filter(
    row => row.case_id === id && row.recipient_kind === "customer" && (!kind || row.notification_kind === kind)
  )
    .sort(
      (a, b) => `${string(b.created_at) ?? ""}:${string(b.id) ?? ""}`.localeCompare(
        `${string(a.created_at) ?? ""}:${string(a.id) ?? ""}`
      )
    )[0];
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function date(value: unknown): string | null {
  const text = string(value);
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

function latest(rows: Row[]): string | null {
  return rows.map(
    row => date(
      row.updated_at ?? row.updatedAt ?? row.created_at ?? row.createdAt ?? row.occurred_at ?? row.occurredAt
    )
  )
    .filter(value => value !== null)
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1)
    ?? null;
}
