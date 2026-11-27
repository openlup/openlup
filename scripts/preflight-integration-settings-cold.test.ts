import { afterAll, beforeAll, describe, it } from "vitest";

import { createPreflightIntegrationFixture, verifyStaleSettingsRepair } from "./fixtures/preflight-integration-fixture.ts";

describe("real fast preflight (settings catalogue, cold cache)", () => {
  const fixture = createPreflightIntegrationFixture();

  beforeAll(() => fixture.setup(), 180000);
  afterAll(() => fixture.teardown());

  it("refuses stale settings with a cold cache, then accepts the owner's repair", () => {
    verifyStaleSettingsRepair(fixture, "cold", false);
  }, 300000);
});
