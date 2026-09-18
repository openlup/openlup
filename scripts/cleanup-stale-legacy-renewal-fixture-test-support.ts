export function renewalEvidence() {
  const runId = "customer-subscription-1721840000000-abc123";
  return {
    legacySubscriptions: [{
      id: "renewal-subscription",
      client_id: "shared-client",
      pet_id: "renewal-pet",
      shipping_address_id: "renewal-address",
      billing_address_id: "renewal-address",
      created_at: "2026-07-24T16:42:45.445Z",
      status: "active",
      payment_method_kind: "blik_payid",
      payment_method_ref: `payid_smoke_${runId}`,
      offer_policy_version: "commerce.offer-policy.v1",
      promotion_engine_version: "promotion-engine.v1",
      is_test_fixture: false,
    }, {
      id: "customer-baseline",
      client_id: "customer-client",
      created_at: "2026-07-22T09:00:00.000Z",
      status: "active",
      payment_method_kind: "card",
      payment_method_ref: "real-method",
      offer_policy_version: "commerce.offer-policy.v1",
      promotion_engine_version: "promotion-engine.v1",
      is_test_fixture: false,
    }],
    markedOwnerIds: new Set<string>(),
    lines: [
      renewalLine("renewal-subscription", runId, "renewal-line-1"),
      renewalLine("renewal-subscription", runId, "renewal-line-2"),
    ],
    methodRefs: [{
      id: "method-ref",
      client_id: "shared-client",
      subscription_id: "renewal-subscription",
      provider_kind: "tpay",
      method_kind: "blik_payid",
      provider_method_ref: `payid_smoke_${runId}`,
      status: "active",
      active: true,
      consent_snapshot: {
        provider: "tpay", simulator: true, aliasResult: "accepted", recurringModel: "O",
      },
      metadata: {
        fixture: "customer_subscription_preview_smoke",
        runId,
        label: "renewal-payment-method-ref",
        stagingOnly: true,
      },
    }],
    runtimeDescendants: [],
    baselineCapturedAt: "2026-07-22T09:16:55.954Z",
    baselineExpectedCount: 1,
  };
}

function renewalLine(subscriptionId: string, runId: string, label: string) {
  return {
    id: `${label}-id`,
    subscription_id: subscriptionId,
    line_metadata: {
      fixture: "customer_subscription_preview_smoke",
      runId,
      label,
      stagingOnly: true,
      legacyGrandfathering: { baseUnitGrossMinor: 1490, frozenUnitGrossMinor: 1340 },
      productSnapshot: {
        quoteLine: { unitPriceGross: { amountMinor: 1340, currency: "PLN" } },
      },
    },
  };
}

type FakeOperation = {
  kind: "select" | "update" | "delete" | "eq" | "in" | "limit" | "rpc";
  table: string;
  queryId?: number;
  column?: string;
  value?: unknown;
  columns?: string;
};

export class RenewalCleanupFake {
  readonly targetSubscriptionId = "renewal-subscription";
  readonly operations: FakeOperation[] = [];
  private subscriptionPresent = true;
  private linesPresent = true;
  private subscriptionStatus = "active";
  private methodActive = true;
  private methodLinked = true;
  private nextQueryId = 1;
  clientPresent = true;
  constructor(private readonly options: { commerceOrders?: Record<string, unknown>[] } = {}) {}
  from = (table: string) => new RenewalCleanupQuery(this, table, this.nextQueryId++);
  rpc = async (name: string) => {
    this.operations.push({ kind: "rpc", table: name });
    if (name === "commerce_payment_method_ref_deactivate") {
      this.methodActive = false;
      return {
        data: { paymentMethodRef: { active: false, status: "inactive" } },
        error: null,
      };
    }
    return {
      data: {
        ready: !this.subscriptionPresent,
        reasons: this.subscriptionPresent ? ["legacy_frozen_baseline_mismatch"] : [],
        evidence: {
          legacyFrozenCount: this.subscriptionPresent ? 2 : 1,
          legacyFrozenInvalidCount: 0,
          legacyFrozenBaselineCount: 1,
          legacyFrozenBaselineMatches: !this.subscriptionPresent,
        },
      },
      error: null,
    };
  };

