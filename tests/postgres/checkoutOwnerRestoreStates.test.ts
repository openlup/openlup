import { afterAll, aroundEach, beforeAll, it } from "vitest";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import {
  createSharedGrantArtifact,
  throwSettledErrors,
  verifyLegacyNoOp,
  verifyRestoreProfile,
  type CheckoutRestoreProfile,
  type SharedGrantArtifact,
} from "./checkoutOwnerRestoreStates.fixture.js";

const profiles: CheckoutRestoreProfile[] = ["separate", "admin-managed", "admin-operator"];

let sharedArtifact: Promise<SharedGrantArtifact>;
let pendingFixtureWork = Promise.resolve();

aroundEach(async (runTest, { signal }) => {
  // Drain the previous callback before the global beforeEach restores its spies.
  await pendingFixtureWork;
  signal.throwIfAborted();
  await runTest();
}, postgresSetupTimeoutMs);

function runFixtureWork(work: () => Promise<void>) {
  const operation = work();
  pendingFixtureWork = operation.then(() => undefined, () => undefined);
  return operation;
}

beforeAll(async () => {
  sharedArtifact = createSharedGrantArtifact();
  await sharedArtifact;
}, postgresSetupTimeoutMs);

afterAll(async () => {
  await pendingFixtureWork;
  const artifact = await sharedArtifact?.catch(() => undefined);
  await artifact?.dispose();
}, postgresSetupTimeoutMs);

for (const profile of profiles) {
  it(`restores the same nonempty checkout graph on ${profile}`, () =>
    runFixtureWork(async () => {
      const { pkg, root, manifest } = await sharedArtifact;
      await verifyRestoreProfile(profile, pkg, root, manifest);
    }), Math.max(245_000, postgresSetupTimeoutMs));
}

it("records the legacy no-op with the cluster login absent and present", () =>
  runFixtureWork(async () => {
    const { pkg } = await sharedArtifact;
    const results = await Promise.allSettled([
      verifyLegacyNoOp(pkg, "absent"),
      verifyLegacyNoOp(pkg, "present"),
    ]);
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length > 0) throwSettledErrors(errors, "Legacy no-op verification failed in both states");
  }), Math.max(245_000, postgresSetupTimeoutMs));
