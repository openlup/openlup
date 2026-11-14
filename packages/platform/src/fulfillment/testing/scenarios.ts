import type { FulfillmentAdapterConformanceSubject, FulfillmentObservationPagePort, FulfillmentProductSyncProvider, FulfillmentRefusal, FulfillmentStockSyncProvider } from "../contracts/index.js";
import type { ScriptedFulfillmentOutcome } from "./scriptedFake.js";

type MethodFixture<M extends (...args: never[]) => unknown> = {
  input: Parameters<M>;
} & ({ expected: Awaited<ReturnType<M>> } | { throws: FulfillmentRefusal });
type SyncFixtures<P> = { [K in keyof P]: P[K] extends (...args: never[]) => unknown
  ? { operation: K; success: MethodFixture<P[K]>; failure: MethodFixture<P[K]> } : never }[keyof P];
export type FulfillmentTransportScenario = "transport-before-submission" | "transport-after-submission" | "http-failure";

/** Indices refer to independently expected baseline fixtures, executed by the existing runner. */
export interface FulfillmentAdapterCertificationScenarios {
  profile: "adapter" | "dispatch-only";
  /** A transportless captured adapter qualifies only its dispatch profile. */
  dispatch?: {
    addressBeforeSubmission: number;
    addressAfterSubmission: number;
    transport: Record<FulfillmentTransportScenario, {
      fixture: number;
      /** Log from the injected fake; scripts describe faults, adapter results prove uncertainty. */
      calls: readonly { kind: ScriptedFulfillmentOutcome<unknown>["kind"] }[];
    }>;
  };
  observation?: { duplicate: readonly [number, number]; outOfOrder: readonly [number, number]; authenticationFailure: number };
  /** Coarse exceptions only; no automatic loss detection or replacement is certified. */
  exceptions?: { returned: number; lostCoarse: number };
  paging?: Record<"full" | "short" | "empty" | "exhausted" | "failure", {
    input: Parameters<FulfillmentObservationPagePort["readPage"]>[0];
    expected: Awaited<ReturnType<FulfillmentObservationPagePort["readPage"]>>;
  }>;
  stockSync?: readonly SyncFixtures<FulfillmentStockSyncProvider>[];
  productSync?: readonly SyncFixtures<FulfillmentProductSyncProvider>[];
  /** Invoke the real snapshot-only worker and return its movementRefusal.
   * Count movement calls only: snapshot requests are allowed. This is a native
   * declaration probe, not adapter or durable host certification. */
  snapshotOnly?: { invoke(): Promise<FulfillmentRefusal | undefined>; readMovementCalls(): number };
}

/** Baseline callers need no certification fixtures. Full mode requires every applicable witness. */
export type FulfillmentAdapterTestSubject = FulfillmentAdapterConformanceSubject & {
  adapter: FulfillmentAdapterConformanceSubject["adapter"] & { reconciliation?: FulfillmentObservationPagePort };
  certification?: FulfillmentAdapterCertificationScenarios;
};
export interface FulfillmentConformanceOptions { mode: "baseline" | "full" }
