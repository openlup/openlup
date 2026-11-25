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

it("restores the same nonempty checkout graph on bootstrap from absent and granted states", () =>
  runFixtureWork(() =>
    withGrantArtifact((pkg, root, manifest) =>
      verifyRestoreProfile("bootstrap", pkg, root, manifest, {
        fromStates: ["absent", "granted"],
        verifyLater: false,
        labelSuffix: "absent-granted",
      }),
    ),
  ), Math.max(360_000, postgresSetupTimeoutMs));