  rows(table: string, filters: Map<string, unknown>): Record<string, unknown>[] {
    const baseline = [{ expected_count: 1, captured_at: "2026-07-22T09:16:55.954Z" }];
    const baselineSubscription = {
      ...renewalEvidence().legacySubscriptions[1],
      id: "customer-baseline",
    };
    const selectedIds = filters.get("id");
    const selectedSubscriptionIds = filters.get("subscription_id");
    const filterIds = (rows: Record<string, unknown>[], column: string, selected: unknown) =>
      selected === undefined
        ? rows
        : rows.filter((row) =>
          Array.isArray(selected) ? selected.includes(row[column]) : row[column] === selected
        );
    switch (table) {
      case "commerce_offer_policy_rollout_baselines": return baseline;
      case "subscriptions": return filterIds(
        this.subscriptionPresent
          ? [baselineSubscription, {
            ...renewalEvidence().legacySubscriptions[0],
            status: this.subscriptionStatus,
          }]
          : [baselineSubscription],
        "id",
        selectedIds,
      );
      case "subscription_lines": return filterIds(
        this.linesPresent ? renewalEvidence().lines : [],
        "subscription_id",
        selectedSubscriptionIds,
      );
      case "commerce_payment_method_refs": return [{
        ...renewalEvidence().methodRefs[0],
        subscription_id: this.methodLinked ? this.targetSubscriptionId : null,
        active: this.methodActive,
        status: this.methodActive ? "active" : "inactive",
        metadata: {
          ...renewalEvidence().methodRefs[0].metadata,
          ...(this.methodActive ? {} : {
            deactivationReason: "staging_legacy_fixture_recovery",
          }),
        },
      }].filter((row) => {
        if (Array.isArray(selectedSubscriptionIds)) {
          return selectedSubscriptionIds.includes(row.subscription_id);
        }
        if (Array.isArray(selectedIds)) return selectedIds.includes(row.id);
        return true;
      });
      case "commerce_orders": return this.options.commerceOrders ?? [];
      case "clients": return filterIds(
        this.clientPresent ? [{ id: "shared-client" }, { id: "customer-client" }] : [],
        "id",
        selectedIds,
      );
      default: return [];
    }
  }

  mutate(kind: "update" | "delete") {
    if (kind === "update") this.subscriptionStatus = "paused";
    else {
      this.subscriptionPresent = false;
      this.linesPresent = false;
      this.methodLinked = false;
    }
  }
}

class RenewalCleanupQuery implements PromiseLike<{ data: unknown; error: null }> {
  private mutation: "update" | "delete" | null = null;
  private readonly filters = new Map<string, unknown>();
  constructor(
    private readonly fake: RenewalCleanupFake,
    private readonly table: string,
    private readonly queryId: number,
  ) {}
  select = (columns: string) => (
    this.fake.operations.push({ kind: "select", table: this.table, queryId: this.queryId, columns }),
    this
  );
  update = () => {
    this.mutation = "update";
    this.fake.operations.push({ kind: "update", table: this.table });
    return this;
  };
  delete = () => {
    this.mutation = "delete";
    this.fake.operations.push({ kind: "delete", table: this.table });
    return this;
  };
  eq = (column: string, value: unknown) => {
    this.fake.operations.push({ kind: "eq", table: this.table, column, value });
    this.filters.set(column, value);
    return this;
  };
  in = (column: string, value: unknown) => {
    this.fake.operations.push({ kind: "in", table: this.table, queryId: this.queryId, column, value });
    this.filters.set(column, value);
    return this;
  };
  limit = (value: number) =>
    (this.fake.operations.push({ kind: "limit", table: this.table, value }), this);
  then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const beforeMutation = this.fake.rows(this.table, this.filters);
    if (this.mutation && this.table === "subscriptions" &&
      this.filters.get("id") === this.fake.targetSubscriptionId) this.fake.mutate(this.mutation);
    const data = this.mutation === "delete"
      ? beforeMutation
      : this.fake.rows(this.table, this.filters);
    return Promise.resolve({ data, error: null }).then(onfulfilled, onrejected);
  }
}
