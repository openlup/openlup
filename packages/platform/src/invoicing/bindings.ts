import type { InvoiceServicesOptions } from "./contracts/host.js";
import type { InvoiceUnsupported } from "./contracts/provider.js";
import { createIndependentInvoiceDutyBinding } from "./continuity.js";
import { runNativeInvoiceIssueJob } from "./postgresInvoiceStore.js";
import { runInvoiceDeliveryJob } from "./delivery.js";
import { syncAcceptedInvoiceDocuments } from "./documentSync.js";
import { syncInvoicePayoutSettlements } from "./settlementSync.js";
import { createInvoiceReadModel } from "./readModel.js";
import { readInvoiceCapabilities } from "./capabilities.js";

type Operation = "issue" | "correction" | "delivery" | "documentSync" | "settlementSync" | "collectDuties" | "history";
type Ports = Pick<InvoiceServicesOptions, "host"> & Required<{
  provider: NonNullable<InvoiceServicesOptions["provider"]>;
  store: NonNullable<InvoiceServicesOptions["store"]>;
  capability: NonNullable<InvoiceServicesOptions["capability"]>;
}>;
type Refusal = InvoiceUnsupported | { readonly kind: "refused"; readonly code: "disabled" | "selection_required"; readonly retryable: false; readonly effectMayHaveSucceeded: false };
/** Host factories bind existing workers/readers, never another executor or cron. */
export interface InvoiceServices<Result = unknown> {
  readiness(): Promise<{ readonly kind: "ready" } | Refusal>;
  run(operation: Operation): Promise<Result | Refusal>;
}
/** Explicit selection and host readiness precede factory construction and claim.
 * Native jobs use the installed module helpers; transport-specific host facades
 * may supply factories. Auth, invocation scope and leases stay host-owned.
 */
export function createInvoiceServices<Result = unknown>(options: InvoiceServicesOptions & {
  readonly factories?: Partial<Record<Operation, (ports: Ports) => () => Promise<Result>>>;
  readonly jobs?: {
    readonly issue?: Omit<Parameters<typeof runNativeInvoiceIssueJob>[0], "store" | "provider" | "money" | "providerRef">;
    readonly delivery?: { readonly claimOptions: Parameters<NonNullable<InvoiceServicesOptions["store"]>["claimDeliveries"]>[0]; filename(claim: Exclude<Awaited<ReturnType<NonNullable<InvoiceServicesOptions["store"]>["claimDeliveries"]>>, InvoiceUnsupported>[number]): string };
    readonly documentSync?: Parameters<typeof syncAcceptedInvoiceDocuments>[0];
    readonly settlementSync?: Omit<Parameters<typeof syncInvoicePayoutSettlements>[0], "settlement">;
    readonly history?: Parameters<ReturnType<typeof createInvoiceReadModel>["history"]>[0];
    readonly collectDuties?: { readonly limit?: number };
  };
}): InvoiceServices<Result> {
  const { enabled, selection, capability, provider, store, host, readiness: observe } = options;
  const factories = { ...options.factories };
  const unsupported = { kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false } as const;
  const readiness: InvoiceServices<Result>["readiness"] = async () => {
    const selected = readInvoiceCapabilities({ enabled, selection, capability });
    if (selected.kind !== "ready") return selected;
    if (!provider || !store) return unsupported;
    return observe();
  };
  return {
    readiness,
    async run(operation) {
      const state = await readiness();
      if (state.kind !== "ready") return state;
      const factory = factories[operation];
      const capabilityKey = operation === "documentSync" ? "readback"
        : operation === "settlementSync" ? "settlement" : operation;
      if ((capabilityKey === "issue" || capabilityKey === "correction" || capabilityKey === "readback" || capabilityKey === "settlement")
        && !capability!.operations[capabilityKey].supported) return unsupported;
      if (factory) return factory({ provider: provider!, store: store!, capability: capability!, host })();
      const jobs = options.jobs;
      // Inputs are explicit host selections. No operation acquires a host run lease.
      if (operation === "collectDuties" && jobs?.collectDuties) return createIndependentInvoiceDutyBinding({ ...jobs.collectDuties, store: store! }).collect() as Promise<Result>;
      // The native claim batch includes issue and correction/readback duties.
      if (operation === "issue" && jobs?.issue && (!capability!.operations.correction.supported || !capability!.operations.readback.supported)) return unsupported;
      if (operation === "issue" && jobs?.issue) return runNativeInvoiceIssueJob({ ...jobs.issue, store: store!, provider: provider!, money: host.money, providerRef: selection!.providerRef }) as Promise<Result>;
      if (operation === "delivery" && jobs?.delivery) return runInvoiceDeliveryJob({
        enabled: true, providerEnabled: true, deliveryEnabled: true, store: store!, ...jobs.delivery,
        download: async claim => {
          const artifact = await host.artifacts.read({ identity: claim.identity, kind: "pdf" });
          if (artifact.kind !== "found") throw new Error("invoicing_artifact_unavailable");
          const result = await host.artifacts.download({ identity: claim.identity, artifactRef: artifact.artifact.ref });
          if (result.kind !== "downloaded") throw new Error("invoicing_artifact_unavailable");
          return result;
        }, send: input => host.delivery.send(input),
      }) as Promise<Result>;
      if (operation === "documentSync" && jobs?.documentSync) return syncAcceptedInvoiceDocuments(jobs.documentSync) as Promise<Result>;
      if (operation === "settlementSync" && jobs?.settlementSync) return syncInvoicePayoutSettlements({ ...jobs.settlementSync, settlement: host.settlement }) as Promise<Result>;
      if (operation === "history" && jobs?.history) return createInvoiceReadModel({ accountHistory: host.accountHistory }).history(jobs.history) as Promise<Result>;
      return unsupported;
    },
  };
}
