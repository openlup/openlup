import { aroundEach, it } from "vitest";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import {
  verifyRestrictedConnectedRestore,
  verifyRestrictedControlPlaneAdmission,
} from "./m14RestrictedConnectedRestore.fixture.js";

const shape = "rds" as const;
const mode = "installer-managed" as const;
const activeSerialFixtures = new Set<Promise<void>>();

aroundEach(async (runTest, { signal }) => {
  // Vitest can time out the case without cancelling its database work.
  await Promise.all(activeSerialFixtures);
  signal.throwIfAborted();
  await runTest();
}, postgresSetupTimeoutMs);

function trackFixture(work: () => Promise<void>) {
  const result = work();
  const drained = result.then(() => undefined, () => undefined);
  activeSerialFixtures.add(drained);
  void drained.then(() => activeSerialFixtures.delete(drained));
  return result;
}

function restoreTest(name: string, work: () => Promise<void>, timeout: number) {
  it(name, () => trackFixture(work), timeout);
}

restoreTest(`admits ${shape}-shaped ${mode} control-plane roles before installation`, () =>
  verifyRestrictedControlPlaneAdmission(shape, mode), postgresSetupTimeoutMs);

// About 4x the slowest hosted run (60,506 ms), rounded up to 5 s.
restoreTest(`restores a connected native graph through ${shape}-shaped ${mode} admission`, () =>
  verifyRestrictedConnectedRestore(shape, mode), 245_000);
