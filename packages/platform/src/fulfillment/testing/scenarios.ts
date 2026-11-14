import type { FulfillmentAdapterConformanceSubject, FulfillmentObservationPagePort, FulfillmentProductSyncProvider, FulfillmentRefusal, FulfillmentStockSyncProvider } from "../contracts/index.js";
import type { ScriptedFulfillmentOutcome } from "./scriptedFake.js";

type PositiveResult<T> = T extends null ? never : T extends { replayed: boolean } ? T & { replayed: false } : T;
type SuccessFixture<M extends (...args: never[]) => unknown> = {
  input: Parameters<M>; expected: PositiveResult<Awaited<ReturnType<M>>>; throws?: never;
};
type FailureFixture<M extends (...args: never[]) => unknown> = {
  input: Parameters<M>; throws: FulfillmentRefusal; expected?: never;
};
type SyncFixtures<P> = { [K in keyof P]: P[K] extends (...args: never[]) => unknown
  ? { operation: K; success: SuccessFixture<P[K]>; failure: FailureFixture<P[K]> } : never }[keyof P];
export type FulfillmentTransportScenario = "transport-before-submission" | "transport-after-submission" | "http-failure";

/** Indices refer to independently expected baseline fixtures. Status pairs also execute explicitly in tuple order. */
export interface FulfillmentAdapterCertificationScenarios {
  profile: "adapter" | "dispatch-only";
  /** A transportless captured adapter qualifies only its dispatch profile. */
  dispatch?: {
    /** Valid items and a blank required address field; preparation must refuse without provider I/O. */
    addressBeforeSubmission: number;
    addressAfterSubmission: number;
    transport: Record<FulfillmentTransportScenario, {
      fixture: number;
      /** Live append-only log from the injected fake. Only entries appended during this indexed dispatch count. */
      calls: readonly { kind: ScriptedFulfillmentOutcome<unknown>["kind"] }[];
    }>;
  };
  /** Duplicate inputs must match; outOfOrder is [newer, older] for the same shipment. */
  observation?: { duplicate: readonly [number, number]; outOfOrder: readonly [number, number]; authenticationFailure: number };
  /** Coarse exceptions only; no automatic loss detection or replacement is certified. */
  exceptions?: { returned: number; lostCoarse: number };
  paging?: { [Role in "full" | "short" | "empty" | "exhausted" | "failure"]: {
    input: Parameters<FulfillmentObservationPagePort["readPage"]>[0];
    expected: Extract<Awaited<ReturnType<FulfillmentObservationPagePort["readPage"]>>, { kind: Role extends "exhausted" ? "page_exhausted" : Role extends "failure" ? "failed" : "page" }>;
  } };
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
