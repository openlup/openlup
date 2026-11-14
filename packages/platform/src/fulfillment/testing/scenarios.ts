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
  /** Optional compatibility assertion; the runner derives the profile and checks the captured brand. */
  profile?: "adapter" | "dispatch-only";
  /** A transportless captured adapter qualifies only its dispatch profile. */
  dispatch?: {
    /** Valid items and a blank required address field; preparation must refuse without provider I/O. */
    addressBeforeSubmission: number;
    addressAfterSubmission: number;
    transport: Record<FulfillmentTransportScenario, {
      fixture: number;
      /** Authenticated read-only snapshot from the scripted fake; private log deltas prove the invocation. */
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
  /** The runner executes the real worker with its own isolated snapshot-only provider and store. */
  snapshotOnly?: true;
  dispatchRefusal?: { input: Parameters<FulfillmentAdapterConformanceSubject["adapter"]["dispatch"]["dispatch"]>; expected: Awaited<ReturnType<FulfillmentAdapterConformanceSubject["adapter"]["dispatch"]["dispatch"]>> };

}

/** Baseline callers need no certification fixtures. Full mode requires every applicable witness. */
export type FulfillmentAdapterTestSubject = FulfillmentAdapterConformanceSubject & {
  adapter: FulfillmentAdapterConformanceSubject["adapter"] & { reconciliation?: FulfillmentObservationPagePort };
  certification?: FulfillmentAdapterCertificationScenarios;
};
export interface FulfillmentConformanceOptions { mode: "baseline" | "full" }

/** Sanitized invocation evidence; values and inputs remain private to the runner. */
export interface FulfillmentQualification {
  subjectId: string;
  profile: "adapter" | "dispatch-only";
  capabilityDigest: string;
  ledger: readonly { capability: string; role: "success" | "failure" | "refusal" | "neutral"; slotId: string; ioDelta: number; faultLogDelta: readonly { kind: string }[] }[];
  declarations: readonly { capability: "courierPickup"; declared: "unsupported"; probe: "no_port" }[];
}
