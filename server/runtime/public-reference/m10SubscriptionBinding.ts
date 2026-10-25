import { createPostgresRenewalStore, createPostgresRetryLifecycleBinding, createPostgresStockWaitStore,
  createSubscriptionServices, correlatedLogicalCycle, NATIVE_SUBSCRIPTION_CAPABILITIES, runOneAutomaticSubscriptionRenewal, runRenewalBatchRows } from "@openlup/platform/subscriptions";
import type { AutomaticRenewalRunDeps, AutomaticRenewalRunResult, NativeRenewalCodec, SubscriptionQueryExecutor } from "@openlup/platform/subscriptions";
import type { RenewalDue, RenewalFrozenSnapshot, RenewalSettlementPort, SubscriptionCapabilities } from "@openlup/platform/subscriptions/contracts";
import { createSubscriptionContribution } from "@openlup/platform/composition";
import type { ReadinessReport, RequiredSchema } from "@openlup/core/readiness";
import { withDeliveryAlignmentRenewalAdmission } from "../subscription/deliveryAlignmentRenewalStore.js";
import { createM10RetryDriver, type M10RetryDriverOptions } from "./m10RetryDriver.js";
import { m10SubscriptionSchema } from "./m10SubscriptionSchema.js";

/** Explicit native reference selection. The served managed graph is unchanged. */
export function createM10SubscriptionReferenceBinding(input: {
  enabled?: boolean;
  population: string;
  executor: SubscriptionQueryExecutor;
  withTransaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
  /** Shared durable host lease, also used by any incumbent writer for this population. */
  withRunLease<T>(population: string, work: () => Promise<T>): Promise<T | null>;
  codec: NativeRenewalCodec;
  settlement(db: SubscriptionQueryExecutor): RenewalSettlementPort;
  inventory: AutomaticRenewalRunDeps["inventory"];
  paymentRails: AutomaticRenewalRunDeps["paymentRails"];
  policy: AutomaticRenewalRunDeps["policy"];
  retry: Pick<M10RetryDriverOptions, "readFrozenMandate" | "retryInput" | "payments" | "recoveredTemplate">;
  failureTemplate: string; recoveryPath: string | null;
  workerId: string;
  now(): string;
  version: string;
  catalogue: { version: string; migration: string };
  readiness(schema: RequiredSchema): Promise<ReadinessReport>;
  cadenceSeconds: number;
}) {
  if (!input.population.trim()) throw new Error("subscription_population_required");
  const schema = m10SubscriptionSchema(input.catalogue);
  const native = createPostgresRenewalStore(input.executor, input.codec);
  const store = withDeliveryAlignmentRenewalAdmission({ ...native,
    async buildCycleSnapshots(schedule) {
      const snapshot = await native.buildCycleSnapshots(schedule);
      correlatedLogicalCycle(snapshot); // Refuse ambiguous history before prepare or provider execution.
      return snapshot;
    },
  }, input.executor, input.now);
  const stock = createPostgresStockWaitStore({ ...input, codec: input.codec });
  const lifecycle = createPostgresRetryLifecycleBinding({ ...input,
    correlate: (wire) => input.codec.decode(wire).cycle,
  });
  const retry = createM10RetryDriver({ ...input, ...input.retry,
    decode: input.codec.decode, validateInput: input.policy.validateInput, classifyFailure: input.policy.classifyFailure,
  });
  const capabilities: SubscriptionCapabilities = Object.freeze({ ...NATIVE_SUBSCRIPTION_CAPABILITIES, stockRecovery: "selected" });
  const deps: AutomaticRenewalRunDeps = { store, settlement: lifecycle.settlement,
    failureHandoff: lifecycle.failureHandoff, paymentRails: input.paymentRails, policy: input.policy,
    workerId: input.workerId, now: input.now,
    inventory: { expireReservations: input.inventory.expireReservations,
      async reserve(request) {
        const raw = (await input.executor.query("SELECT identity_key FROM public.subscription_renewal_operations WHERE id=$1::uuid", [request.operationId])).rows[0];
        const operation = raw && await store.readRenewal(String(raw.identity_key));
        if (!operation) throw new Error("subscription_renewal_missing");
        const result = await stock.admit({ ...request, snapshot: operation.cycleSnapshot });
        return { reserved: !result.waiting, replayed: result.response.replayed === true,
          reservationId: result.response.reservationId == null ? null : String(result.response.reservationId),
          status: result.waiting ? "refused" : "held", reason: result.waiting ? "inventory_unavailable" : null };
      },
    },
  };
  function due(snapshot: RenewalFrozenSnapshot): RenewalDue {
    return { ...snapshot, cadenceDays: snapshot.templateSnapshot.cadenceDays, currency: snapshot.pricingSnapshot.currency,
      deliveryAdmission: "allowed", deliveryBlockReason: null };
  }
  const services = createSubscriptionServices({ enabled: input.enabled, capabilities,
    async readiness() {
      const report = await input.readiness(schema);
      return report.state === "ready" ? { kind: "ready" } : { kind: "refused", code: `schema_${report.state}` };
    },
    async run() {
      return input.withRunLease(input.population, async () => {
        const now = input.now(), limit = 50;
        await deps.inventory.expireReservations({ now, limit: 100 });
        const retries = await retry.run(now, limit);
        const renewals: AutomaticRenewalRunResult[] = [];
        const seen = new Set<string>();
        for (const candidate of await stock.listCandidates({ limit, asOf: now })) {
          seen.add(candidate.subscriptionId);
          const snapshot = candidate.frozenSnapshot;
          renewals.push(...await runRenewalBatchRows([due(snapshot)], async () => {
            correlatedLogicalCycle(snapshot);
            const operation = await store.readRenewal(input.codec.identity(snapshot));
            if (!operation) throw new Error("stock_wait_operation_missing");
            // Static admission and G23 precede stock reacquisition too.
            const admission = await store.admitDeliveryAlignment({ ...snapshot, occurredAt: now });
            if (!admission.allowed) {
              return { subscriptionId: snapshot.subscriptionId, operationId: operation.operationId, identityKey: operation.identityKey, replayed: false, status: "deferred", reason: admission.reason };
            }
            const admissionResult = await stock.admit({ operationId: operation.operationId, claimToken: operation.claimToken,
              snapshot, recovery: candidate.binding, now });
            if (admissionResult.waiting) {
              return { subscriptionId: snapshot.subscriptionId, operationId: operation.operationId, identityKey: operation.identityKey, replayed: false, status: "deferred", reason: "inventory_unavailable" };
            }
            const claimed = input.codec.readback(admissionResult.response);
            if (!claimed.acquired) return { subscriptionId: snapshot.subscriptionId, operationId: claimed.operationId, identityKey: claimed.identityKey, replayed: claimed.replayed, status: "lease_active", reason: claimed.reason };
            // N3 already acquired this exact generation. Do not acquire a second lease.
            return runOneAutomaticSubscriptionRenewal({ ...deps, store: { ...store,
              claimDue: async () => claimed,
            } }, due(snapshot), now);
          }, deps.policy));
        }
        const normalDue = (await stock.listNormalDue({ limit, asOf: now })).filter(row => !seen.has(row.subscriptionId));
        renewals.push(...await runRenewalBatchRows(normalDue, row => runOneAutomaticSubscriptionRenewal(deps, row, now), deps.policy));
        return { retries, renewals };
      });
    },
  });
  const contribution = createSubscriptionContribution({ version: input.version, requiredSchema: schema,
    run: input.enabled === true ? services.run : null, cadenceSeconds: input.cadenceSeconds,
  });
  return { services, ...contribution, schema,
    /** Called only after the host's actual paid-realization admission, never on stock arrival alone. */
    async realizationAdmitted(orderId: string) {
      const state = await services.readiness();
      return state.kind === "ready" ? stock.markResumed(orderId) : state;
    },
  };
}
