import { describe, expect, it } from "vitest";

import {
  mapProfile,
  subscriptionActionPayload,
} from "./customerSelfServiceClientModels.js";

describe("customer self-service client models", () => {
  it("maps nullable profile fields without leaking non-string values", () => {
    expect(mapProfile({
      id: "client-1",
      email: "dog@example.com",
      first_name: "Ada",
      last_name: null,
      phone: 123,
      lifecycle_stage: "tester",
    })).toEqual({
      clientId: "client-1",
      email: "dog@example.com",
      firstName: "Ada",
      lastName: null,
      phone: null,
      lifecycleStage: "tester",
    });
  });

  it("strips transport fields from subscription action payloads", () => {
    expect(subscriptionActionPayload({
      action: "pause",
      idempotencyKey: "idem-1",
      protocolSourceAction: "pause_subscription",
      subscriptionId: "sub-1",
      reason: "travel",
    } as never)).toEqual({ reason: "travel" });
  });
});
