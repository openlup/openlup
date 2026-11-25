import { afterAll, aroundEach, it } from "vitest";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { verifyRestoreProfile, withGrantArtifact } from "./checkoutOwnerRestoreStates.fixture.js";

let pendingFixtureWork = Promise.resolve();

aroundEach(async (runTest, { signal }) => {
  // Drain the previous callback before the global beforeEach restores its spies.
  await pendingFixtureWork;
  signal.throwIfAborted();
  await runTest();
}, postgresSetupTimeoutMs);

afterAll(async () => {
  await pendingFixtureWork;
}, postgresSetupTimeoutMs);

function runFixtureWork(work: () => Promise<void>) {
  const operation = work();
  pendingFixtureWork = operation.then(() => undefined, () => undefined);
  return operation;
}

it("restores the same nonempty checkout graph on bootstrap from dormant state and verifies later definition", () =>
  runFixtureWork(() =>
    withGrantArtifact((pkg, root, manifest) =>
      verifyRestoreProfile("bootstrap", pkg, root, manifest, {
        fromStates: ["dormant"],
        verifyLater: true,
        labelSuffix: "dormant",
      }),
    ),
  ), Math.max(300_000, postgresSetupTimeoutMs));
